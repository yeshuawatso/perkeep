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
	"log"
	"net/http"
	"time"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/schema"
	"perkeep.org/pkg/search"
)

var (
	ErrForbidden = errors.New("accounts: forbidden")
	// ErrLastAdmin is returned by RevokeAdmin/DeleteUser when the action
	// would leave the server with zero administrators.
	ErrLastAdmin = errors.New("accounts: cannot remove the last administrator")
	// ErrSelfGrant is returned by GrantAdmin when caller == target --
	// nobody, admin or not, can grant themselves admin. See package docs.
	ErrSelfGrant = errors.New("accounts: cannot grant admin to yourself")
	// ErrSelfReset is returned by ResetPassword when caller == target.
	// Self-service ChangePassword's current-password check exists
	// precisely so a stolen bearer token alone (without also knowing the
	// password) can't permanently take over an account by changing it to
	// something only the attacker knows; letting ResetPassword target
	// yourself would bypass exactly that. Use ChangePassword instead.
	ErrSelfReset = errors.New("accounts: use change-password for your own account")
)

type UserSummary struct {
	Username string `json:"username"`
	IsAdmin  bool   `json:"isAdmin"`
}

func (s *Store) IsAdmin(ctx context.Context, username string) (bool, error) {
	pn, found, err := s.findAccount(ctx, username)
	if err != nil || !found {
		return false, err
	}
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return false, err
	}
	return pi.Attr.Get(attrAdmin) == "1", nil
}

// Caller is the resolved identity of an authenticated HTTP request. It's
// the one shared primitive every per-user enforcement layer added in
// Phase 2 (search, describe, pkg/server/ui.go, pkg/blobserver/handlers,
// raw blob storage) calls to decide "who is this, and are they admin" --
// see docs/multi-tenant-roadmap.md's Phase 2 section. The five enforcement
// sites stay genuinely separate code paths (that's unavoidable); only this
// identity decision is centralized, the same way requireAdmin below is
// already called individually from seven different methods rather than
// from one dispatcher.
type Caller struct {
	Username   string
	AccountRef blob.Ref
	IsAdmin    bool
	// Verified mirrors attrVerified's "absent/'1' means true" convention
	// (account.go) -- see NotVerifiedMessage for where this is enforced.
	Verified bool
}

// NotVerifiedMessage is the 403 body pkg/blobserver/handlers' upload paths
// send when a non-admin, unverified caller attempts any blob-storage
// mutation (see pkg/serverinit's ownershipHooks VerifiedFunc). Exported so
// both sides of that HTTP boundary -- and the frontend, which pattern-
// matches this exact text the same way it already special-cases
// ErrWeakPassword's -- agree on one string instead of two drifting copies.
const NotVerifiedMessage = "account not verified: check your email or request a new verification link"

// ResolveRequest extracts and verifies req's bearer token and resolves the
// full Caller, including AccountRef, admin, and verified status, in one
// call. Used by enforcement sites outside this package's own HTTP handlers;
// those use withUser/Identify instead (admin.go/handler.go), since they only
// need the username, not a pre-resolved AccountRef/IsAdmin/Verified.
func (s *Store) ResolveRequest(req *http.Request) (Caller, bool) {
	tok := BearerFromRequest(req)
	if tok == "" {
		return Caller{}, false
	}
	ctx := req.Context()
	ident, ok := s.Identify(ctx, tok)
	if !ok {
		return Caller{}, false
	}
	pn, found, err := s.findAccount(ctx, ident.Username)
	if err != nil || !found {
		return Caller{}, false
	}
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return Caller{}, false
	}
	return Caller{
		Username:   ident.Username,
		AccountRef: pn,
		IsAdmin:    pi.Attr.Get(attrAdmin) == "1",
		Verified:   pi.Attr.Get(attrVerified) != "0",
	}, true
}

// ResolveSearchCaller adapts ResolveRequest to pkg/search's own Caller
// type, satisfying its callerResolver interface structurally (pkg/search
// can't import this package back -- see its caller.go) so Store can be
// wired in as the "accounts" handler pkg/search.Handler.InitHandler looks
// up by type.
func (s *Store) ResolveSearchCaller(req *http.Request) (search.Caller, bool) {
	c, ok := s.ResolveRequest(req)
	if !ok {
		return search.Caller{}, false
	}
	return search.Caller{AccountRef: c.AccountRef, IsAdmin: c.IsAdmin}, true
}

func (s *Store) requireAdmin(ctx context.Context, caller string) error {
	ok, err := s.IsAdmin(ctx, caller)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	return nil
}

