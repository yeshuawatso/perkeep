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
	"bytes"
	"context"
	"io"
	"sync"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/schema"
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
// Resolving a "file" or "bytes" schema blob's owner also pre-populates
// the cache for every chunk blob reachable from its parts list (see
// cacheFileTree) -- a chunk blob itself is two hops from the owning
// permanode (permanode -[camliContent]-> file schema -[parts]-> chunk),
// one more than this cache's own reverse lookup walks, and there's no
// index to walk that second hop directly. Confirmed live against a real
// multi-chunk upload: without this, a non-admin user could not read
// their own file's content through any raw-blob-backed client (pk-mount,
// pk-get, any pkg/client tool) -- GET on an individual chunk 404'd even
// for the legitimate owner, since nothing else ever establishes that
// chunk's ownership. (pkg/server/ui.go's download/thumbnail/filetree
// routes were never affected: they authorize once against the top-level
// requested ref, then read the file's bytes through a direct
// storage-level Fetcher, never re-entering this raw-GET enforcement
// per chunk.)
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
			s.cacheFileTree(ctx, ref, owner)
			return owner, true, nil
		}
	}
	return blob.Ref{}, false, nil
}

// maxFileTreeDepth bounds cacheFileTree's recursion into nested "bytes"
// schema blobs (large files split via multiple levels of bytesRef
// indirection). Real files nest only a few levels deep; this is a
// generous ceiling against a malformed or adversarial schema blob, not a
// realistic limit.
const maxFileTreeDepth = 16

// cacheFileTree fetches and parses ref (best-effort: any failure is
// silently swallowed, since a cache miss always falls back safely to
// denial, never to open access) and, if it's a "file" or "bytes" schema
// blob, records owner in the cache for every part it lists -- a leaf
// BlobRef part directly, or recursing into a BytesRef part's own nested
// parts. Called once, right after OwnerOf resolves ref's own ownership
// via the one-hop reverse lookup, so the cost (parsing ref's JSON, and
// recursively its "bytes" children) is paid once per file per process
// lifetime, not per chunk request -- and lands before any client that
// just resolved ref's ownership goes on to actually read ref's chunks,
// which is every real caller (schema.FileReader always fetches the file
// schema blob itself before any of its parts).
func (s *Store) cacheFileTree(ctx context.Context, ref, owner blob.Ref) {
	s.cacheFileTreeDepth(ctx, ref, owner, 0)
}

func (s *Store) cacheFileTreeDepth(ctx context.Context, ref, owner blob.Ref, depth int) {
	if depth > maxFileTreeDepth || s.blobSource == nil {
		return
	}
	rc, _, err := s.blobSource.Fetch(ctx, ref)
	if err != nil {
		return
	}
	data, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		return
	}
	b, err := schema.BlobFromReader(ref, bytes.NewReader(data))
	if err != nil {
		return
	}
	switch b.Type() {
	case schema.TypeFile, schema.TypeBytes:
	default:
		return
	}
	for _, part := range b.ByteParts() {
		switch {
		case part.BlobRef.Valid():
			s.ownerCache.set(part.BlobRef, owner)
		case part.BytesRef.Valid():
			if _, hit := s.ownerCache.get(part.BytesRef); hit {
				continue
			}
			s.ownerCache.set(part.BytesRef, owner)
			s.cacheFileTreeDepth(ctx, part.BytesRef, owner, depth+1)
		}
	}
}

// ownerOfPermanode returns pn's AccountRefAttr value, or found=false if
// pn isn't a permanode, doesn't exist, or has no owner stamped (e.g. it
// predates backfillOwnership, or is accounts infrastructure itself --
// account/apitoken permanodes are deliberately never stamped, see
// backfillOwnership's doc comment).
func (s *Store) ownerOfPermanode(ctx context.Context, pn blob.Ref) (blob.Ref, bool, error) {
	_, stamped, owner, err := s.PermanodeOwnership(ctx, pn)
	return owner, stamped, err
}

// PermanodeOwnership reports pn's current ownership status, distinguishing
// "doesn't exist (yet)" from "exists but isn't owned by anyone" -- a
// distinction ownerOfPermanode's single found bool can't make, but that
// serverinit's claim-target authorization check (see
// docs/multi-tenant-roadmap.md's Phase 2 section) needs: a brand-new
// permanode being created in the same upload batch as its own initial
// attribute claims (the normal create flow) doesn't exist=true yet, so
// those claims must be allowed through even though stamping (which
// happens right after, once the permanode itself is durable) hasn't run
// yet; a permanode that already exists but was never stamped -- accounts
// infrastructure (account/apitoken permanodes, deliberately never
// stamped) or legacy content that predates Phase 2's backfill -- must
// never be writable via a plain client-submitted claim, from anyone but
// an admin.
//
// exists is false only when pn isn't a permanode at all (including: pn
// doesn't exist, or isn't durable yet). stamped and owner are only
// meaningful when exists is true; stamped is false (owner zero) when pn
// exists but has no AccountRefAttr.
func (s *Store) PermanodeOwnership(ctx context.Context, pn blob.Ref) (exists, stamped bool, owner blob.Ref, err error) {
	// unfilteredCtx (permanode.go): this is the ground-truth answer to
	// "who owns pn," which must never be subject to pkg/search's
	// owner-filter re-applying itself here if ctx happens to carry a
	// Caller (it does, in practice, whenever this is reached via
	// pkg/search's own HTTP-layer ownership checks, or serverinit's
	// claim-target check, passing through req.Context()).
	resp, err := s.search.Describe(unfilteredCtx(ctx), &search.DescribeRequest{BlobRef: pn})
	if err != nil {
		return false, false, blob.Ref{}, err
	}
	db := resp.Meta.Get(pn)
	if db == nil || db.Permanode == nil {
		return false, false, blob.Ref{}, nil
	}
	v := db.Permanode.Attr.Get(AccountRefAttr)
	if v == "" {
		return true, false, blob.Ref{}, nil
	}
	owner, ok := blob.Parse(v)
	if !ok {
		return true, false, blob.Ref{}, nil
	}
	return true, true, owner, nil
}
