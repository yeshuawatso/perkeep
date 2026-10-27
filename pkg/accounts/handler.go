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
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"perkeep.org/pkg/messaging"
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
	case rel == "password-policy" && r.Method == http.MethodGet:
		s.handlePasswordPolicy(w, r)
	case rel == "signup-enabled" && r.Method == http.MethodGet:
		s.handleSignupEnabled(w, r)
	case rel == "signup" && r.Method == http.MethodPost:
		s.handleSignup(w, r)
	case rel == "verify-email" && r.Method == http.MethodPost:
		s.handleVerifyEmail(w, r)
	case rel == "resend-verification" && r.Method == http.MethodPost:
		s.withUser(w, r, s.handleResendVerification)
	case rel == "forgot-password" && r.Method == http.MethodPost:
		s.handleForgotPassword(w, r)
	case rel == "reset-password" && r.Method == http.MethodPost:
		s.handleResetPasswordToken(w, r)
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
	case strings.HasPrefix(rel, "admin/users/") && strings.HasSuffix(rel, "/reset-password") && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleResetPassword)
	case strings.HasPrefix(rel, "admin/users/") && r.Method == http.MethodDelete:
		s.withAdminUser(w, r, s.handleDeleteUser)
	case rel == "admin/notifications/smtp-config" && r.Method == http.MethodGet:
		s.withAdminUser(w, r, s.handleGetSMTPConfig)
	case rel == "admin/notifications/smtp-config" && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleSetSMTPConfig)
	case rel == "admin/notifications/test-send" && r.Method == http.MethodPost:
		s.withAdminUser(w, r, s.handleTestSend)
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

// BearerFromRequest extracts the bearer token from r's Authorization
// header or, for requests that can't set custom headers (the search
// WebSocket upgrade, directly-loaded thumbnail/download URLs), its
// access_token query parameter. Exported so other packages needing the
// same extraction (pkg/auth/jwtauth.go, pkg/search's per-request caller
// resolution) share one implementation instead of drifting copies.
func BearerFromRequest(r *http.Request) string {
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
	tok := BearerFromRequest(r)
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
	if s.rateLimited(w, r, "login") {
		return
	}
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

// handlePasswordPolicy is deliberately unauthenticated, like handleLogin --
// see PasswordPolicyView's doc comment for why a future self-signup page
// needs this before any session exists.
func (s *Store) handlePasswordPolicy(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.PasswordPolicy())
}

// requireBaseURL writes a 503 and returns false if no baseURL is
// configured -- signup/verify-email/forgot-password links all need an
// absolute, operator-set URL (see Store.SelfSignupEnabled's doc for why
// deriving one from the request's Host header instead would be unsafe).
// This is server-wide configuration, not account-specific, so reporting
// it plainly carries no account-enumeration risk.
func (s *Store) requireBaseURL(w http.ResponseWriter) bool {
	if s.baseURL != "" {
		return true
	}
	http.Error(w, "email links are not available: the server operator has not configured a base URL", http.StatusServiceUnavailable)
	return false
}

// uiURL builds an absolute link into the React SPA for an emailed link
// (verify-email/reset-password). The UI is always mounted at "/ui/" --
// hardcoded the same way in pkg/serverinit/genconfig.go's addUIConfig and
// pkg/server/root.go's own "/ui/" redirect, never configurable -- and
// s.baseURL never includes a path (enforced where baseURL is parsed), so
// a link built as baseURL+rel without this prefix lands on the root
// handler instead of the SPA and 404s.
func (s *Store) uiURL(rel string) string {
	return s.baseURL + "/ui/" + rel
}

// sendNotification renders templateName (pkg/messaging's embedded
// templates) and best-effort sends it to "to" using whatever SMTP config
// is currently saved (see notifications.go). Failure is only logged, never
// returned to the caller -- signup/resend-verification/forgot-password
// must never fail outright just because the server's mail setup is
// broken or unconfigured; the admin Notifications tab's own test-send
// button is where that gets diagnosed directly.
func (s *Store) sendNotification(ctx context.Context, templateName, to string, data any) {
	cfg, err := messaging.LoadConfig()
	if err != nil {
		log.Printf("accounts: not sending %q to %s: loading SMTP config: %v", templateName, to, err)
		return
	}
	if cfg.Host == "" {
		log.Printf("accounts: not sending %q to %s: SMTP is not configured", templateName, to)
		return
	}
	msg, err := messaging.Render(templateName, data)
	if err != nil {
		log.Printf("accounts: rendering %q: %v", templateName, err)
		return
	}
	msg.To = to
	if err := (messaging.SMTPSender{Config: cfg}).Send(ctx, msg); err != nil {
		log.Printf("accounts: sending %q to %s: %v", templateName, to, err)
	}
}

func (s *Store) handleSignupEnabled(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, struct {
		Enabled bool `json:"enabled"`
	}{s.SelfSignupEnabled()})
}

