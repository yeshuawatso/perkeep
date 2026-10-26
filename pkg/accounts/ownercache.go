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
	"sync"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/search"
)

// ownerCache is an in-memory blobref -> owning-account-permanode cache.
// There is no existing index-level reverse lookup from an arbitrary
// blobref to its owning permanode (index.Interface only exposes
// ForeachClaimBack, the other direction), and a full Describe-equivalent
// per lookup would be far too expensive for the raw-blob-storage
// enforcement layer (enumerate-blobs can return hundreds of digests in
// one call) -- see docs/multi-tenant-roadmap.md's Phase 2 section.
type ownerCache struct {
	mu sync.RWMutex
	m  map[blob.Ref]blob.Ref
}

func (c *ownerCache) get(ref blob.Ref) (blob.Ref, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.m[ref]
	return v, ok
}

func (c *ownerCache) set(ref, owner blob.Ref) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = make(map[blob.Ref]blob.Ref)
	}
	c.m[ref] = owner
}

// OwnerOf resolves the account that owns ref: either ref is itself a
// permanode stamped with AccountRefAttr (see StampOwnership), or some
// permanode claims ref via camliContent or camliMember (one hop only).
// Used by enforcement layers that can't afford a full Describe per
// request the way the search/describe layers can (pkg/server/ui.go's
// thumbnail/download/filetree routes, and raw blob storage's
// enumerate-blobs/get/stat).
//
// Known, accepted limitation: a large file's individual bytesRef chunk
// blobs are not resolved by the camliContent hop (camliContent points at
// the file's schema blob, not its byte-range parts) -- OwnerOf reports
// not-found for those, so callers fail closed (deny) rather than fail
// open. Extend this to walk bytesRef parts if testing against a real
// large/chunked file (see step 9's FUSE verification) shows that's
// actually hit in practice; not done preemptively since it adds a real
// cost (parsing the file's schema blob) to every miss.
func (s *Store) OwnerOf(ctx context.Context, ref blob.Ref) (accountRef blob.Ref, ok bool, err error) {
	if v, hit := s.ownerCache.get(ref); hit {
		return v, true, nil
	}
	if owner, found, err := s.ownerOfPermanode(ctx, ref); err != nil {
		return blob.Ref{}, false, err
	} else if found {
		s.ownerCache.set(ref, owner)
		return owner, true, nil
	}
	for _, attr := range []string{"camliContent", "camliMember"} {
		// Earliest claimant wins, deliberately -- NOT findPermanodeByAttr's
		// usual Sort: CreatedDesc (right for its other callers, e.g.
		// findAccount, where a unique match is expected anyway). A forged
		// claim racing to reference someone else's existing content is
		// exactly the attack this cache exists to resist (see
		// pkg/search/describe.go's identical note on resolveBlobOwner);
		// Perkeep's content-addressed dedup means multiple permanodes can
		// legitimately reference the same bytes, so "most recent" would
		// let a newer, unrelated claim silently override the real owner.
		pn, found, err := s.earliestPermanodeByAttr(ctx, attr, ref.String())
		if err != nil {
			return blob.Ref{}, false, err
		}
		if !found {
			continue
		}
		owner, found, err := s.ownerOfPermanode(ctx, pn)
		if err != nil {
			return blob.Ref{}, false, err
		}
		if found {
			s.ownerCache.set(ref, owner)
			return owner, true, nil
		}
	}
	return blob.Ref{}, false, nil
}

// ownerOfPermanode returns pn's AccountRefAttr value, or found=false if
// pn isn't a permanode, doesn't exist, or has no owner stamped (e.g. it
// predates backfillOwnership, or is accounts infrastructure itself --
// account/apitoken permanodes are deliberately never stamped, see
// backfillOwnership's doc comment).
func (s *Store) ownerOfPermanode(ctx context.Context, pn blob.Ref) (blob.Ref, bool, error) {
	// unfilteredCtx (permanode.go): this is OwnerOf's own answer to "who
	// owns pn," which must never be subject to pkg/search's owner-filter
	// re-applying itself here if ctx happens to carry a Caller (it does,
	// in practice, whenever OwnerOf is reached via pkg/search's own
	// HTTP-layer ownership checks passing through req.Context()).
	resp, err := s.search.Describe(unfilteredCtx(ctx), &search.DescribeRequest{BlobRef: pn})
	if err != nil {
		return blob.Ref{}, false, err
	}
	db := resp.Meta.Get(pn)
	if db == nil || db.Permanode == nil {
		return blob.Ref{}, false, nil
	}
	v := db.Permanode.Attr.Get(AccountRefAttr)
	if v == "" {
		return blob.Ref{}, false, nil
	}
	owner, ok := blob.Parse(v)
	if !ok {
		return blob.Ref{}, false, nil
	}
	return owner, true, nil
}
