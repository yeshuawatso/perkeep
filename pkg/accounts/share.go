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
)

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

// resolveRecipientAccount looks up handle as an email first, then as a
// username (same order and case-insensitivity as RequestPasswordReset,
// signup.go) -- so one lookup serves both the "local" mode (client
// already supplies an exact username, picked from ListUsernames) and the
// "registered" mode (client supplies an arbitrary typed username-or-
// email) identically.
func (s *Store) resolveRecipientAccount(ctx context.Context, handle string) (pn blob.Ref, pi *search.DescribedPermanode, err error) {
	pn, found, err := s.findAccountByEmail(ctx, handle)
	if err != nil {
		return blob.Ref{}, nil, err
	}
	if !found {
		pn, found, err = s.findAccount(ctx, handle)
		if err != nil {
			return blob.Ref{}, nil, err
		}
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
// POST /auth/shares/resolve-recipient -- confirms handle resolves to a
// real account and returns its canonical display username, without
// creating any side effect and without ever returning its email (unlike
// resolveRecipientAccount, this is reachable by any logged-in caller
// probing arbitrary handles, so it must never become an email-
// enumeration oracle).
func (s *Store) ResolveRecipient(ctx context.Context, handle string) (username string, found bool, err error) {
	_, pi, err := s.resolveRecipientAccount(ctx, handle)
	if errors.Is(err, ErrRecipientNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return pi.Attr.Get(attrUsername), true, nil
}

// resolveRecipientEmail is shares/notify's actual recipient lookup for
// "local"/"registered" mode -- same resolution as ResolveRecipient, but
// returns the real email to send to (never exposed to ResolveRecipient's
// callers) and distinguishes "no such account" from "account exists but
// has no email on file," since shares/notify is already caller-
// authenticated and ownership-checked against the shared content, not a
// pre-session route -- there's no enumeration risk left to protect here
// the way RequestPasswordReset's always-200 response has to.
func (s *Store) resolveRecipientEmail(ctx context.Context, handle string) (username, email string, err error) {
	_, pi, err := s.resolveRecipientAccount(ctx, handle)
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
