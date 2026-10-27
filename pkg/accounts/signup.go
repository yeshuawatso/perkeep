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
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"perkeep.org/pkg/blob"
)

var (
	// ErrSignupDisabled is returned by CreateSelfSignupAccount when the
	// server hasn't opted into self-signup (allowSelfSignup) or hasn't
	// configured a baseURL -- see Store.SelfSignupEnabled.
	ErrSignupDisabled = errors.New("accounts: self-signup is not enabled on this server")
	ErrInvalidEmail   = errors.New("accounts: invalid email address")
	// ErrEmailTaken mirrors ErrExists, but for the email uniqueness index
	// (attrEmailLower) rather than the username one.
	ErrEmailTaken = errors.New("accounts: email address is already in use")
	// ErrInvalidToken/ErrTokenExpired cover both token kinds this file
	// issues (verify-email, reset-password): a malformed/wrong-kind token,
	// or a well-formed one whose signature/expiry/fingerprint no longer
	// checks out (see verifyResetPasswordToken's single-use fingerprint).
	ErrInvalidToken     = errors.New("accounts: invalid or expired link")
	ErrTokenExpired     = errors.New("accounts: this link has already been used or has expired")
	ErrAlreadyVerified  = errors.New("accounts: account is already verified")
	ErrNoEmailOnFile    = errors.New("accounts: no email address on file for this account")
)

const (
	verifyEmailTTL   = 24 * time.Hour
	resetPasswordTTL = 1 * time.Hour
)

var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func validateEmail(email string) error {
	if !emailRe.MatchString(email) {
		return ErrInvalidEmail
	}
	return nil
}

// normalizeEmail is the uniqueness/lookup key for email addresses -- same
// case-insensitive reasoning as normalizeUsername.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func (s *Store) findAccountByEmail(ctx context.Context, email string) (blob.Ref, bool, error) {
	return s.findPermanodeByAttr(ctx, attrEmailLower, normalizeEmail(email))
}

// SelfSignupEnabled reports whether self-signup is actually usable: the
// operator must have both opted in ("allowSelfSignup" in server-config.json)
// and configured an absolute baseURL. Building a verification link from the
// request's own Host header instead would let anyone forge a signup email
// whose link points at a server of their choosing -- so this fails closed,
// not just hidden in the UI. GET /auth/signup-enabled (handler.go) is what
// the frontend actually checks before showing the signup page/link.
func (s *Store) SelfSignupEnabled() bool {
	return s.allowSelfSignup && s.baseURL != ""
}

// CreateSelfSignupAccount is the one path in this package that produces an
// unverified account (attrVerified="0") -- see attrVerified's doc
// (account.go) for why that's the opposite of CreateUser's admin path.
func (s *Store) CreateSelfSignupAccount(ctx context.Context, username, email, password string) (blob.Ref, error) {
	if !s.SelfSignupEnabled() {
		return blob.Ref{}, ErrSignupDisabled
	}
	if err := validateEmail(email); err != nil {
		return blob.Ref{}, err
	}
	if err := s.validatePassword(password); err != nil {
		return blob.Ref{}, err
	}
	if _, found, err := s.findAccountByEmail(ctx, email); err != nil {
		return blob.Ref{}, err
	} else if found {
		return blob.Ref{}, ErrEmailTaken
	}
	pn, err := s.CreateAccount(ctx, username, password)
	if err != nil {
		return blob.Ref{}, err
	}
	for _, kv := range [][2]string{
		{attrEmail, email},
		{attrEmailLower, normalizeEmail(email)},
		{attrVerified, "0"},
	} {
		if err := s.setAttr(ctx, pn, kv[0], kv[1]); err != nil {
			return blob.Ref{}, err
		}
	}
	return pn, nil
}

// MailTarget is what RequestPasswordReset/ResendVerification hand back to
// the HTTP handler (handler.go) to actually send -- splitting "decide who,
// if anyone, should receive a link, and mint its token" (here, pure
// account-model logic) from "render a template and talk SMTP"
// (sendNotification, below), the same way Phase 3's handleTestSend keeps
// message-building separate from Store methods.
type MailTarget struct {
	Username string
	Email    string
	Token    string
}

// RequestPasswordReset looks up emailOrUsername (tried as an email first,
// then as a username) and, if a match with an email on file exists, mints
// a reset-password token. The HTTP handler must always respond the same
// way regardless of whether target is nil -- a response that distinguishes
// "no such account" from "link sent" would let anyone enumerate registered
// emails/usernames one guess at a time.
func (s *Store) RequestPasswordReset(ctx context.Context, emailOrUsername string) (*MailTarget, error) {
	pn, found, err := s.findAccountByEmail(ctx, emailOrUsername)
	if err != nil {
		return nil, err
	}
	if !found {
		pn, found, err = s.findAccount(ctx, emailOrUsername)
		if err != nil {
			return nil, err
		}
	}
	if !found {
		return nil, nil
	}
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return nil, err
	}
	addr := pi.Attr.Get(attrEmail)
	if addr == "" {
		return nil, nil
	}
	tok, err := s.signResetPasswordToken(ctx, pn)
	if err != nil {
		return nil, err
	}
	return &MailTarget{Username: pi.Attr.Get(attrUsername), Email: addr, Token: tok}, nil
}

