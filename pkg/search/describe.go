/*
Copyright 2014 The Perkeep Authors

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

package search

import (
	"context"
	"log"
	"net/http"
	"time"

	"perkeep.org/internal/httputil"
	"perkeep.org/internal/searchtypes"
	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/types/camtypes"
)

func (h *Handler) serveDescribe(rw http.ResponseWriter, req *http.Request) {
	defer httputil.RecoverJSON(rw, req)
	var dr DescribeRequest
	searchtypes.DescribeRequestFromHTTP(&dr, req)
	// req.Context(), not context.TODO(): ServeHTTP stashes the resolved
	// Caller in req's context (see caller.go), and DescribeLocked needs it
	// to filter results -- context.TODO() would silently discard it,
	// leaving this endpoint completely unfiltered regardless of caller.
	ctx := req.Context()

	res, err := h.Describe(ctx, &dr)
	if err != nil {
		httputil.ServeJSONError(rw, err)
		return
	}
	httputil.ReturnJSON(rw, res)
}

const verboseDescribe = false

// Describe returns a response for the given describe request. It acquires RLock
// on the Handler's index.
func (h *Handler) Describe(ctx context.Context, dr *DescribeRequest) (dres *DescribeResponse, err error) {
	h.index.RLock()
	defer h.index.RUnlock()

	return h.DescribeLocked(ctx, dr)
}

// DescribeLocked returns a response for the given describe request. It is the
// caller's responsibility to lock the search handler's index.
func (h *Handler) DescribeLocked(ctx context.Context, dr *DescribeRequest) (dres *DescribeResponse, err error) {
	if verboseDescribe {
		t0 := time.Now()
		defer func() {
			td := time.Since(t0)
			var num int
			if dres != nil {
				num = len(dres.Meta)
			}
			log.Printf("Described %d blobs in %v", num, td)
		}()
	}
	h.initDescribeRequest(dr)
	dres, err = searchtypes.Describe(ctx, dr)
	if err != nil {
		return nil, err
	}
	h.filterDescribeForCaller(ctx, dres)
	return dres, nil
}

// filterDescribeForCaller is Describe's rule-expansion fix (the second,
// independent one -- fixing Query, step 5, only protects a request's own
// matched blobs; searchtypes.Describe's expandRules/doDescribe follows
// references like camliContent one hop further with no constraint check
// at all, so a permanode a caller owns could still pull in a blob they
// don't via this path). A no-op for admins and for any ctx with no
// resolved Caller -- every internal Go-level caller (e.g. pkg/accounts'
// own context.Background() lookups), by design.
//
// Every entry is checked independently, including the directly-requested
// root(s): for a permanode entry, its own AccountRefAttr is authoritative
// (no extra lookup); for a non-permanode entry (a file/dir schema blob
// has no AccountRefAttr of its own), resolveBlobOwner resolves its
// primary owner via the one-hop camliContent/camliMember reverse lookup.
//
// Deliberately does NOT call h.callers.OwnerOf (pkg/accounts) for that
// lookup, unlike callerOwns below: DescribeLocked is always called with
// h.index already RLocked by the caller (its own doc comment says so),
// and OwnerOf's Query/Describe calls would try to RLock it again --
// sync.RWMutex explicitly prohibits recursive read-locking (a concurrent
// Lock() attempt between the two RLocks deadlocks both). resolveBlobOwner
// reimplements the same one-hop lookup using the non-locking
// corpus/index primitives this package's own Query already relies on for
// an identical reason.
func (h *Handler) filterDescribeForCaller(ctx context.Context, dres *DescribeResponse) {
	if h.callers == nil || dres == nil {
		return
	}
	caller, ok := callerFromContext(ctx)
	if !ok || caller.IsAdmin {
		return
	}
	for ref, db := range dres.Meta {
		var owner blob.Ref
		var owned bool
		if db.Permanode != nil {
			if v := db.Permanode.Attr.Get(ownerAttr); v != "" {
				if o, ok := blob.Parse(v); ok {
					owner, owned = o, true
				}
			}
		} else if br, ok := blob.Parse(ref); ok {
			owner, owned = h.resolveBlobOwner(br)
		}
		if !owned || owner != caller.AccountRef {
			delete(dres.Meta, ref)
		}
	}
}

// resolveBlobOwner is the lock-free twin of pkg/accounts.OwnerOf's
// one-hop camliContent/camliMember reverse lookup -- see
// filterDescribeForCaller's doc comment for why this can't just call
// that instead. Same documented, accepted limitation: doesn't walk into
// a large file's bytesRef chunk list.
//
// Requires an in-memory corpus (server-config.json's "slurpToMemory":
// true on the search handler); without one, this can't run at all and
// reports not-found -- fail closed, same spirit as OwnerOf's own
// bytesRef limitation.
//
// Picks the EARLIEST claim by date among all candidates, deliberately --
// ForeachClaimBack's own iteration order is explicitly undefined, and a
// forged claim racing to reference someone else's existing content
// (exactly the attack this exists to resist) could otherwise be picked
// over the real owner's original claim depending on map iteration order
// alone. See pkg/accounts/ownercache.go's identical note on
// earliestPermanodeByAttr -- both need the same fix for the same reason.
func (h *Handler) resolveBlobOwner(ref blob.Ref) (blob.Ref, bool) {
	if h.corpus == nil {
		return blob.Ref{}, false
	}
	var earliest *camtypes.Claim
	for _, attr := range [...]string{"camliContent", "camliMember"} {
		h.corpus.ForeachClaimBack(ref, time.Time{}, func(cl *camtypes.Claim) bool {
			if cl.Attr == attr && (earliest == nil || cl.Date.Before(earliest.Date)) {
				earliest = cl
			}
			return true
		})
	}
	if earliest == nil {
		return blob.Ref{}, false
	}
	if v := h.corpus.PermanodeAttrValue(earliest.Permanode, ownerAttr, time.Time{}, h.owner.KeyID()); v != "" {
		if owner, ok := blob.Parse(v); ok {
			return owner, true
		}
	}
	return blob.Ref{}, false
}

// callerOwns reports whether ctx's resolved Caller may see ref: true if
// no "accounts" handler is configured (legacy behavior, unchanged), true
// if ctx carries no Caller at all (an internal Go-level call, not an HTTP
// request -- unfiltered by design, same as Query/DescribeLocked), true
// for an admin, and otherwise the result of the same OwnerOf lookup
// filterDescribeForCaller uses for non-permanode entries.
//
// Used by serveClaims/serveEdgesTo (handler.go), which -- unlike
// serveQuery/serveDescribe -- call through to GetClaims/EdgesTo methods
// that build their own internal context.TODO() rather than accepting the
// request's context, so they can't filter via callerFromContext
// themselves; the check happens at the HTTP layer instead, before the
// call through.
func (h *Handler) callerOwns(ctx context.Context, ref blob.Ref) bool {
	if h.callers == nil {
		return true
	}
	caller, ok := callerFromContext(ctx)
	if !ok || caller.IsAdmin {
		return true
	}
	owner, found, err := h.callers.OwnerOf(ctx, ref)
	return err == nil && found && owner == caller.AccountRef
}

// notFoundForCaller is returned (via httputil.ServeJSONError) by
// serveClaims/serveEdgesTo when callerOwns denies access -- 404, not 403,
// to avoid distinguishing "exists but isn't yours" from "doesn't exist",
// the same convention used by every other Phase 2 enforcement site.
type notFoundForCaller struct{}

func (notFoundForCaller) Error() string { return "not found" }
func (notFoundForCaller) HTTPCode() int { return http.StatusNotFound }

// The describe protocol types and their methods live in searchtypes so clients
// do not need to import the search handler or index implementation.
type (
	DescribeRequest    = searchtypes.DescribeRequest
	DescribeRule       = searchtypes.DescribeRule
	DescribeResponse   = searchtypes.DescribeResponse
	MetaMap            = searchtypes.MetaMap
	DescribedBlob      = searchtypes.DescribedBlob
	DescribedPermanode = searchtypes.DescribedPermanode
	DescribeError      = searchtypes.DescribeError
)

// NewDescribeRequest returns a new DescribeRequest holding the state
// of blobs and their summarized descriptions.  Use DescribeBlob
// one or more times before calling Result.
func (h *Handler) NewDescribeRequest() *DescribeRequest {
	dr := new(DescribeRequest)
	h.initDescribeRequest(dr)
	return dr
}

func (h *Handler) initDescribeRequest(req *DescribeRequest) {
	searchtypes.InitDescribeRequest(req, h.index, h.owner.KeyID(),
		func(ctx context.Context, br blob.Ref, at time.Time) (camtypes.Location, error) {
			return h.lh.PermanodeLocation(ctx, br, at, h.owner)
		})
}
