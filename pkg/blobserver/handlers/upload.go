/*
Copyright 2011 The Perkeep Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"path"
	"strings"

	"perkeep.org/internal/httputil"
	"perkeep.org/pkg/accounts"
	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/blobserver"
	"perkeep.org/pkg/blobserver/protocol"
	"perkeep.org/pkg/blobserver/uploadsession"
	"perkeep.org/pkg/jsonsign/signhandler"
	"perkeep.org/pkg/schema"
)

// IdentifyFunc resolves the authenticated caller's username from an
// upload request, or ok=false if none/invalid. A nil IdentifyFunc (the
// value this package's callers get when no "accounts" handler is
// configured) makes ownership stamping and the reserved-attribute guard
// complete no-ops -- legacy single-tenant behavior, unchanged. Supplied by
// pkg/serverinit, built from accounts.BearerFromRequest +
// accounts.Store.VerifyBearer.
type IdentifyFunc func(req *http.Request) (username string, ok bool)

// StampFunc records that permanode pn was created by username, called
// synchronously, once, right after pn is durably received -- never from a
// client-settable claim. Supplied by pkg/serverinit, built from
// accounts.Store.StampOwnership. See docs/multi-tenant-roadmap.md's Phase 2
// section for why this can't be a normal attribute claim.
type StampFunc func(ctx context.Context, pn blob.Ref, username string) error

// ReservedAttrFunc reports whether attr is a reserved, server-only
// attribute (the per-user ownership attribute) that no client-submitted
// claim may ever set directly. Supplied by pkg/serverinit.
type ReservedAttrFunc func(attr string) bool

// ClaimTargetFunc reports whether req's authenticated caller may submit
// an attribute claim targeting permaNode -- the general ownership check
// that stops any authenticated user from tampering with another user's
// permanode via a claim on some attribute OTHER than the reserved
// ownership one (see ReservedAttrFunc, which only ever covers that one
// attribute name). True when permaNode doesn't exist yet (it's being
// created in this same upload, alongside its own initial attribute
// claims -- the normal create flow), the caller owns it, or the caller
// is admin; false otherwise, including when permaNode exists but isn't
// owned by anyone (accounts infrastructure, or legacy content that
// predates Phase 2's ownership backfill). Supplied by pkg/serverinit,
// built from accounts.Store.ResolveRequest + accounts.Store.
// PermanodeOwnership. nil when no "accounts" handler is configured,
// making this a complete no-op -- legacy single-tenant behavior,
// unchanged.
type ClaimTargetFunc func(req *http.Request, permaNode blob.Ref) bool

// VerifiedFunc reports whether req's authenticated caller may perform any
// blob-storage mutation at all (new permanodes, chunk uploads, attribute
// claims) -- the Phase 4 gate for self-signup accounts that haven't
// verified their email yet (docs/multi-tenant-roadmap.md's Phase 4
// section). Checked once per request, before classification, so an
// unverified caller's upload is rejected outright rather than partially
// processed. Supplied by pkg/serverinit, built from accounts.Store.
// ResolveRequest; nil when no "accounts" handler is configured, making
// this a complete no-op -- legacy single-tenant behavior, unchanged.
type VerifiedFunc func(req *http.Request) bool

// classifyUpload inspects a blob's bytes -- already fully read, before
// they're ever handed to storage -- to decide what the generic upload path
// needs to do with it: isPermanode means a brand-new permanode that, once
// durably received, needs StampFunc called on it with the uploader's
// identity; a non-empty rejectReason means it's a claim that must be
// rejected outright, before it's ever stored -- either a well-formed
// attempt to set the reserved ownership attribute directly (via a plain
// attribute claim or a multi-claim bundling one), or an attribute claim
// (any attribute) targeting a permanode the caller isn't authorized to
// modify (see ClaimTargetFunc). Non-schema blobs (raw file chunks, etc.)
// and schema blobs of other types return false/"" -- nothing to do.
func classifyUpload(req *http.Request, ref blob.Ref, data []byte, isReservedAttr ReservedAttrFunc, mayClaim ClaimTargetFunc) (isPermanode bool, rejectReason string) {
	b, err := schema.BlobFromReader(ref, bytes.NewReader(data))
	if err != nil {
		return false, ""
	}
	switch b.Type() {
	case schema.TypePermanode:
		return true, ""
	case schema.TypeClaim:
		if isReservedAttr == nil && mayClaim == nil {
			return false, ""
		}
		c, ok := b.AsClaim()
		if !ok {
			return false, ""
		}
		attrClaims, err := c.AttributeClaims()
		if err != nil {
			// Malformed claim -- let the normal receive/index path surface
			// this; this guard only cares about well-formed attempts to set
			// the reserved attribute or write to an unauthorized target.
			return false, ""
		}
		for _, ac := range attrClaims {
			if isReservedAttr != nil && isReservedAttr(ac.Attribute) {
				return false, fmt.Sprintf("cannot set reserved attribute %q directly", ac.Attribute)
			}
			if mayClaim != nil && !mayClaim(req, ac.Permanode) {
				return false, fmt.Sprintf("not authorized to modify permanode %v", ac.Permanode)
			}
		}
	}
	return false, ""
}

// stampNewPermanode calls stamp on ref if it's a newly-received permanode
// (per permanodeRefs) and an uploader identity was resolved, returning
// false (and appending to addError) if the hook is applicable but fails --
// callers must then remove ref from whatever "succeeded" list they were
// about to add it to, rather than report success for a silently-unowned
// permanode.
func stampNewPermanode(ctx context.Context, ref blob.Ref, permanodeRefs map[blob.Ref]bool, stamp StampFunc, uploader string, hasUploader bool, addError func(string)) bool {
	if !permanodeRefs[ref] || stamp == nil {
		return true
	}
	if !hasUploader {
		// Reachable only if accounts is configured but this specific
		// request's bearer token didn't re-verify here even though
		// auth.RequireAuth already accepted it upstream -- fail the blob
		// rather than silently leave it unowned.
		addError(fmt.Sprintf("could not resolve uploader identity to record ownership of %v", ref))
		return false
	}
	if err := stamp(ctx, ref, uploader); err != nil {
		log.Printf("accounts: failed to stamp ownership on new permanode %v for %q: %v", ref, uploader, err)
		addError(fmt.Sprintf("could not record ownership of %v: %v", ref, err))
		return false
	}
	return true
}

// CreateBatchUploadHandler returns the handler that receives multi-part form uploads
// to upload many blobs at once. See doc/protocol/blob-upload.md.
//
// An upload with a "session" query parameter adds its blobs to that
// upload session, from sessions, rather than receiving them into storage. See
// doc/protocol/blob-upload-session.md.
//
// identify/stamp/isReservedAttr/mayClaim/verified are nil when no
// "accounts" handler is configured -- see IdentifyFunc's doc for why
// that's a complete no-op.
func CreateBatchUploadHandler(storage blobserver.BlobReceiveConfiger, sessions *uploadsession.Manager, identify IdentifyFunc, stamp StampFunc, isReservedAttr ReservedAttrFunc, mayClaim ClaimTargetFunc, verified VerifiedFunc) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		handleMultiPartUpload(rw, req, storage, sessions, identify, stamp, isReservedAttr, mayClaim, verified)
	})
}

// CreatePutUploadHandler returns the handler that receives a single
// blob at the blob's final URL, via the PUT method.  See
// doc/protocol/blob-upload-protocol.txt.
//
// identify/stamp/isReservedAttr/mayClaim/verified are nil when no
// "accounts" handler is configured -- see IdentifyFunc's doc for why
// that's a complete no-op.
func CreatePutUploadHandler(storage blobserver.BlobReceiver, identify IdentifyFunc, stamp StampFunc, isReservedAttr ReservedAttrFunc, mayClaim ClaimTargetFunc, verified VerifiedFunc) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		if req.Method != "PUT" {
			log.Printf("Inconfigured upload handler.")
			httputil.BadRequestError(rw, "Inconfigured handler.")
			return
		}
		if verified != nil && !verified(req) {
			http.Error(rw, accounts.NotVerifiedMessage, http.StatusForbidden)
			return
		}
		blobrefStr := path.Base(req.URL.Path)
		br, ok := blob.Parse(blobrefStr)
		if !ok {
			log.Printf("Invalid PUT request to %q", req.URL.Path)
			httputil.BadRequestError(rw, "Bad path")
			return
		}
		if !br.IsSupported() {
			httputil.BadRequestError(rw, "unsupported object hash function")
			return
		}
		// Read fully into memory before storing (same bound and the same
		// convention handleMultiPartUpload already uses for every blob it
		// receives) so a claim attempting to set the reserved ownership
		// attribute can be rejected outright, before it's ever durable --
		// rejecting only the HTTP response after the fact wouldn't be
		// enough, since the blob would already be stored and eventually
		// indexed regardless.
		const tooBig = blobserver.MaxBlobSize + 1
		data, err := io.ReadAll(io.LimitReader(req.Body, tooBig))
		if err == nil && len(data) == tooBig {
			httputil.BadRequestError(rw, "blob too big")
			return
		}
		if err != nil {
			httputil.ServeError(rw, req, err)
			return
		}
		isPermanode, rejectReason := classifyUpload(req, br, data, isReservedAttr, mayClaim)
		if rejectReason != "" {
			httputil.BadRequestError(rw, "%s", rejectReason)
			return
		}
		_, err = blobserver.Receive(ctx, storage, br, bytes.NewReader(data))
		if errors.Is(err, blobserver.ErrCorruptBlob) {
			httputil.BadRequestError(rw, "data doesn't match declared digest")
			return
		}
		if err != nil {
			httputil.ServeError(rw, req, err)
			return
		}
		if isPermanode && stamp != nil {
			var uploader string
			var hasUploader bool
			if identify != nil {
				uploader, hasUploader = identify(req)
			}
			permanodeRefs := map[blob.Ref]bool{br: true}
			if !stampNewPermanode(ctx, br, permanodeRefs, stamp, uploader, hasUploader, func(msg string) {
				log.Printf("accounts: %s", msg)
			}) {
				httputil.ServeError(rw, req, fmt.Errorf("could not record ownership of %v", br))
				return
			}
		}
		rw.WriteHeader(http.StatusNoContent)
	})
}

// vivify verifies that all the chunks for the file described by fileblob are on the blobserver.
// It makes a planned permanode, signs it, and uploads it. It finally makes a camliContent claim
// on that permanode for fileblob, signs it, and uploads it to the blobserver.
//
// vivify always creates exactly one permanode itself (never from a
// client-submitted claim), so unlike handleMultiPartUpload/
// CreatePutUploadHandler it needs no classification -- stamp (nil if no
// "accounts" handler is configured) is simply called on the new permanode,
// using uploader/hasUploader resolved once by the caller, right after it's
// durably received and before the camliContent claim that would otherwise
// make it look fully set up while still unowned.
func vivify(ctx context.Context, blobReceiver blobserver.BlobReceiveConfiger, fileblob blob.SizedRef, stamp StampFunc, uploader string, hasUploader bool) error {
	sf, ok := blobReceiver.(blob.Fetcher)
	if !ok {
		return fmt.Errorf("BlobReceiver is not a Fetcher")
	}
	fr, err := schema.NewFileReader(ctx, sf, fileblob.Ref)
	if err != nil {
		return fmt.Errorf("Filereader error for blobref %v: %w", fileblob.Ref.String(), err)
	}
	defer fr.Close()

	h := blob.NewHash()
	n, err := io.Copy(h, fr)
	if err != nil {
		return fmt.Errorf("Could not read all file of blobref %v: %w", fileblob.Ref.String(), err)
	}
	if n != fr.Size() {
		return fmt.Errorf("Could not read all file of blobref %v. Wanted %v, got %v", fileblob.Ref.String(), fr.Size(), n)
	}

	config := blobReceiver.Config()
	if config == nil {
		return errors.New("blobReceiver has no config")
	}
	hf := config.HandlerFinder
	if hf == nil {
		return errors.New("blobReceiver config has no HandlerFinder")
	}
	JSONSignRoot, sh, err := hf.FindHandlerByType("jsonsign")
	if err != nil || sh == nil {
		return errors.New("jsonsign handler not found")
	}
	sigHelper, ok := sh.(*signhandler.Handler)
	if !ok {
		return errors.New("handler is not a JSON signhandler")
	}
	publicKeyBlobRef := sigHelper.Discovery(JSONSignRoot).PublicKeyBlobRef
	if !publicKeyBlobRef.Valid() {
		return fmt.Errorf("invalid publicKeyBlobRef %v in sign discovery", publicKeyBlobRef)
	}

	// The file schema must have a modtime to vivify, as the modtime is used for all three of:
	// 1) the permanode's signature
	// 2) the camliContent attribute claim's "claimDate"
	// 3) the signature time of 2)
	claimDate := fr.UnixMtime()
	if claimDate.IsZero() {
		return fmt.Errorf("While parsing modtime for file %v: %w", fr.FileName(), err)
	}

	permanodeBB := schema.NewHashPlannedPermanode(h)
	permanodeBB.SetSigner(publicKeyBlobRef)
	permanodeBB.SetClaimDate(claimDate)
	permanodeSigned, err := sigHelper.Sign(ctx, permanodeBB)
	if err != nil {
		return fmt.Errorf("signing permanode %v: %w", permanodeSigned, err)
	}
	permanodeRef := blob.RefFromString(permanodeSigned)
	_, err = blobserver.ReceiveNoHash(ctx, blobReceiver, permanodeRef, strings.NewReader(permanodeSigned))
	if err != nil {
		return fmt.Errorf("while uploading signed permanode %v, %v: %w", permanodeRef, permanodeSigned, err)
	}

	if stamp != nil {
		if !hasUploader {
			return fmt.Errorf("could not resolve uploader identity to record ownership of %v", permanodeRef)
		}
		if err := stamp(ctx, permanodeRef, uploader); err != nil {
			return fmt.Errorf("could not record ownership of %v for %q: %w", permanodeRef, uploader, err)
		}
	}

	contentClaimBB := schema.NewSetAttributeClaim(permanodeRef, "camliContent", fileblob.Ref.String())
	contentClaimBB.SetSigner(publicKeyBlobRef)
	contentClaimBB.SetClaimDate(claimDate)
	contentClaimSigned, err := sigHelper.Sign(ctx, contentClaimBB)
	if err != nil {
		return fmt.Errorf("signing camliContent claim: %w", err)
	}
	contentClaimRef := blob.RefFromString(contentClaimSigned)
	_, err = blobserver.ReceiveNoHash(ctx, blobReceiver, contentClaimRef, strings.NewReader(contentClaimSigned))
	if err != nil {
		return fmt.Errorf("while uploading signed camliContent claim %v, %v: %w", contentClaimRef, contentClaimSigned, err)
	}
	return nil
}

// The multipart upload handler receives blobs in groups of up to
// uploadGroupBlobs blobs, or of about uploadGroupBytes bytes, whichever is
// reached first.
const (
	uploadGroupBlobs = 256
	uploadGroupBytes = 32 << 20
)

func handleMultiPartUpload(rw http.ResponseWriter, req *http.Request, blobReceiver blobserver.BlobReceiveConfiger, sessions *uploadsession.Manager, identify IdentifyFunc, stamp StampFunc, isReservedAttr ReservedAttrFunc, mayClaim ClaimTargetFunc, verified VerifiedFunc) {
	ctx := req.Context()
	res := new(protocol.UploadResponse)

	// Checked once per request, before any blob is read, for the same
	// reason identify is resolved once below rather than per blob --
	// rejecting the whole batch outright is simpler and cheaper than
	// letting some blobs through and rejecting others mid-batch.
	if verified != nil && !verified(req) {
		http.Error(rw, accounts.NotVerifiedMessage, http.StatusForbidden)
		return
	}

	// Resolved once per request, not per blob: StampFunc only ever needs
	// the uploader's username, and re-verifying the bearer token (identify)
	// is exactly as valid on blob 50 of a batch as on blob 1.
	var uploader string
	var hasUploader bool
	if identify != nil {
		uploader, hasUploader = identify(req)
	}

	if !(req.Method == "POST" && strings.Contains(req.URL.Path, "/camli/upload")) {
		log.Printf("Inconfigured handler upload handler")
		httputil.BadRequestError(rw, "Inconfigured handler.")
		return
	}

	vivifying := req.Header.Get("X-Camlistore-Vivify") == "1"
	var session *uploadsession.Session
	if id := req.URL.Query().Get("session"); id != "" {
		if vivifying {
			// Vivifying a file needs its blobs in storage already.
			httputil.BadRequestError(rw, "Can't vivify in an upload session.")
			return
		}
		var err error
		if sessions != nil {
			session, err = sessions.Session(id)
		} else {
			err = uploadsession.ErrUnknownSession
		}
		if err != nil {
			serveSessionError(rw, req, err)
			return
		}
	}

	var receivedBlobs []blob.SizedRef

	multipart, err := req.MultipartReader()
	if multipart == nil {
		httputil.BadRequestError(rw, "Expected multipart/form-data POST request; %v", err)
		return
	}

	var errBuf bytes.Buffer
	addError := func(s string) {
		log.Printf("Client error: %s", s)
		if errBuf.Len() > 0 {
			errBuf.WriteByte('\n')
		}
		errBuf.WriteString(s)
	}

	// permanodeRefs records which blobs in this request classified as
	// brand-new permanodes (set during the read loop below, before each
	// one is ever added to group) -- receiveGroup consults it, after a
	// permanode is confirmed received/accepted, to decide whether to call
	// stamp on it.
	permanodeRefs := make(map[blob.Ref]bool)

	// Read the blobs into memory, and receive them in groups, so storage
	// can share work (like syncs to disk) among a group's blobs. In a
	// session, add each to the session as it's read instead, for the
	// session's limits to count it.
	var group []*blob.Blob
	var groupBytes int
	receiveGroup := func() {
		if len(group) == 0 {
			return
		}
		if session != nil {
			err := session.Add(ctx, group)
			if _, ok := errors.AsType[*blobserver.BlobsError](err); err != nil && !ok {
				addError(fmt.Sprintf("Error adding %d blobs to the session: %v\n", len(group), err))
			} else {
				for _, b := range group {
					if err := blobserver.BlobErr(err, b.Ref()); err != nil {
						addError(fmt.Sprintf("Error adding blob %v to the session: %v\n", b.Ref(), err))
						continue
					}
					res.Accepted = append(res.Accepted, b.SizedRef())
					// Accepted risk, documented in
					// docs/multi-tenant-roadmap.md Phase 2: a session's own
					// commit to storage may still happen asynchronously
					// after this; a failed later commit leaves this a
					// harmless orphan claim, since the permanode it names
					// never actually lands in the corpus.
					if !stampNewPermanode(ctx, b.Ref(), permanodeRefs, stamp, uploader, hasUploader, addError) {
						res.Accepted = res.Accepted[:len(res.Accepted)-1]
					}
				}
			}
			group, groupBytes = nil, 0
			return
		}
		err := blobserver.ReceiveBlobs(ctx, blobReceiver, group)
		if _, ok := errors.AsType[*blobserver.BlobsError](err); err != nil && !ok {
			addError(fmt.Sprintf("Error receiving %d blobs: %v\n", len(group), err))
		} else {
			done := make(map[blob.Ref]bool, len(group))
			for _, b := range group {
				if done[b.Ref()] {
					continue
				}
				done[b.Ref()] = true
				if err := blobserver.BlobErr(err, b.Ref()); err != nil {
					addError(fmt.Sprintf("Error receiving blob %v: %v\n", b.Ref(), err))
					continue
				}
				log.Printf("Received blob %v\n", b.SizedRef())
				receivedBlobs = append(receivedBlobs, b.SizedRef())
				if !stampNewPermanode(ctx, b.Ref(), permanodeRefs, stamp, uploader, hasUploader, addError) {
					receivedBlobs = receivedBlobs[:len(receivedBlobs)-1]
				}
			}
		}
		group, groupBytes = nil, 0
	}

	for {
		mimePart, err := multipart.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			addError(fmt.Sprintf("Error reading multipart section: %v", err))
			break
		}

		contentDisposition, params, err := mime.ParseMediaType(mimePart.Header.Get("Content-Disposition"))
		if err != nil {
			addError("invalid Content-Disposition")
			break
		}

		if contentDisposition != "form-data" {
			addError(fmt.Sprintf("Expected Content-Disposition of \"form-data\"; got %q", contentDisposition))
			break
		}

		formName := params["name"]
		ref, ok := blob.Parse(formName)
		if !ok {
			addError(fmt.Sprintf("Ignoring form key %q", formName))
			continue
		}

		const tooBig = blobserver.MaxBlobSize + 1
		data, err := io.ReadAll(io.LimitReader(mimePart, tooBig))
		if err == nil && len(data) == tooBig {
			err = fmt.Errorf("blob over the limit of %d bytes", blobserver.MaxBlobSize)
		}
		if err != nil {
			addError(fmt.Sprintf("Error receiving blob %v: %v\n", ref, err))
			break
		}
		// Classify before this blob is ever added to group, so a claim
		// attempting to set the reserved ownership attribute, or to
		// modify a permanode the caller isn't authorized to touch, is
		// rejected outright and never stored at all -- rejecting only the
		// HTTP response after storing it wouldn't be enough, since it
		// would still get indexed regardless. The rest of the batch still
		// proceeds (per-blob rejection, not a whole-batch failure).
		isPermanode, rejectReason := classifyUpload(req, ref, data, isReservedAttr, mayClaim)
		if rejectReason != "" {
			addError(fmt.Sprintf("%s (blob %v)\n", rejectReason, ref))
			continue
		}
		if isPermanode {
			permanodeRefs[ref] = true
		}
		group = append(group, blob.NewBlob(ref, uint32(len(data)), func(context.Context) ([]byte, error) {
			return data, nil
		}))
		groupBytes += len(data)
		if session != nil || len(group) >= uploadGroupBlobs || groupBytes >= uploadGroupBytes {
			receiveGroup()
		}
	}
	receiveGroup()

	res.Received = receivedBlobs

	if vivifying {
		// TODO(mpl): In practice, this only works because we upload blobs one by one.
		// If we sent many blobs in one multipart, the code below means
		// all of them would have to be file schema blobs, which is a very
		// particular case. Shouldn't we fix that?
		// Or I suppose we could document that a file schema blob that
		// wants to be vivified should always be sent alone.
		for _, got := range receivedBlobs {
			err := vivify(ctx, blobReceiver, got, stamp, uploader, hasUploader)
			if err != nil {
				addError(fmt.Sprintf("Error vivifying blob %v: %v\n", got.Ref.String(), err))
			} else {
				rw.Header().Add("X-Camlistore-Vivified", got.Ref.String())
			}
		}
	}

	res.ErrorText = errBuf.String()

	httputil.ReturnJSON(rw, res)
}
