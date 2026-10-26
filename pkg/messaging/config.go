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

package messaging

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"perkeep.org/internal/osutil"
)

// Security selects how SMTPSender establishes the connection before
// authenticating.
type Security string

const (
	SecurityNone     Security = "none"     // plaintext, e.g. a local test relay like MailHog
	SecurityTLS      Security = "tls"      // implicit TLS from the first byte, typically port 465
	SecuritySTARTTLS Security = "starttls" // plaintext connect, then upgrade, typically port 587
)

// Config is the server's SMTP configuration: who to connect to, and as
// whom. It's admin-entered, server-wide configuration -- not per-user
// data -- so, like the JWT signing secret in pkg/accounts/store.go, it's
// kept as a local file next to Perkeep's other durable local state rather
// than as a permanode. Unlike the JWT secret, this is read back and
// re-edited via the admin UI, so callers that expose it over HTTP (see
// pkg/accounts/notifications.go) must mask Password themselves -- this
// package stores and returns it in the clear.
type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	Security Security
	From     string // the envelope/header From address
}

// configFileName lives under osutil.PerkeepConfigDir(), the same
// directory pkg/accounts/store.go's loadOrCreateJWTSecret uses for
// "jwt-secret".
const configFileName = "notifications-config.json"

func configPath() (string, error) {
	dir, err := osutil.PerkeepConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, configFileName), nil
}

// LoadConfig returns the current SMTP configuration. A missing file is
// not an error -- "SMTP isn't configured yet" is the normal state on a
// fresh server, not a failure -- and returns a zero-value Config instead.
func LoadConfig() (Config, error) {
	path, err := configPath()
	if err != nil {
		return Config{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, nil
		}
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, fmt.Errorf("messaging: parsing %s: %w", path, err)
	}
	return cfg, nil
}

// SaveConfig persists cfg, replacing whatever was there before.
func SaveConfig(cfg Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	// Atomic write: a crash mid-write must never leave a half-written
	// config that fails to parse on next load (same reasoning as
	// loadOrCreateJWTSecret's tmp-then-rename).
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
