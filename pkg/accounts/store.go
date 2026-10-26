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

// Package accounts implements Perkeep user accounts, password/API-token
// verification, and the JWT session/API tokens used by the web UI and
// curl/scripting clients, replacing the single shared Basic-auth
// credential.
//
// Accounts and API tokens are modeled as ordinary Perkeep permanodes (see
// account.go and tokens.go), not as rows in a side database: Perkeep's
// search index is a rebuildable cache (it's regenerated wholesale by
// --reindex, e.g. when switching index backends), while permanode
// attributes are already proven to survive that -- it's exactly how
// titles, set membership, etc. come back after a reindex. Modeling
// accounts the same way means they, and the permanode ownership this sets
// up for later multi-tenancy, survive a reindex for free.
//
// Only the JWT signing secret itself is kept outside that model (see
// loadOrCreateJWTSecret below), since rotating it would invalidate every
// outstanding session and API token; it lives as a local file next to the
// server's other durable local state (the GPG keyring), under the Perkeep
// config directory, generated once on first use.
package accounts // import "perkeep.org/pkg/accounts"

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"

	"go4.org/jsonconfig"

	"perkeep.org/internal/osutil"
	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/blobserver"
	"perkeep.org/pkg/jsonsign/signhandler"
	"perkeep.org/pkg/schema"
	"perkeep.org/pkg/search"
)

func init() {
	blobserver.RegisterHandlerConstructor("accounts", newFromConfig)
}

// rootLike is the subset of *server.RootHandler this package needs. It's
// expressed structurally, instead of importing perkeep.org/pkg/server
// directly, because pkg/server already imports pkg/auth, and pkg/auth's
// jwtauth.go needs to import this package -- importing pkg/server here
// too would be an import cycle. *server.RootHandler satisfies this
// implicitly (see its BlobStorage method).
type rootLike interface {
	SearchHandler() (*search.Handler, bool)
	BlobStorage() blobserver.Storage
}

// Store is the server-side handle for account/API-token CRUD and JWT
// issuing/verification. There is exactly one Store per server, installed
// as the package-level default once InitHandler runs; pkg/auth/jwtauth.go
// reads it via Default() to verify bearer tokens on every request.
type Store struct {
	prefix string // this handler's own URL prefix, e.g. "/auth/"

	target     blobserver.StatReceiver
	blobSource blob.Fetcher
	search     search.QueryDescriber
	signer     *schema.Signer

	jwtSecret []byte

	bootstrapUsername string
	bootstrapPassword string

	// passwordPolicy is nil (no restriction at all beyond "non-empty") unless
	// both passwordPolicyPattern and passwordPolicyDescription are set in
	// config -- see account.go's newPasswordPolicy/validatePassword.
	passwordPolicy *passwordPolicy

	// ownerCache backs OwnerOf (ownercache.go). Zero value is ready to use.
	ownerCache ownerCache
}

func newFromConfig(ld blobserver.Loader, conf jsonconfig.Obj) (http.Handler, error) {
	policyPattern := conf.OptionalString("passwordPolicyPattern", "")
	policyDescription := conf.OptionalString("passwordPolicyDescription", "")
	s := &Store{
		prefix:            ld.MyPrefix(),
		bootstrapUsername: conf.OptionalString("bootstrapUsername", ""),
		bootstrapPassword: conf.OptionalString("bootstrapPassword", ""),
	}
	if err := conf.Validate(); err != nil {
		return nil, err
	}
	policy, err := newPasswordPolicy(policyPattern, policyDescription)
	if err != nil {
		return nil, err
	}
	s.passwordPolicy = policy
	secret, err := loadOrCreateJWTSecret()
	if err != nil {
		return nil, fmt.Errorf("accounts: %w", err)
	}
	s.jwtSecret = secret
	return s, nil
}

