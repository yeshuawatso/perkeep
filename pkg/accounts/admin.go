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

// CreateUser is the admin-only "add a user" action (distinct from any
// future public self-signup flow) -- caller must already be an admin.
func (s *Store) CreateUser(ctx context.Context, caller, username, password string) error {
	if err := s.requireAdmin(ctx, caller); err != nil {
		return err
	}
	_, err := s.CreateAccount(ctx, username, password)
	return err
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
