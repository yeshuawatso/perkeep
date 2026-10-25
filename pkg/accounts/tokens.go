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
	"time"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/search"
)

// CreateAPIToken mints a new long-lived, revocable token for username --
// this is the curl/scripting replacement for a shared Basic-auth password:
// `curl -H "Authorization: Bearer <token>" ...`.
func (s *Store) CreateAPIToken(ctx context.Context, username, label string) (string, APITokenView, error) {
	accountPN, found, err := s.findAccount(ctx, username)
	if err != nil {
		return "", APITokenView{}, err
	}
	if !found {
		return "", APITokenView{}, ErrNotFound
	}
	id := randHex(8)
	pn, err := s.newPermanode(ctx)
	if err != nil {
		return "", APITokenView{}, err
	}
	createdAt := time.Now().UTC()
	for _, kv := range [][2]string{
		{"camliNodeType", nodeTypeAPIToken},
		{"owner", accountPN.String()},
		{"tokenId", id},
		{"label", label},
		{"createdAt", createdAt.Format(time.RFC3339)},
	} {
		if err := s.setAttr(ctx, pn, kv[0], kv[1]); err != nil {
			return "", APITokenView{}, err
		}
	}
	tok, err := s.signToken(tokenClaims{Sub: username, Kind: kindAPI, TokenID: id})
	if err != nil {
		return "", APITokenView{}, err
	}
	return tok, APITokenView{ID: id, Label: label, CreatedAt: createdAt}, nil
}

func (s *Store) listAPITokens(ctx context.Context, accountPN blob.Ref) ([]APITokenView, error) {
	refs, err := s.queryPermanodes(ctx, &search.Constraint{
		Logical: &search.LogicalConstraint{
			Op: "and",
			A:  &search.Constraint{Permanode: &search.PermanodeConstraint{Attr: "owner", Value: accountPN.String()}},
			B:  &search.Constraint{Permanode: &search.PermanodeConstraint{Attr: "camliNodeType", Value: nodeTypeAPIToken}},
		},
	})
	if err != nil {
		return nil, err
	}
	out := make([]APITokenView, 0, len(refs))
	for _, ref := range refs {
		pi, err := s.describeOne(ctx, ref)
		if err != nil {
			continue
		}
		if pi.Attr.Get("revoked") == "1" {
			continue
		}
		createdAt, _ := time.Parse(time.RFC3339, pi.Attr.Get("createdAt"))
		out = append(out, APITokenView{
			ID:        pi.Attr.Get("tokenId"),
			Label:     pi.Attr.Get("label"),
			CreatedAt: createdAt,
		})
	}
	return out, nil
}

func (s *Store) RevokeAPIToken(ctx context.Context, username, id string) error {
	accountPN, found, err := s.findAccount(ctx, username)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	pn, found, err := s.findPermanodeByAttr(ctx, "tokenId", id)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return err
	}
	if pi.Attr.Get("owner") != accountPN.String() {
		// Not this user's token -- report it the same as "doesn't exist"
		// rather than leaking that a token with this ID belongs to someone
		// else.
		return ErrNotFound
	}
	return s.setAttr(ctx, pn, "revoked", "1")
}

// isTokenActive is the one piece of API-token verification that needs a
// live lookup, unlike a session JWT's self-contained exp check -- it's
// what makes "Revoke" on the Account page actually take effect
// immediately for a long-lived credential.
func (s *Store) isTokenActive(ctx context.Context, username, id string) (bool, error) {
	pn, found, err := s.findPermanodeByAttr(ctx, "tokenId", id)
	if err != nil || !found {
		return false, err
	}
	pi, err := s.describeOne(ctx, pn)
	if err != nil {
		return false, err
	}
	if pi.Attr.Get("revoked") == "1" {
		return false, nil
	}
	accountPN, found, err := s.findAccount(ctx, username)
	if err != nil || !found {
		return false, err
	}
	return pi.Attr.Get("owner") == accountPN.String(), nil
}