// ResetPasswordWithToken redeems a reset-password token minted by
// RequestPasswordReset. See verifyResetPasswordToken for why redeeming it
// once makes every other outstanding copy of the same link invalid.
func (s *Store) ResetPasswordWithToken(ctx context.Context, token, newPassword string) error {
	pn, err := s.verifyResetPasswordToken(ctx, token)
	if err != nil {
		return err
	}
	if err := s.validatePassword(newPassword); err != nil {
		return err
	}
	return s.setPassword(ctx, pn, newPassword)
}

// VerifyEmail redeems a verify-email token minted at signup (or by
// ResendVerification), setting attrVerified="1" on the account it names.
func (s *Store) VerifyEmail(ctx context.Context, token string) error {
	pn, err := s.verifyVerifyEmailToken(token)
	if err != nil {
		return err
	}
	return s.setAttr(ctx, pn, attrVerified, "1")
}

// ResendVerification re-issues a verify-email token for caller's own
// account -- self-service, so an unverified user who never received (or
// lost) the first email isn't stuck forever. No-ops with a clear error if
// already verified or if there's no email on file to send to at all
// (shouldn't normally happen -- every unverified account came from
// CreateSelfSignupAccount, which requires one).
func (s *Store) ResendVerification(ctx context.Context, username string) (*MailTarget, error) {
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
	if pi.Attr.Get(attrVerified) != "0" {
		return nil, ErrAlreadyVerified
	}
	addr := pi.Attr.Get(attrEmail)
	if addr == "" {
		return nil, ErrNoEmailOnFile
	}
	tok, err := s.signVerifyEmailToken(pn)
	if err != nil {
		return nil, err
	}
	return &MailTarget{Username: username, Email: addr, Token: tok}, nil
}

func (s *Store) signVerifyEmailToken(accountRef blob.Ref) (string, error) {
	return s.signToken(tokenClaims{
		Sub:  accountRef.String(),
		Kind: kindVerifyEmail,
		Exp:  time.Now().Add(verifyEmailTTL).Unix(),
	})
}

// verifyVerifyEmailToken validates tokenString as a verify-email token
// (right kind, not expired, signature checks out -- verifyToken already
// does the latter two) and returns the account permanode ref it names.
func (s *Store) verifyVerifyEmailToken(tokenString string) (blob.Ref, error) {
	c, err := s.verifyToken(tokenString)
	if err != nil {
		return blob.Ref{}, ErrInvalidToken
	}
	if c.Kind != kindVerifyEmail {
		return blob.Ref{}, ErrInvalidToken
	}
	ref, ok := blob.Parse(c.Sub)
	if !ok {
		return blob.Ref{}, ErrInvalidToken
	}
	return ref, nil
}

func (s *Store) signResetPasswordToken(ctx context.Context, accountRef blob.Ref) (string, error) {
	fp, err := s.passwordFingerprint(ctx, accountRef)
	if err != nil {
		return "", err
	}
	return s.signToken(tokenClaims{
		Sub:      accountRef.String(),
		Kind:     kindResetPassword,
		Exp:      time.Now().Add(resetPasswordTTL).Unix(),
		PwHashFP: fp,
	})
}

// verifyResetPasswordToken validates tokenString as a reset-password
// token and returns the account permanode ref it names. Beyond the usual
// signature/expiry/kind checks, it recomputes the account's current
// password fingerprint and rejects the token if it no longer matches the
// one captured at issuance (tokenClaims.PwHashFP) -- redeeming a reset
// link changes the password, which changes the fingerprint, which
// invalidates every other outstanding copy of the same link. This is what
// gives these stateless, hand-rolled JWTs single-use semantics without a
// stored-token table.
func (s *Store) verifyResetPasswordToken(ctx context.Context, tokenString string) (blob.Ref, error) {
	c, err := s.verifyToken(tokenString)
	if err != nil {
		return blob.Ref{}, ErrInvalidToken
	}
	if c.Kind != kindResetPassword {
		return blob.Ref{}, ErrInvalidToken
	}
	ref, ok := blob.Parse(c.Sub)
	if !ok {
		return blob.Ref{}, ErrInvalidToken
	}
	fp, err := s.passwordFingerprint(ctx, ref)
	if err != nil {
		return blob.Ref{}, err
	}
	if fp != c.PwHashFP {
		return blob.Ref{}, ErrTokenExpired
	}
	return ref, nil
}

func (s *Store) passwordFingerprint(ctx context.Context, accountRef blob.Ref) (string, error) {
	pi, err := s.describeOne(ctx, accountRef)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(pi.Attr.Get("passwordHashRef")))
	return hex.EncodeToString(sum[:8]), nil
}

// humanTTL renders a duration the way the email templates' {{.ExpiresIn}}
// expects -- only ever called with the two constants above, so this
// doesn't need to handle arbitrary durations.
func humanTTL(d time.Duration) string {
	h := int(d.Hours())
	if h == 1 {
		return "1 hour"
	}
	return fmt.Sprintf("%d hours", h)
}
