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
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"perkeep.org/pkg/blob"
)

const (
	nodeTypeAccount  = "account"
	nodeTypeAPIToken = "apitoken"

	attrUsername      = "username"      // display casing, as the user chose it
	attrUsernameLower = "usernameLower" // normalizeUsername(username) -- the real lookup/uniqueness key
	attrAdmin         = "admin"         // "1" or absent; see admin.go
)

// AccountRefAttr is the permanode attribute recording which account's
// permanode owns a given permanode -- stamped synchronously, server-side,
// at upload time, using the uploader's identity from that same HTTP
// request (see Store.StampOwnership, permanode.go). It is never a
// client-settable claim: pkg/blobserver/handlers' upload paths reject any
// client-submitted claim naming this attribute directly (see their
// ReservedAttrFunc), since claims are signed by the server's own single
// GPG identity regardless of which logged-in user issued them, so a
// claim's signature alone can't prove which user is making it. Its value
// is the owning account's permanode ref (blob.Ref.String()), not the
// username, since usernames can be renamed (ChangeUsername) or
// deleted/recreated but a permanode ref is durable. Exported so other
// packages (pkg/serverinit, and later the search/describe/ui.go/raw-blob
// enforcement layers) can reference the same attribute name instead of
// duplicating the literal string. See docs/multi-tenant-roadmap.md's
// Phase 2 section for the full design.
const AccountRefAttr = "camliAccountRef"

var (
	ErrNotFound    = errors.New("accounts: not found")
	ErrExists      = errors.New("accounts: already exists")
	ErrBadPassword = errors.New("accounts: incorrect password")
	// ErrWeakPassword is returned by validatePassword (wrapped with the
	// configured policy's plain-language description) when a new password
	// fails the server's optional passwordPolicyPattern. See
	// newPasswordPolicy and Store.PasswordPolicy.
	ErrWeakPassword = errors.New("accounts: password does not meet requirements")
)

// passwordPolicy is the server's optional password-strength rule, set via
// the "accounts" handler's passwordPolicyPattern/passwordPolicyDescription
// config keys (see Store.newFromConfig). There is no built-in notion of
// "strong" -- the operator supplies an arbitrary regex (Go/RE2 syntax) that
// a new password must match, e.g. `^.{12,}$` for "at least 12 characters".
// That's deliberately permissive (an operator could configure something
// that matches everything) -- it's their server. The description is
// required whenever a pattern is set because there's no way to turn an
// arbitrary regex back into English for the person typing a password; the
// operator has to supply the explanation themselves, and both the HTTP 400
// on failure and the Admin/Account page hint text under the password field
// show it verbatim.
type passwordPolicy struct {
	pattern     *regexp.Regexp
	description string
}

func newPasswordPolicy(pattern, description string) (*passwordPolicy, error) {
	if pattern == "" {
		return nil, nil
	}
	if strings.TrimSpace(description) == "" {
		return nil, errors.New("accounts: passwordPolicyDescription is required when passwordPolicyPattern is set")
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("accounts: invalid passwordPolicyPattern: %w", err)
	}
	return &passwordPolicy{pattern: re, description: description}, nil
}

// PasswordPolicyView is what GET /auth/password-policy returns -- intentionally
// unauthenticated (like /auth/login) since a future self-signup page (see
// docs/multi-tenant-roadmap.md Phase 4) will need it before the person has
// any session at all. An empty struct means "no policy configured", not
// "empty password required".
type PasswordPolicyView struct {
	Pattern     string `json:"pattern,omitempty"`
	Description string `json:"description,omitempty"`
}

// PasswordPolicy exposes the configured policy (if any) for clients to
// display and best-effort pre-validate against. The pattern is Go/RE2
// syntax; most simple length/character-class patterns an operator would
// actually write also work as a JS RegExp, but RE2-only constructs (no
// backreferences, no lookaround, inline flags like "(?i)") don't -- the
// frontend falls back to showing just the description when construction
// throws. validatePassword below, not this preview, is the real check.
func (s *Store) PasswordPolicy() PasswordPolicyView {
	if s.passwordPolicy == nil {
		return PasswordPolicyView{}
	}
	return PasswordPolicyView{
		Pattern:     s.passwordPolicy.pattern.String(),
		Description: s.passwordPolicy.description,
	}
}

// validatePassword is called by every path that sets a password in
// response to an HTTP request (ChangePassword, admin.go's CreateUser and
// ResetPassword) -- deliberately NOT by CreateAccount itself, so the
// server-config.json-supplied bootstrap password (set once, by the
// operator, possibly before any policy existed) can never fail server
// startup; only end-user/admin-supplied passwords are policed.
func (s *Store) validatePassword(password string) error {
	if s.passwordPolicy == nil {
		return nil
	}
	if !s.passwordPolicy.pattern.MatchString(password) {
		return fmt.Errorf("%w: %s", ErrWeakPassword, s.passwordPolicy.description)
	}
	return nil
}

// AccountView and APITokenView are what the HTTP handlers (handler.go)
// serialize to the Account page -- never the password/token hashes
// themselves, which never leave readBlobContent/bcrypt.
type AccountView struct {
	Username       string         `json:"username"`
	IsAdmin        bool           `json:"isAdmin"`
	ImpersonatedBy string         `json:"impersonatedBy,omitempty"`
	APITokens      []APITokenView `json:"apiTokens"`
}