// adminCount counts current administrators -- used to enforce "there must
// always be at least one admin" before any revoke/delete.
func (s *Store) adminCount(ctx context.Context) (int, error) {
	refs, err := s.queryPermanodes(ctx, &search.Constraint{
		Logical: &search.LogicalConstraint{
			Op: "and",
			A:  &search.Constraint{Permanode: &search.PermanodeConstraint{Attr: "camliNodeType", Value: nodeTypeAccount}},
			B:  &search.Constraint{Permanode: &search.PermanodeConstraint{Attr: attrAdmin, Value: "1"}},
		},
	})
	if err != nil {
		return 0, err
	}
	return len(refs), nil
}

// ListUsers is admin-only: every account's username and admin status, for
// the Admin page's Users tab.
func (s *Store) ListUsers(ctx context.Context, caller string) ([]UserSummary, error) {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return nil, err
	}
	refs, err := s.queryPermanodes(ctx, &search.Constraint{
		Permanode: &search.PermanodeConstraint{Attr: "camliNodeType", Value: nodeTypeAccount},
	})
	if err != nil {
		return nil, err
	}
	out := make([]UserSummary, 0, len(refs))
	for _, ref := range refs {
		pi, err := s.describeOne(ctx, ref)
		if err != nil {
			continue
		}
		out = append(out, UserSummary{
			Username: pi.Attr.Get(attrUsername),
			IsAdmin:  pi.Attr.Get(attrAdmin) == "1",
		})
	}
	return out, nil
}

// CreateUser is the admin-only "add a user" action (distinct from
// self-signup, see signup.go's CreateSelfSignupAccount) -- caller must
// already be an admin. email is optional (an admin may create an account
// for someone with no address on file at all) -- when given, it lets that
// account use forgot-password later. Unlike self-signup, an admin-created
// account is always immediately verified: an admin already vouched for it,
// so there's no "confirm you own this inbox" step to gate on, and nothing
// about this phase should make an admin-created account newly unable to
// upload the moment it's created.
func (s *Store) CreateUser(ctx context.Context, caller, username, password, email string) error {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return err
	}
	if err := s.validatePassword(password); err != nil {
		return err
	}
	if email != "" {
		if err := validateEmail(email); err != nil {
			return err
		}
		if _, found, err := s.findAccountByEmail(ctx, email); err != nil {
			return err
		} else if found {
			return ErrEmailTaken
		}
	}
	pn, err := s.CreateAccount(ctx, username, password)
	if err != nil {
		return err
	}
	if err := s.setAttr(ctx, pn, attrVerified, "1"); err != nil {
		return err
	}
	if email == "" {
		return nil
	}
	for _, kv := range [][2]string{
		{attrEmail, email},
		{attrEmailLower, normalizeEmail(email)},
	} {
		if err := s.setAttr(ctx, pn, kv[0], kv[1]); err != nil {
			return err
		}
	}
	return nil
}

// DeleteUser issues a normal delete claim against the target's account
// permanode (same mechanism as deleting any other permanode -- the index
// already excludes deleted permanodes from permanode-attribute lookups
// like findAccount, so this takes effect immediately for login).
func (s *Store) DeleteUser(ctx context.Context, caller, target string) error {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return err
	}
	pn, found, err := s.findAccount(ctx, target)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if err := s.rejectIfLastAdmin(ctx, pn); err != nil {
		return err
	}
	_, err = s.upload(ctx, schema.NewDeleteClaim(pn))
	return err
}

// GrantAdmin: caller must already be an admin, and -- your rule, applying
// to admins and non-admins alike -- can never target themselves. Only a
// *different* admin can grant someone admin.
func (s *Store) GrantAdmin(ctx context.Context, caller, target string) error {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return err
	}
	if normalizeUsername(caller) == normalizeUsername(target) {
		return ErrSelfGrant
	}
	pn, found, err := s.findAccount(ctx, target)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	return s.setAttr(ctx, pn, attrAdmin, "1")
}

// RevokeAdmin may target the caller themselves (an admin stepping down)
// or another admin, but never brings the admin count to zero.
func (s *Store) RevokeAdmin(ctx context.Context, caller, target string) error {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return err
	}
	pn, found, err := s.findAccount(ctx, target)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if err := s.rejectIfLastAdmin(ctx, pn); err != nil {
		return err
	}
	return s.setAttr(ctx, pn, attrAdmin, "0")
}

// rejectIfLastAdmin returns ErrLastAdmin if pn is currently an admin and
// is the server's only one -- shared by RevokeAdmin and DeleteUser, since
// both would otherwise leave zero administrators.
func (s *Store) rejectIfLastAdmin(ctx context.Context, pn blob.Ref) error {
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return err
	}
	if pi.Attr.Get(attrAdmin) != "1" {
		return nil // not an admin at all -- nothing to protect
	}
	n, err := s.adminCount(ctx)
	if err != nil {
		return err
	}
	if n <= 1 {
		return ErrLastAdmin
	}
	return nil
}

