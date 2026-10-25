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

package auth

import (
	"net/http"
	"strings"
	"sync/atomic"

	"perkeep.org/pkg/accounts"
)

func newJWTAuth(string) (AuthMode, error) {
	return jwtAuth{}, nil
}

// uiPrefix is the UI handler's own mount prefix (e.g. "/ui/"), registered
// once by pkg/server's UI handler constructor via RegisterUIPrefix. Other
// handler types (search, jsonsign, sync, status, help, importer) live
// under different prefixes and are never affected by it -- see
// isPublicUIShellRequest, which checks this before anything else.
var uiPrefix atomic.Value

// RegisterUIPrefix records the UI handler's own mount prefix, so this
// package can tell "a request for the SPA's own static shell" (safe to
// serve with no token at all, under the jwt auth mode -- see
// isPublicUIShellRequest) apart from a request to any other handler type,
// which must never get that carve-out. Called once, by pkg/server.
func RegisterUIPrefix(prefix string) {
	uiPrefix.Store(prefix)
}

func currentUIPrefix() string {
	v, _ := uiPrefix.Load().(string)
	return v
}

// jwtAuth is the "jwt" auth mode ("auth": "jwt" in server-config.json),
// replacing per-request Basic-auth checking with per-user login (see
// pkg/accounts' package doc for the whole design). It delegates entirely
// to accounts.Default(), which owns the signing secret and the
// account/API-token store; this type just extracts the bearer token from
// the request and translates accounts' yes/no into the Operation bitmask
// the rest of this package expects, the same role UserPass/tokenAuth play
// above for their own credential schemes.
type jwtAuth struct{}

func (jwtAuth) AllowedAccess(req *http.Request) Operation {
	store := accounts.Default()
	if store == nil {
		// The "accounts" handler hasn't finished initializing yet (or
		// isn't configured at all, a server-config.json mistake) -- fail
		// closed rather than letting every request through.
		return 0
	}
	if tok := jwtBearerToken(req); tok != "" {
		if _, ok := store.VerifyBearer(req.Context(), tok); ok {
			return OpAll
		}
		return 0
	}
	// No bearer token at all: Basic auth's native browser prompt has no
	// bearer-token equivalent, so the SPA's own compiled HTML/JS/CSS shell
	// -- identical bytes for every visitor, no secrets in it -- has to be
	// reachable without one, or the React app (and the /login screen it
	// renders) could never even load. Every actual data route (discovery,
	// search, thumbnails, downloads, uploads, ...) still requires a valid
	// token via the check above; this only ever matches what's left.
	if isPublicUIShellRequest(req) {
		return OpAll
	}
	return 0
}

// isPublicUIShellRequest mirrors pkg/server/ui.go's UIHandler.ServeHTTP
// dispatch: true for exactly the cases that fall through to its "serve a
// static asset, or the SPA shell" default branch, false for discovery or
// any of its data-sub-route cases (upload helper, download, importshare,
// thumbnail, tree, qr) -- and, first and foremost, false for anything not
// even under the UI handler's own prefix, so this can never apply to any
// other handler type (search, jsonsign, sync, status, help, importer).
func isPublicUIShellRequest(req *http.Request) bool {
	prefix := currentUIPrefix()
	if prefix == "" || !strings.HasPrefix(req.URL.Path, prefix) {
		return false
	}
	if req.Header.Get("Accept") == "text/x-camli-configuration" {
		return false // discovery
	}
	q := req.URL.Query()
	if req.Method == http.MethodPost && q.Get("camli.mode") == "uploadhelper" {
		return false
	}
	if q.Get("camli.mode") == "config" {
		return false // discovery, alternate form
	}
	p := req.URL.Path
	for _, sub := range []string{"/download/", "importshare", "/thumbnail/", "/tree/", "/qr/"} {
		if strings.Contains(p, sub) {
			return false
		}
	}
	return req.Method == http.MethodGet || req.Method == http.MethodHead
}

func (jwtAuth) AddAuthHeader(req *http.Request) {
	// No single process-wide credential to inject here (unlike UserPass):
	// the web UI attaches its own per-session JWT, and curl/scripts attach
	// their own per-user API token -- see api/client.js and the Account
	// page respectively.
}

// jwtBearerToken mirrors authTokenHeaderMatches/websocketTokenMatches
// above: accept the token from the Authorization header for ordinary
// requests, or from a query parameter for the cases that can't set custom
// headers (the search WebSocket upgrade, and directly-loaded resource URLs
// like thumbnails/downloads).
func jwtBearerToken(req *http.Request) string {
	if h := req.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return req.URL.Query().Get("access_token")
}