type APITokenView struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
}

// normalizeUsername is the uniqueness/lookup key for usernames -- case
// insensitive ("Alice" and "alice" can't both exist), so comparisons and
// the attrUsernameLower index always go through this, never a raw
// strings.EqualFold check, to avoid the two drifting apart.
func normalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func (s *Store) findAccount(ctx context.Context, username string) (blob.Ref, bool, error) {
	return s.findPermanodeByAttr(ctx, attrUsernameLower, normalizeUsername(username))
}

// CreateAccount creates a new account permanode. There is no public
// "sign up" endpoint yet -- this is called for the one-time bootstrap
// account (see InitHandler) and, with an admin-only caller check, by
// CreateUser (admin.go).
func (s *Store) CreateAccount(ctx context.Context, username, password string) (blob.Ref, error) {
	if _, found, err := s.findAccount(ctx, username); err != nil {
		return blob.Ref{}, err
	} else if found {
		return blob.Ref{}, ErrExists
	}
	hashRef, err := s.hashAndStore(ctx, password)
	if err != nil {
		return blob.Ref{}, err
	}
	pn, err := s.newPermanode(ctx)
	if err != nil {
		return blob.Ref{}, err
	}
	for _, kv := range [][2]string{
		{"camliNodeType", nodeTypeAccount},
		{attrUsername, username},
		{attrUsernameLower, normalizeUsername(username)},
		{"passwordHashRef", hashRef.String()},
	} {
		if err := s.setAttr(ctx, pn, kv[0], kv[1]); err != nil {
			return blob.Ref{}, err
		}
	}
	return pn, nil
}

func (s *Store) hashAndStore(ctx context.Context, password string) (blob.Ref, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return blob.Ref{}, err
	}
	return s.writeSecretBlob(ctx, string(hash))
}

func (s *Store) checkPassword(ctx context.Context, accountPN blob.Ref, password string) error {
	pi, err := s.describeOne(ctx, accountPN)
	if err != nil {
		return err
	}
	hashRef, ok := blob.Parse(pi.Attr.Get("passwordHashRef"))
	if !ok {
		return fmt.Errorf("accounts: account %s has no password hash", accountPN)
	}
	hash, err := s.readBlobContent(ctx, hashRef)
	if err != nil {
		return err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return ErrBadPassword
	}
	return nil
}

// Login verifies username/password and returns a new session JWT.
func (s *Store) Login(ctx context.Context, username, password string) (string, error) {
	pn, found, err := s.findAccount(ctx, username)
	if err != nil {
		return "", err
	}
	if !found {
		// Deliberately the same error as a wrong password: don't let a
		// login attempt distinguish "no such user" from "wrong password".
		return "", ErrBadPassword
	}
	if err := s.checkPassword(ctx, pn, password); err != nil {
		return "", err
	}
	return s.signToken(tokenClaims{
		Sub:  username,
		Kind: kindSession,
		Exp:  time.Now().Add(24 * time.Hour).Unix(),
	})
}

func (s *Store) GetAccount(ctx context.Context, username string) (*AccountView, error) {
	pn, found, err := s.findAccount(ctx, username)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrNotFound
	}
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return nil, err
	}
	tokens, err := s.listAPITokens(ctx, pn)
	if err != nil {
		return nil, err
	}
	return &AccountView{
		Username:  pi.Attr.Get(attrUsername),
		IsAdmin:   pi.Attr.Get(attrAdmin) == "1",
		APITokens: tokens,
	}, nil
}

func (s *Store) ChangeUsername(ctx context.Context, currentUsername, newUsername, currentPassword string) error {
	pn, found, err := s.findAccount(ctx, currentUsername)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if err := s.checkPassword(ctx, pn, currentPassword); err != nil {
		return err
	}
	if normalizeUsername(newUsername) != normalizeUsername(currentUsername) {
		if _, taken, err := s.findAccount(ctx, newUsername); err != nil {
			return err
		} else if taken {
			return ErrExists
		}
	}
	if err := s.setAttr(ctx, pn, attrUsername, newUsername); err != nil {
		return err
	}
	return s.setAttr(ctx, pn, attrUsernameLower, normalizeUsername(newUsername))
}

func (s *Store) ChangePassword(ctx context.Context, username, currentPassword, newPassword string) error {
	pn, found, err := s.findAccount(ctx, username)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if err := s.checkPassword(ctx, pn, currentPassword); err != nil {
		return err
	}
	if err := s.validatePassword(newPassword); err != nil {
		return err
	}
	return s.setPassword(ctx, pn, newPassword)
}

// setPassword hashes and stores newPassword on an already-resolved
// account permanode -- shared by ChangePassword (self-service, requires
// the current password above) and admin.go's ResetPassword (admin-only,
// no current-password check at all).
func (s *Store) setPassword(ctx context.Context, pn blob.Ref, newPassword string) error {
	hashRef, err := s.hashAndStore(ctx, newPassword)
	if err != nil {
		return err
	}
	return s.setAttr(ctx, pn, "passwordHashRef", hashRef.String())
}
