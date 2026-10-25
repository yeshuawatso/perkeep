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
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// ServeHTTP implements the /auth/* routes (login is public; everything
// else requires a bearer token -- see pkg/serverinit's wiring notes for why
// this handler type is deliberately left out of the auth-wrapped handler
// types, and does its own bearer check here instead).
func (s *Store) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, s.prefix), "/")
	switch {
	case rel == "login" && r.Method == http.MethodPost:
		s.handleLogin(w, r)
	case rel == "account" && r.Method == http.MethodGet:
		s.withUser(w, r, s.handleGetAccount)
	case rel == "account/username" && r.Method == http.MethodPost:
		s.withUser(w, r, s.handleChangeUsername)
	case rel == "account/password" && r.Method == http.MethodPost:
		s.withUser(w, r, s.handleChangePassword)
	case rel == "account/tokens" && r.Method == http.MethodPost:
		s.withUser(w, r, s.handleCreateToken)
	case strings.HasPrefix(rel, "account/tokens/") && r.Method == http.MethodDelete:
		s.withUser(w, r, s.handleRevokeToken)
	case rel == "admin/users" && r.Method == http.MethodGet:
		s.withAdminUser(w, r, s.handleListUsers)
	case rel == "admin/users" && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleCreateUser)
	case strings.HasPrefix(rel, "admin/users/") && strings.HasSuffix(rel, "/grant-admin") && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleGrantAdmin)
	case strings.HasPrefix(rel, "admin/users/") && strings.HasSuffix(rel, "/revoke-admin") && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleRevokeAdmin)
	case strings.HasPrefix(rel, "admin/users/") && strings.HasSuffix(rel, "/impersonate") && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleImpersonate)
	case strings.HasPrefix(rel, "admin/users/") && r.Method == http.MethodDelete:
		s.withAdminUser(w, r, s.handleDeleteUser)
	default:
		http.NotFound(w, r)
	}
}

// adminUserTarget pulls the {username} path segment out of
// "admin/users/{username}" or "admin/users/{username}/<action>".
func (s *Store) adminUserTarget(r *http.Request) string {
	rel := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, s.prefix), "/")
	rest := strings.TrimPrefix(rel, "admin/users/")
	if i := strings.Index(rest, "/"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

func bearerFromRequest(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.URL.Query().Get("access_token")
}

// withUser resolves the caller's identity from the bearer token before
// running h -- the transport-level auth.Handler wrapper other handler
// types get doesn't apply to this one (see ServeHTTP's comment), so every
// non-login route checks it here instead. Admin routes layer an IsAdmin
// check on top via withAdmin, below.
func (s *Store) withUser(w http.ResponseWriter, r *http.Request, h func(w http.ResponseWriter, r *http.Request, ident *Identity)) {
	tok := bearerFromRequest(r)
	if tok == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ident, ok := s.Identify(r.Context(), tok)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	h(w, r, ident)
}

// withAdmin wraps a handler that additionally requires the caller to be an
// administrator -- the real boundary is each Store method's own
// requireAdmin check (admin.go), but failing fast here avoids a pointless
// round trip for an obviously-unauthorized caller.
func (s *Store) withAdmin(w http.ResponseWriter, r *http.Request, ident *Identity, h func(w http.ResponseWriter, r *http.Request, ident *Identity)) {
	ok, err := s.IsAdmin(r.Context(), ident.Username)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	h(w, r, ident)
}

// withAdminUser composes withUser + withAdmin for the admin/* routes.
func (s *Store) withAdminUser(w http.ResponseWriter, r *http.Request, h func(w http.ResponseWriter, r *http.Request, ident *Identity)) {
	s.withUser(w, r, func(w http.ResponseWriter, r *http.Request, ident *Identity) {
		s.withAdmin(w, r, ident, h)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (s *Store) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	tok, err := s.Login(r.Context(), body.Username, body.Password)
	if err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	writeJSON(w, struct {
		Token    string `json:"token"`
		Username string `json:"username"`
	}{tok, body.Username})
}

func (s *Store) handleGetAccount(w http.ResponseWriter, r *http.Request, ident *Identity) {
	acct, err := s.GetAccount(r.Context(), ident.Username)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	acct.ImpersonatedBy = ident.ImpersonatedBy
	writeJSON(w, acct)
}

func (s *Store) handleChangeUsername(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		NewUsername     string `json:"newUsername"`
		CurrentPassword string `json:"currentPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.ChangeUsername(r.Context(), ident.Username, body.NewUsername, body.CurrentPassword); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, ErrExists) {
			status = http.StatusConflict
		}
		http.Error(w, "could not change username", status)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleChangePassword(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.ChangePassword(r.Context(), ident.Username, body.CurrentPassword, body.NewPassword); err != nil {
		http.Error(w, "could not change password", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleCreateToken(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		Label string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	tok, meta, err := s.CreateAPIToken(r.Context(), ident.Username, body.Label)
	if err != nil {
		http.Error(w, "could not create token", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct {
		Token string       `json:"token"`
		Meta  APITokenView `json:"meta"`
	}{tok, meta})
}

func (s *Store) handleRevokeToken(w http.ResponseWriter, r *http.Request, ident *Identity) {
	rel := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, s.prefix), "/")
	id := strings.TrimPrefix(rel, "account/tokens/")
	if err := s.RevokeAPIToken(r.Context(), ident.Username, id); err != nil {
		http.Error(w, "could not revoke token", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleListUsers(w http.ResponseWriter, r *http.Request, ident *Identity) {
	users, err := s.ListUsers(r.Context(), ident.Username)
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, users)
}

func (s *Store) handleCreateUser(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.CreateUser(r.Context(), ident.Username, body.Username, body.Password); err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleDeleteUser(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if err := s.DeleteUser(r.Context(), ident.Username, s.adminUserTarget(r)); err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleGrantAdmin(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if err := s.GrantAdmin(r.Context(), ident.Username, s.adminUserTarget(r)); err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleRevokeAdmin(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if err := s.RevokeAdmin(r.Context(), ident.Username, s.adminUserTarget(r)); err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleImpersonate(w http.ResponseWriter, r *http.Request, ident *Identity) {
	tok, err := s.Impersonate(r.Context(), ident.Username, s.adminUserTarget(r))
	if err != nil {
		writeAdminError(w, err)
		return
	}
	writeJSON(w, struct {
		Token string `json:"token"`
	}{tok})
}

// writeAdminError maps the admin.go sentinel errors to the right HTTP
// status instead of flattening everything to 400 -- callers (the Admin
// page) tell these apart (e.g. "last admin" vs. "not found").
func writeAdminError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, ErrExists):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, ErrLastAdmin), errors.Is(err, ErrSelfGrant):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
