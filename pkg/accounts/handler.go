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
	default:
		http.NotFound(w, r)
	}
}

func bearerFromRequest(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.URL.Query().Get("access_token")
}

// withUser resolves the caller's username from the bearer token before
// running h -- the transport-level auth.Handler wrapper other handler
// types get doesn't apply to this one (see ServeHTTP's comment), so every
// non-login route checks it here instead.
func (s *Store) withUser(w http.ResponseWriter, r *http.Request, h func(w http.ResponseWriter, r *http.Request, username string)) {
	tok := bearerFromRequest(r)
	if tok == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	username, ok := s.VerifyBearer(r.Context(), tok)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	h(w, r, username)
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

func (s *Store) handleGetAccount(w http.ResponseWriter, r *http.Request, username string) {
	acct, err := s.GetAccount(r.Context(), username)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, acct)
}

func (s *Store) handleChangeUsername(w http.ResponseWriter, r *http.Request, username string) {
	var body struct {
		NewUsername     string `json:"newUsername"`
		CurrentPassword string `json:"currentPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.ChangeUsername(r.Context(), username, body.NewUsername, body.CurrentPassword); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, ErrExists) {
			status = http.StatusConflict
		}
		http.Error(w, "could not change username", status)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleChangePassword(w http.ResponseWriter, r *http.Request, username string) {
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.ChangePassword(r.Context(), username, body.CurrentPassword, body.NewPassword); err != nil {
		http.Error(w, "could not change password", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleCreateToken(w http.ResponseWriter, r *http.Request, username string) {
	var body struct {
		Label string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	tok, meta, err := s.CreateAPIToken(r.Context(), username, body.Label)
	if err != nil {
		http.Error(w, "could not create token", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct {
		Token string       `json:"token"`
		Meta  APITokenView `json:"meta"`
	}{tok, meta})
}

func (s *Store) handleRevokeToken(w http.ResponseWriter, r *http.Request, username string) {
	rel := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, s.prefix), "/")
	id := strings.TrimPrefix(rel, "account/tokens/")
	if err := s.RevokeAPIToken(r.Context(), username, id); err != nil {
		http.Error(w, "could not revoke token", http.StatusBadRequest)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}