// backfillUsernameLower is a one-time, self-healing migration run from
// InitHandler on every startup: any account permanode created before
// attrUsernameLower existed (e.g. the already-deployed bootstrap account)
// gets it set from its current username, with no manual migration step.
func (s *Store) backfillUsernameLower(ctx context.Context) error {
	refs, err := s.queryPermanodes(ctx, &search.Constraint{
		Permanode: &search.PermanodeConstraint{Attr: "camliNodeType", Value: nodeTypeAccount},
	})
	if err != nil {
		return err
	}
	for _, ref := range refs {
		pi, err := s.describeOne(ctx, ref)
		if err != nil {
			return err
		}
		if pi.Attr.Get(attrUsernameLower) != "" {
			continue
		}
		username := pi.Attr.Get(attrUsername)
		if username == "" {
			continue
		}
		if err := s.setAttr(ctx, ref, attrUsernameLower, normalizeUsername(username)); err != nil {
			return err
		}
	}
	return nil
}

// backfillOwnership is a one-time, self-healing migration run from
// InitHandler on every startup, mirroring backfillUsernameLower above:
// every permanode uploaded before Phase 2's ownership stamping existed
// has no AccountRefAttr at all, and would otherwise be invisible to every
// owner-filtered enforcement layer forever once those land. Those
// permanodes get assigned to the bootstrap account -- mechanical; which
// account is actually the *right* one for a given server's real
// pre-existing data is a human judgment call for the operator, not this
// code (see docs/multi-tenant-roadmap.md's Phase 2 section, which flags
// this explicitly for hands-on confirmation on each install).
//
// Account and API-token permanodes are deliberately skipped -- they're
// accounts infrastructure, not per-user content. No enforcement layer is
// expected to ever apply owner-filtering to them (pkg/accounts' own
// internal search/describe calls run with no caller in request context,
// bypassing owner-filtering entirely by design, the same way
// backfillUsernameLower's own query is unaffected by it), but stamping an
// arbitrary owner on them would still be semantically wrong.
//
// The query below asks the index for permanodes with zero values for
// AccountRefAttr, rather than describing every permanode on the server
// and filtering client-side (as backfillUsernameLower does, acceptable
// there since the account-permanode set is tiny) -- after the first
// successful run, new permanodes are always stamped synchronously at
// upload time (see pkg/blobserver/handlers.StampFunc), so this set should
// be small or empty on every subsequent startup, not a full-corpus scan.
func (s *Store) backfillOwnership(ctx context.Context) error {
	if s.bootstrapUsername == "" {
		return nil
	}
	bootstrapPN, found, err := s.findAccount(ctx, s.bootstrapUsername)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	zero := int64(0)
	refs, err := s.queryPermanodes(ctx, &search.Constraint{
		Permanode: &search.PermanodeConstraint{
			Attr:     AccountRefAttr,
			NumValue: &search.IntConstraint{Equals: &zero},
		},
	})
	if err != nil {
		return err
	}
	var backfilled int
	for _, ref := range refs {
		pi, err := s.describeOne(ctx, ref)
		if err != nil {
			return err
		}
		switch pi.Attr.Get("camliNodeType") {
		case nodeTypeAccount, nodeTypeAPIToken:
			continue
		}
		if pi.Attr.Get(AccountRefAttr) != "" {
			continue // already stamped since the query ran; race with a concurrent upload
		}
		if err := s.setAttr(ctx, ref, AccountRefAttr, bootstrapPN.String()); err != nil {
			return err
		}
		backfilled++
	}
	if backfilled > 0 {
		log.Printf("accounts: backfilled ownership (%s) for %d pre-existing permanode(s) to %q", AccountRefAttr, backfilled, s.bootstrapUsername)
	}
	return nil
}

// ResetPassword lets an admin set a new password for a DIFFERENT user
// without knowing (or being asked for) their current one -- the forgot-a-
// password-right-after-creating-the-account case. Never targets the
// caller themselves; see ErrSelfReset.
func (s *Store) ResetPassword(ctx context.Context, caller, target, newPassword string) error {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return err
	}
	if normalizeUsername(caller) == normalizeUsername(target) {
		return ErrSelfReset
	}
	if err := s.validatePassword(newPassword); err != nil {
		return err
	}
	pn, found, err := s.findAccount(ctx, target)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	return s.setPassword(ctx, pn, newPassword)
}

// Impersonate mints a session token for target directly, no password
// check -- it's an explicit admin action, not a login. The resulting
// token always records who issued it (see tokenClaims.ImpersonatedBy),
// so it's never silently indistinguishable from target's own login.
func (s *Store) Impersonate(ctx context.Context, caller, target string) (string, error) {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return "", err
	}
	if _, found, err := s.findAccount(ctx, target); err != nil {
		return "", err
	} else if !found {
		return "", ErrNotFound
	}
	return s.signToken(tokenClaims{
		Sub:            target,
		Kind:           kindSession,
		Exp:            time.Now().Add(24 * time.Hour).Unix(),
		ImpersonatedBy: caller,
	})
}
