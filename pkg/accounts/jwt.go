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
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	kindSession = "session" // browser login; self-contained, expires, no revocation lookup
	kindAPI     = "api"     // curl/scripting; no expiry, revocable via its apitoken permanode
)

// jwtHeader is fixed: this package is both issuer and verifier of every
// token it ever checks, so there is no "alg" negotiation -- the usual
// source of real-world JWT vulnerabilities (algorithm confusion, "alg:
// none", ...). Verification always does exactly one thing, unconditionally:
// recompute the HMAC-SHA256 over the header+payload and compare, no matter
// what the header (or anything else in the token) claims.
const jwtHeader = `{"alg":"HS256","typ":"JWT"}`

var jwtHeaderB64 = base64.RawURLEncoding.EncodeToString([]byte(jwtHeader))

type tokenClaims struct {
	Sub     string `json:"sub"`
	Kind    string `json:"kind"`
	Exp     int64  `json:"exp,omitempty"`
	TokenID string `json:"tid,omitempty"`
}

func (s *Store) macBytes(signingInput string) []byte {
	mac := hmac.New(sha256.New, s.jwtSecret)
	mac.Write([]byte(signingInput))
	return mac.Sum(nil)
}

func (s *Store) signToken(c tokenClaims) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := jwtHeaderB64 + "." + base64.RawURLEncoding.EncodeToString(payload)
	sig := base64.RawURLEncoding.EncodeToString(s.macBytes(signingInput))
	return signingInput + "." + sig, nil
}

func (s *Store) verifyToken(tokenString string) (*tokenClaims, error) {
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 {
		return nil, errors.New("accounts: malformed token")
	}
	signingInput := parts[0] + "." + parts[1]
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(got, s.macBytes(signingInput)) {
		return nil, errors.New("accounts: invalid token signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var c tokenClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, err
	}
	if c.Exp != 0 && time.Now().Unix() > c.Exp {
		return nil, errors.New("accounts: token expired")
	}
	return &c, nil
}

// VerifyBearer verifies tokenString (the raw value after "Bearer " or in
// "?access_token=") and, if valid, returns the username it authenticates
// as. Used by pkg/auth/jwtauth.go on every request, and by this package's
// own HTTP handlers to identify the caller for /account/* routes.
func (s *Store) VerifyBearer(ctx context.Context, tokenString string) (username string, ok bool) {
	c, err := s.verifyToken(tokenString)
	if err != nil {
		return "", false
	}
	switch c.Kind {
	case kindSession:
		return c.Sub, true
	case kindAPI:
		active, err := s.isTokenActive(ctx, c.Sub, c.TokenID)
		if err != nil || !active {
			return "", false
		}
		return c.Sub, true
	default:
		return "", false
	}
}
