/*
Copyright 2026 The Perkeep Authors

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

package accounts

import (
	"context"
	"fmt"
	"io"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/blobserver"
	"perkeep.org/pkg/schema"
	"perkeep.org/pkg/search"
)

// upload signs bb with this server's own identity and stores the result --
// the same two-step pkg/importer's Host.upload performs.
func (s *Store) upload(ctx context.Context, bb *schema.Builder) (blob.Ref, error) {
	signed, err := bb.Sign(ctx, s.signer)
	if err != nil {
		return blob.Ref{}, err
	}
	sb, err := blobserver.ReceiveString(ctx, s.target, signed)
	if err != nil {
		return blob.Ref{}, err
	}
	return sb.Ref, nil
}

func (s *Store) newPermanode(ctx context.Context) (blob.Ref, error) {
	return s.upload(ctx, schema.NewUnsignedPermanode())
}

func (s *Store) setAttr(ctx context.Context, pn blob.Ref, attr, value string) error {
	_, err := s.upload(ctx, schema.NewSetAttributeClaim(pn, attr, value))
	return err
}

// StampOwnership records that permanode pn was created by username --
// called synchronously from the upload-handler hook
// (pkg/blobserver/handlers, wired up in pkg/serverinit), right after pn is
// durably received, never from a client-settable claim. See
// AccountRefAttr's doc comment (account.go) for why.
func (s *Store) StampOwnership(ctx context.Context, pn blob.Ref, username string) error {
	accountPN, found, err := s.findAccount(ctx, username)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if err := s.setAttr(ctx, pn, AccountRefAttr, accountPN.String()); err != nil {
		return err
	}
	// Populate OwnerOf's cache immediately: the common case is this exact
	// permanode being re-fetched right after upload (e.g. the UI
	// describing what it just created), which would otherwise always miss.
	s.ownerCache.set(pn, accountPN)
	return nil
}

// writeSecretBlob stores literal, unsigned content -- used for the
// bcrypt/SHA-256 hash blobs that passwordHashRef/tokenHashRef-style
// attributes point at, so the hash itself never appears as a permanode
// attribute value and can't leak through a stray describe()/search
// response the way an attribute value could.
func (s *Store) writeSecretBlob(ctx context.Context, content string) (blob.Ref, error) {
	sb, err := blobserver.ReceiveString(ctx, s.target, content)
	if err != nil {
		return blob.Ref{}, err
	}
	return sb.Ref, nil
}

func (s *Store) readBlobContent(ctx context.Context, ref blob.Ref) (string, error) {
	rc, _, err := s.blobSource.Fetch(ctx, ref)
	if err != nil {
		return "", err
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// unfilteredCtx returns a context for this package's own calls into the
// search handler's Query/Describe, deliberately discarding whatever ctx
// was passed into the calling Store method.
//
// pkg/search's Handler.Query/DescribeLocked filter results to the
// request's resolved Caller when its own ServeHTTP put one in context
// (see pkg/search/caller.go) -- exactly the Phase 2 enforcement this
// package implements in the first place. But this package's OWN internal
// lookups (resolving an account by username, finding who really owns some
// content via OwnerOf's reverse lookup, etc.) must get the true,
// unfiltered answer regardless of which caller happens to be asking --
// account/apitoken permanodes are never even stamped with an owner (see
// backfillOwnership), and a lookup like OwnerOf exists specifically to
// authoritatively answer "who owns this," not "what can the current
// caller see." A caller's context.Context value CAN reach here in
// practice (e.g. pkg/search's own HTTP-layer ownership checks naturally
// pass through req.Context() when calling back into this package), so
// this can't simply trust whatever ctx arrives -- it must actively drop
// it. Caught live: without this, OwnerOf's reverse lookup silently
// re-filtered itself to only the asking caller's own permanodes,
// defeating the entire point of asking "who actually owns this."
func unfilteredCtx(ctx context.Context) context.Context {
	return context.Background()
}

func (s *Store) findPermanodeByAttr(ctx context.Context, attr, value string) (blob.Ref, bool, error) {
	res, err := s.search.Query(unfilteredCtx(ctx), &search.SearchQuery{
		Constraint: &search.Constraint{
			Permanode: &search.PermanodeConstraint{Attr: attr, Value: value},
		},
		Limit: 1,
		Sort:  search.CreatedDesc,
	})
	if err != nil {
		return blob.Ref{}, false, err
	}
	if len(res.Blobs) == 0 {
		return blob.Ref{}, false, nil
	}
	return res.Blobs[0].Blob, true, nil
}

// earliestPermanodeByAttr is like findPermanodeByAttr but sorted
// CreatedAsc instead of CreatedDesc -- used only by OwnerOf's reverse
// lookup (ownercache.go), where picking the most-recently-created match
// (findPermanodeByAttr's usual behavior) would let a newer, forged claim
// override the real, original owner of some shared content.
func (s *Store) earliestPermanodeByAttr(ctx context.Context, attr, value string) (blob.Ref, bool, error) {
	res, err := s.search.Query(unfilteredCtx(ctx), &search.SearchQuery{
		Constraint: &search.Constraint{
			Permanode: &search.PermanodeConstraint{Attr: attr, Value: value},
		},
		Limit: 1,
		Sort:  search.CreatedAsc,
	})
	if err != nil {
		return blob.Ref{}, false, err
	}
	if len(res.Blobs) == 0 {
		return blob.Ref{}, false, nil
	}
	return res.Blobs[0].Blob, true, nil
}

func (s *Store) queryPermanodes(ctx context.Context, c *search.Constraint) ([]blob.Ref, error) {
	res, err := s.search.Query(unfilteredCtx(ctx), &search.SearchQuery{
		Constraint: c,
		Limit:      -1,
		Sort:       search.CreatedDesc,
	})
	if err != nil {
		return nil, err
	}
	refs := make([]blob.Ref, 0, len(res.Blobs))
	for _, b := range res.Blobs {
		refs = append(refs, b.Blob)
	}
	return refs, nil
}

// describeOne fetches a single permanode's current attributes.
func (s *Store) describeOne(ctx context.Context, pn blob.Ref) (*search.DescribedPermanode, error) {
	resp, err := s.search.Describe(unfilteredCtx(ctx), &search.DescribeRequest{BlobRef: pn})
	if err != nil {
		return nil, err
	}
	db := resp.Meta.Get(pn)
	if db == nil || db.Permanode == nil {
		return nil, fmt.Errorf("accounts: %s not found or not a permanode", pn)
	}
	return db.Permanode, nil
}