// handleSignup is deliberately unauthenticated, like handleLogin. On
// success it logs the new account in immediately (unverified accounts are
// allowed to use the server, just not to upload -- see
// pkg/blobserver/handlers' VerifiedFunc) and best-effort sends a
// verify-email message; a failed send never blocks signup success, since
// the resend-verification button covers that case.
func (s *Store) handleSignup(w http.ResponseWriter, r *http.Request) {
	if s.rateLimited(w, r, "signup") {
		return
	}
	var body struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	pn, err := s.CreateSelfSignupAccount(r.Context(), body.Username, body.Email, body.Password)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if tok, err := s.signVerifyEmailToken(pn); err != nil {
		log.Printf("accounts: issuing verify-email token for new signup %q: %v", body.Username, err)
	} else {
		s.sendNotification(r.Context(), "verify-email", body.Email, struct {
			Username  string
			VerifyURL string
			ExpiresIn string
		}{body.Username, s.uiURL("verify-email?token=" + url.QueryEscape(tok)), humanTTL(verifyEmailTTL)})
	}
	sessionTok, err := s.signToken(tokenClaims{
		Sub:  body.Username,
		Kind: kindSession,
		Exp:  time.Now().Add(24 * time.Hour).Unix(),
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, struct {
		Token    string `json:"token"`
		Username string `json:"username"`
	}{sessionTok, body.Username})
}

func (s *Store) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.VerifyEmail(r.Context(), body.Token); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleResendVerification(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if s.rateLimited(w, r, "resend-verification") {
		return
	}
	if !s.requireBaseURL(w) {
		return
	}
	target, err := s.ResendVerification(r.Context(), ident.Username)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.sendNotification(r.Context(), "verify-email", target.Email, struct {
		Username  string
		VerifyURL string
		ExpiresIn string
	}{target.Username, s.uiURL("verify-email?token=" + url.QueryEscape(target.Token)), humanTTL(verifyEmailTTL)})
	writeJSON(w, struct{ OK bool }{true})
}

// handleForgotPassword always responds the same way whether or not a
// matching account was found -- see RequestPasswordReset's doc on
// account-enumeration.
func (s *Store) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	if s.rateLimited(w, r, "forgot-password") {
		return
	}
	if !s.requireBaseURL(w) {
		return
	}
	var body struct {
		EmailOrUsername string `json:"emailOrUsername"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	target, err := s.RequestPasswordReset(r.Context(), body.EmailOrUsername)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if target != nil {
		s.sendNotification(r.Context(), "forgot-password", target.Email, struct {
			Username  string
			ResetURL  string
			ExpiresIn string
		}{target.Username, s.uiURL("reset-password?token=" + url.QueryEscape(target.Token)), humanTTL(resetPasswordTTL)})
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleResetPasswordToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.ResetPasswordWithToken(r.Context(), body.Token, body.NewPassword); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
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
		// Unlike the generic message this replaced, the real error text is
		// shown here on purpose: both possible causes (wrong current
		// password, or a configured password policy's description) are
		// safe to display and are exactly what the person needs to fix.
		status := http.StatusBadRequest
		if errors.Is(err, ErrNotFound) {
			status = http.StatusNotFound
		}
		http.Error(w, err.Error(), status)
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
		writeStoreError(w, err)
		return
	}
	writeJSON(w, users)
}

func (s *Store) handleCreateUser(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.CreateUser(r.Context(), ident.Username, body.Username, body.Password, body.Email); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleDeleteUser(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if err := s.DeleteUser(r.Context(), ident.Username, s.adminUserTarget(r)); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleGrantAdmin(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if err := s.GrantAdmin(r.Context(), ident.Username, s.adminUserTarget(r)); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleRevokeAdmin(w http.ResponseWriter, r *http.Request, ident *Identity) {
	if err := s.RevokeAdmin(r.Context(), ident.Username, s.adminUserTarget(r)); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

func (s *Store) handleImpersonate(w http.ResponseWriter, r *http.Request, ident *Identity) {
	tok, err := s.Impersonate(r.Context(), ident.Username, s.adminUserTarget(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct {
		Token string `json:"token"`
	}{tok})
}

func (s *Store) handleResetPassword(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		NewPassword string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.ResetPassword(r.Context(), ident.Username, s.adminUserTarget(r), body.NewPassword); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

// writeStoreError maps this package's sentinel errors to the right HTTP
// status instead of flattening everything to 400/500 -- callers (the Admin
// page, and now signup/verify-email/forgot-password/reset-password) tell
// these apart (e.g. "last admin" vs. "not found"). Originally named
// writeAdminError, back when every caller was admin-only.
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, ErrExists), errors.Is(err, ErrEmailTaken):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, ErrLastAdmin), errors.Is(err, ErrSelfGrant), errors.Is(err, ErrSelfReset), errors.Is(err, ErrWeakPassword),
		errors.Is(err, ErrInvalidEmail), errors.Is(err, ErrSignupDisabled), errors.Is(err, ErrAlreadyVerified), errors.Is(err, ErrNoEmailOnFile):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, ErrInvalidToken), errors.Is(err, ErrTokenExpired):
		http.Error(w, err.Error(), http.StatusUnauthorized)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