// InitHandler wires this Store to the already-constructed root handler's
// search/storage/signing pieces, the same way pkg/importer's Host does
// (see its InitHandler) -- these aren't available at construction time,
// only once every handler has been created, and it's also the point at
// which the one-time bootstrap account (if configured and not already
// present) gets created.
func (s *Store) InitHandler(hl blobserver.FindHandlerByTyper) error {
	_, h, err := hl.FindHandlerByType("root")
	if err != nil {
		return fmt.Errorf("accounts: no root handler: %w", err)
	}
	rh, ok := h.(rootLike)
	if !ok {
		return fmt.Errorf("accounts: root handler (%T) doesn't implement rootLike", h)
	}
	sh, ok := rh.SearchHandler()
	if !ok {
		return fmt.Errorf("accounts: root handler has no search handler configured")
	}
	s.search = sh
	storage := rh.BlobStorage()
	s.target = storage
	s.blobSource = storage

	_, h, err = hl.FindHandlerByType("jsonsign")
	if err != nil {
		return fmt.Errorf("accounts: no jsonsign handler: %w", err)
	}
	sigh, ok := h.(*signhandler.Handler)
	if !ok {
		return fmt.Errorf("accounts: jsonsign handler is %T, not *signhandler.Handler", h)
	}
	s.signer = sigh.Signer()

	setDefault(s)

	ctx := context.Background()
	if err := s.backfillUsernameLower(ctx); err != nil {
		return fmt.Errorf("accounts: usernameLower backfill: %w", err)
	}

	if s.bootstrapUsername != "" {
		pn, found, err := s.findAccount(ctx, s.bootstrapUsername)
		if err != nil {
			return fmt.Errorf("accounts: bootstrap lookup: %w", err)
		}
		if !found {
			pn, err = s.CreateAccount(ctx, s.bootstrapUsername, s.bootstrapPassword)
			if err != nil {
				return fmt.Errorf("accounts: bootstrap account: %w", err)
			}
			log.Printf("accounts: created bootstrap account %q", s.bootstrapUsername)
		}
		// The first user is the default admin. This also self-heals an
		// install that adopted admin roles after already having a
		// bootstrap account from before that concept existed -- such an
		// account's own creation never went through the "grant admin"
		// branch above, so without this check it would stay a eternally
		// non-admin, locked out of every /auth/admin/* route with no way
		// back in (no other admin exists yet to grant it).
		if n, err := s.adminCount(ctx); err != nil {
			return fmt.Errorf("accounts: admin count: %w", err)
		} else if n == 0 {
			if err := s.setAttr(ctx, pn, attrAdmin, "1"); err != nil {
				return fmt.Errorf("accounts: bootstrap admin grant: %w", err)
			}
			log.Printf("accounts: granted admin to bootstrap account %q (no admin existed)", s.bootstrapUsername)
		}
	}

	// Run after the bootstrap account above, since backfillOwnership
	// assigns unowned permanodes to it and needs it to already exist.
	if err := s.backfillOwnership(ctx); err != nil {
		return fmt.Errorf("accounts: ownership backfill: %w", err)
	}
	return nil
}

var defaultStore atomic.Pointer[Store]

func setDefault(s *Store) { defaultStore.Store(s) }

// Default returns the server's single Store, or nil if accounts isn't
// configured (no "accounts"-typed prefix handler in server-config.json) or
// hasn't finished InitHandler yet.
func Default() *Store { return defaultStore.Load() }

func loadOrCreateJWTSecret() ([]byte, error) {
	dir, err := osutil.PerkeepConfigDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "jwt-secret")
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		return b, nil
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("generating JWT secret: %w", err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	// Atomic write: a crash mid-write must never leave a half-written
	// secret that only some already-issued tokens would verify against.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf, 0600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	log.Printf("accounts: generated new JWT signing secret at %s", path)
	return buf, nil
}

func randHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("accounts: failed to read random: " + err.Error())
	}
	return hex.EncodeToString(buf)
}
