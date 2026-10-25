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
	"time"

	"golang.org/x/crypto/bcrypt"

	"perkeep.org/pkg/blob"
)

const (
	nodeTypeAccount  = "account"
	nodeTypeAPIToken = "apitoken"
)

var (
	ErrNotFound    = errors.New("accounts: not found")
	ErrExists      = errors.New("accounts: already exists")
	ErrBadPassword = errors.New("accounts: incorrect password")
)

// AccountView and APITokenView are what the HTTP handlers (handler.go)
// serialize to the Account page -- never the password/token hashes
// themselves, which never leave readBlobContent/bcrypt.
type AccountView struct {
	Username  string         `json:"username"`
	APITokens []APITokenView `json:"apiTokens"`
}

type APITokenView struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Store) findAccount(ctx context.Context, username string) (blob.Ref, bool, error) {
	return s.findPermanodeByAttr(ctx, "username", username)
}

// CreateAccount creates a new account permanode. There is no public
// "sign up" endpoint -- this is only called for the one-time bootstrap
// account (see InitHandler).
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
		{"username", username},
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
	tokens, err := s.listAPITokens(ctx, pn)
	if err != nil {
		return nil, err
	}
	return &AccountView{Username: username, APITokens: tokens}, nil
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
	if newUsername != currentUsername {
		if _, taken, err := s.findAccount(ctx, newUsername); err != nil {
			return err
		} else if taken {
			return ErrExists
		}
	}
	return s.setAttr(ctx, pn, "username", newUsername)
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
	hashRef, err := s.hashAndStore(ctx, newPassword)
	if err != nil {
		return err
	}
	return s.setAttr(ctx, pn, "passwordHashRef", hashRef.String())
}
