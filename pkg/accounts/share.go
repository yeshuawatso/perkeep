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
	"sort"
	"strings"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/search"
)

// Phase 5 (docs/multi-tenant-roadmap.md): sharing itself (creating/
// listing/revoking a share claim) is entirely client-driven, the same way
// every other claim/permanode mutation in this codebase is -- see
// server/perkeepd/ui-src/src/api/client.js's createShareClaim/
// createPermanode/deletePermanode, now safe to keep exactly as-is once
// classifyUpload's share/delete ownership gap (upload.go, ownercache.go)
// is closed. The only piece that genuinely needs a server-side route is
// sending the "someone shared something with you" email, since only the
// server can talk SMTP -- these are its supporting lookups.

var (
	// ErrRecipientNotFound covers both ResolveRecipient and the
	// shares/notify path: no account matches the given username/email.
	ErrRecipientNotFound = errors.New("accounts: no matching account found")
	// ErrRecipientNoEmail is distinct from ErrRecipientNotFound: the
	// account exists (so showing this instead doesn't leak anything a
	// ResolveRecipient caller doesn't already see), but has no email on
	// file to send a share notice to.
	ErrRecipientNoEmail = errors.New("accounts: that account has no email on file")
	// ErrInvalidHandle is "registered" mode's format error: the sharer
	// didn't type an "@username" handle. This is checked before any
	// lookup, so it never depends on whether an account exists.
	ErrInvalidHandle = errors.New("accounts: must be an exact @username, not an email address")
)

// parseUsernameHandle strips the leading "@" off a "registered" mode
// handle, which must be present. This is the one thing that lets the UI
// and this package tell a username apart from an email address (which
// never starts with "@") without maintaining a separate "is this an
// email" check -- and it's load-bearing, not cosmetic: "registered" mode
// must never resolve by email (see resolveRecipientAccount's doc), so an
// input that merely looks like an email is rejected outright here, before
// any account lookup happens.
func parseUsernameHandle(handle string) (username string, err error) {
	handle = strings.TrimSpace(handle)
	if !strings.HasPrefix(handle, "@") {
		return "", ErrInvalidHandle
	}
	username = strings.TrimPrefix(handle, "@")
	if username == "" || strings.ContainsAny(username, "@ \t") {
		return "", ErrInvalidHandle
	}
	return username, nil
}

// ListUsernames returns every account's username, for the "local users"
// share-target picker. Deliberately not admin-gated (unlike ListUsers,
// admin.go) and deliberately thin -- just the display name, never email
// or admin status -- since any logged-in user, not just an admin, needs
// this to pick a share recipient.
func (s *Store) ListUsernames(ctx context.Context) ([]string, error) {
	refs, err := s.queryPermanodes(ctx, &search.Constraint{
		Permanode: &search.PermanodeConstraint{Attr: "camliNodeType", Value: nodeTypeAccount},
	})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		pi, err := s.describeOne(ctx, ref)
		if err != nil {
			continue
		}
		if u := pi.Attr.Get(attrUsername); u != "" {
			out = append(out, u)
		}
	}
	sort.Strings(out)
	return out, nil
}

// resolveRecipientAccount looks handle up as an exact username only --
// never by email. It serves both the "local" mode (client already
// supplies an exact username, picked from ListUsernames) and the
// "registered" mode (client supplies a typed "@username" handle, already
// stripped of its "@" by parseUsernameHandle before reaching here)
// identically. Deliberately username-only: resolving by email as well
// would turn this into an oracle for testing whether some email address
// has an account here, which is exactly what "registered" mode exists to
// prevent -- the sharer must already know the recipient's username, not
// merely guess at an address.
func (s *Store) resolveRecipientAccount(ctx context.Context, username string) (pn blob.Ref, pi *search.DescribedPermanode, err error) {
	pn, found, err := s.findAccount(ctx, username)
	if err != nil {
		return blob.Ref{}, nil, err
	}
	if !found {
		return blob.Ref{}, nil, ErrRecipientNotFound
	}
	pi, err = s.describeOne(ctx, pn)
	if err != nil {
		return blob.Ref{}, nil, err
	}
	return pn, pi, nil
}

// ResolveRecipient is the live-validation lookup behind
// POST /auth/shares/resolve-recipient -- handle is the raw typed
// "@username" input, parsed here the same way handleSharesNotify's
// "registered" case parses it. Confirms it resolves to a real account and
// returns its canonical display username, without creating any side
// effect and without ever returning its email (unlike resolveRecipientAccount,
// this is reachable by any logged-in caller probing arbitrary handles, so
// it must never become an enumeration oracle -- a bad "@" format is
// reported the same as "not found," never distinguished, since the format
// check doesn't touch the account store anyway).
func (s *Store) ResolveRecipient(ctx context.Context, handle string) (username string, found bool, err error) {
	parsed, perr := parseUsernameHandle(handle)
	if perr != nil {
		return "", false, nil
	}
	_, pi, err := s.resolveRecipientAccount(ctx, parsed)
	if errors.Is(err, ErrRecipientNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return pi.Attr.Get(attrUsername), true, nil
}

// resolveRecipientEmail is shares/notify's actual recipient lookup for
// "local"/"registered" mode -- username is an exact username (for
// "registered" mode, already stripped of its "@" by the caller via
// parseUsernameHandle). Same resolution as ResolveRecipient, but returns
// the real email to send to (never exposed to ResolveRecipient's callers)
// and distinguishes "no such account" from "account exists but has no
// email on file," since shares/notify is already caller-authenticated and
// ownership-checked against the shared content, not a pre-session route --
// there's no enumeration risk left to protect here the way
// RequestPasswordReset's always-200 response has to.
func (s *Store) resolveRecipientEmail(ctx context.Context, username string) (resolvedUsername, email string, err error) {
	_, pi, err := s.resolveRecipientAccount(ctx, username)
	if err != nil {
		return "", "", err
	}
	addr := pi.Attr.Get(attrEmail)
	if addr == "" {
		return "", "", ErrRecipientNoEmail
	}
	return pi.Attr.Get(attrUsername), addr, nil
}

// shareURL builds an absolute link into the native share handler
// (pkg/server/share.go) for target/shareClaim, mirroring the two URL
// shapes server/perkeepd/ui-src/src/components/SelectionActions.jsx
// already builds client-side for the in-app "copy link" display. Built
// server-side here, from configured values only (s.baseURL, s.
// shareRootPath), rather than accepting a client-supplied URL string into
// an outgoing email -- the same lesson Phase 4's /ui/-prefix bug taught
// (see uiURL, handler.go): never trust a request-derived string for a
// link that ends up in email.
//
// ok is false if the server has no baseURL configured, or the share
// handler isn't enabled at all (empty shareRootPath) -- shares/notify's
// caller (handler.go) must treat that the same as requireBaseURL's 503.
func (s *Store) shareURL(target, shareClaim blob.Ref, isFile bool) (string, bool) {
	if s.baseURL == "" || s.shareRootPath == "" {
		return "", false
	}
	if isFile {
		return s.baseURL + s.shareRootPath + target.String() + "?via=" + shareClaim.String() + "&assemble=1", true
	}
	return s.baseURL + s.shareRootPath + shareClaim.String(), true
}
