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

import "net/http"

// This file is a deliberately unwired design stub, not live code -- see
// docs/multi-tenant-roadmap.md's storage-backend section for the
// decision to defer Google Drive's full admin-UI-driven OAuth2 consent
// flow. Today, the storage panel's Drive form takes client_id/
// client_secret/refresh_token/parent_id as structured, masked fields
// (see storage.go, storagetarget.driveArgs) -- the admin still has to
// mint a refresh_token externally once (see doc/server-config.md's
// runbook), but no longer has to hand-edit server JSON to enter it.
//
// Neither handler below is registered in handler.go's route table; they
// exist only to carry the design for whoever builds the real flow next,
// so it doesn't need to be re-derived from scratch. Building it for real
// requires, at minimum:
//
//  1. The admin must still create their own OAuth2 client ID/secret in
//     Google Cloud Console first (enable the Drive API, configure the
//     OAuth consent screen, register this server's own callback URL as
//     an authorized redirect URI) -- no UI Perkeep builds can skip this
//     external step, since it's Google's own app-registration process.
//     handleDriveOAuthStart would still need that client_id/secret
//     supplied (e.g. via the same structured fields that exist today)
//     before it has anything to redirect with.
//  2. handleDriveOAuthStart generates a random, single-use state value,
//     stashes it server-side (keyed to the caller's admin session, with
//     a short TTL -- a durable store isn't needed, this is a few-minute
//     handshake), and 302s the browser to Google's OAuth2 authorization
//     endpoint with scope "https://www.googleapis.com/auth/drive",
//     access_type=offline, and prompt=consent (the latter two are what
//     actually get a *refresh* token back, not just a short-lived access
//     token -- easy to get wrong and silently end up without one).
//  3. handleDriveOAuthCallback verifies the returned state matches
//     (CSRF protection -- reject anything else), exchanges the
//     authorization code for tokens via the standard OAuth2 token
//     endpoint, and writes the resulting refresh_token into the relevant
//     StorageTarget's GoogleRefreshToken field via the same
//     saveStorageFields path handleAddOrUpdateBackup already uses.
//  4. The frontend's disabled "Connect with Google (coming soon)" button
//     (ShareModal.jsx's sibling in the storage panel, see AdminPage.jsx)
//     gets swapped for a real link to the start route once this is filled
//     in, with the callback route's final step redirecting back into the
//     storage panel (success or error) rather than returning raw JSON,
//     since this leg of the flow is a full-page browser redirect, not an
//     XHR/fetch call like every other admin-UI action in this file.
func (s *Store) handleDriveOAuthStart(w http.ResponseWriter, r *http.Request, ident *Identity) {
	http.Error(w, "not implemented: see storage_drive_oauth.go", http.StatusNotImplemented)
}

func (s *Store) handleDriveOAuthCallback(w http.ResponseWriter, r *http.Request, ident *Identity) {
	http.Error(w, "not implemented: see storage_drive_oauth.go", http.StatusNotImplemented)
}
