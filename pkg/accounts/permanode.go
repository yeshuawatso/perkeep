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
	"fmt"
	"io"

	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/blobserver"
	"perkeep.org/pkg/schema"
	"perkeep.org/pkg/search"
)

// upload signs bb with this server's own identity and stores the result --
// the same two-step pkg/importer's Host.upload performs.
func (s *Store) upload(ctx context.Context, bb *schema.Builder) (blob.Ref, error) {
	signed, err := bb.Sign(ctx, s.signer)
	if err != nil {
		return blob.Ref{}, err
	}
	sb, err := blobserver.ReceiveString(ctx, s.target, signed)
	if err != nil {
		return blob.Ref{}, err
	}
	return sb.Ref, nil
}

func (s *Store) newPermanode(ctx context.Context) (blob.Ref, error) {
	return s.upload(ctx, schema.NewUnsignedPermanode())
}

func (s *Store) setAttr(ctx context.Context, pn blob.Ref, attr, value string) error {
	_, err := s.upload(ctx, schema.NewSetAttributeClaim(pn, attr, value))
	return err
}

// StampOwnership records that permanode pn was created by username --
// called synchronously from the upload-handler hook
// (pkg/blobserver/handlers, wired up in pkg/serverinit), right after pn is
// durably received, never from a client-settable claim. See
// AccountRefAttr's doc comment (account.go) for why.
func (s *Store) StampOwnership(ctx context.Context, pn blob.Ref, username string) error {
	accountPN, found, err := s.findAccount(ctx, username)
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	return s.setAttr(ctx, pn, AccountRefAttr, accountPN.String())
}

// writeSecretBlob stores literal, unsigned content -- used for the
// bcrypt/SHA-256 hash blobs that passwordHashRef/tokenHashRef-style
// attributes point at, so the hash itself never appears as a permanode
// attribute value and can't leak through a stray describe()/search
// response the way an attribute value could.
func (s *Store) writeSecretBlob(ctx context.Context, content string) (blob.Ref, error) {
	sb, err := blobserver.ReceiveString(ctx, s.target, content)
	if err != nil {
		return blob.Ref{}, err
	}
	return sb.Ref, nil
}

func (s *Store) readBlobContent(ctx context.Context, ref blob.Ref) (string, error) {
	rc, _, err := s.blobSource.Fetch(ctx, ref)
	if err != nil {
		return "", err
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (s *Store) findPermanodeByAttr(ctx context.Context, attr, value string) (blob.Ref, bool, error) {
	res, err := s.search.Query(ctx, &search.SearchQuery{
		Constraint: &search.Constraint{
			Permanode: &search.PermanodeConstraint{Attr: attr, Value: value},
		},
		Limit: 1,
		Sort:  search.CreatedDesc,
	})
	if err != nil {
		return blob.Ref{}, false, err
	}
	if len(res.Blobs) == 0 {
		return blob.Ref{}, false, nil
	}
	return res.Blobs[0].Blob, true, nil
}

func (s *Store) queryPermanodes(ctx context.Context, c *search.Constraint) ([]blob.Ref, error) {
	res, err := s.search.Query(ctx, &search.SearchQuery{
		Constraint: c,
		Limit:      -1,
		Sort:       search.CreatedDesc,
	})
	if err != nil {
		return nil, err
	}
	refs := make([]blob.Ref, 0, len(res.Blobs))
	for _, b := range res.Blobs {
		refs = append(refs, b.Blob)
	}
	return refs, nil
}

// describeOne fetches a single permanode's current attributes.
func (s *Store) describeOne(ctx context.Context, pn blob.Ref) (*search.DescribedPermanode, error) {
	resp, err := s.search.Describe(ctx, &search.DescribeRequest{BlobRef: pn})
	if err != nil {
		return nil, err
	}
	db := resp.Meta.Get(pn)
	if db == nil || db.Permanode == nil {
		return nil, fmt.Errorf("accounts: %s not found or not a permanode", pn)
	}
	return db.Permanode, nil
}
