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

package search

import (
	"context"
	"net/http"

	"perkeep.org/pkg/blob"
)

// ownerAttr is the permanode attribute recording which account owns a
// given permanode -- stamped synchronously, server-side, at upload time
// by pkg/accounts.Store.StampOwnership. It's duplicated here as a literal
// (pkg/accounts.AccountRefAttr is the source of truth) rather than
// imported, because pkg/accounts already imports this package (for
// search.QueryDescriber) -- importing it back here would be a cycle. See
// docs/multi-tenant-roadmap.md's Phase 2 section.
const ownerAttr = "camliAccountRef"

// Caller is the resolved identity of an authenticated HTTP request, set
// in context by Handler.ServeHTTP for every request this search handler
// receives, and read back by Handler.Query/DescribeLocked to filter
// results to the caller's own permanodes. Deliberately a local type, not
// pkg/accounts.Caller, for the same import-cycle reason as ownerAttr --
// callerResolver below converts between them.
type Caller struct {
	AccountRef blob.Ref
	IsAdmin    bool
}

// callerResolver is the subset of *accounts.Store this package needs,
// expressed structurally (like pkg/accounts' own rootLike) to avoid the
// import cycle. *accounts.Store satisfies this via ResolveSearchCaller
// (accounts/handler.go), a thin adapter over ResolveRequest.
type callerResolver interface {
	ResolveSearchCaller(req *http.Request) (Caller, bool)
}

type callerContextKey struct{}

// withCaller returns a copy of ctx carrying caller, read back by
// callerFromContext inside Query/DescribeLocked.
func withCaller(ctx context.Context, caller Caller) context.Context {
	return context.WithValue(ctx, callerContextKey{}, caller)
}

// callerFromContext reports the caller set by ServeHTTP for this request,
// or ok=false for any context that didn't go through it -- internal
// Go-level callers (e.g. pkg/accounts' own context.Background() lookups)
// included, which is exactly why they stay unfiltered by design.
func callerFromContext(ctx context.Context) (Caller, bool) {
	c, ok := ctx.Value(callerContextKey{}).(Caller)
	return c, ok
}
