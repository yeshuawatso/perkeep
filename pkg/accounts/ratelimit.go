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
	"net"
	"net/http"
	"sync"
	"time"
)

// rateLimitMax/rateLimitWindow are deliberately hardcoded, not a new
// server-config.json knob -- this is "basic" per-IP abuse resistance for
// login/signup/forgot-password/resend-verification, the first
// unauthenticated routes in this codebase that create real accounts or
// send real email (confirmed by grep: no rate-limiting precedent exists
// anywhere else to reuse or match).
const (
	rateLimitMax    = 5
	rateLimitWindow = 15 * time.Minute
)

// rateLimiter is a small in-memory per-key sliding-window limiter. A
// server restart resets every limit -- acceptable for basic abuse
// resistance, not meant as a hard security boundary (that would need a
// durable store, out of scope here).
type rateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{attempts: make(map[string][]time.Time)}
}

// allow reports whether key (e.g. "login:1.2.3.4") may proceed, recording
// this attempt if so. Attempts outside the window are pruned lazily, on
// access, rather than by a background sweep.
func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := time.Now().Add(-rateLimitWindow)
	kept := rl.attempts[key][:0]
	for _, t := range rl.attempts[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= rateLimitMax {
		rl.attempts[key] = kept
		return false
	}
	rl.attempts[key] = append(kept, time.Now())
	return true
}

// clientIP extracts req's remote IP, stripping the port. No
// X-Forwarded-For/X-Real-IP handling: trusting a proxy header here without
// knowing whether this server actually sits behind a trusted proxy would
// let a client spoof its way around the limit just by setting the header
// itself -- confirmed by grep that no other handler in this codebase
// trusts one for anything either.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimited checks route's limiter for r's client IP, writing a 429 and
// returning true if the caller should stop handling the request.
func (s *Store) rateLimited(w http.ResponseWriter, r *http.Request, route string) bool {
	if s.rateLimiter.allow(route + ":" + clientIP(r)) {
		return false
	}
	http.Error(w, "too many attempts; try again later", http.StatusTooManyRequests)
	return true
}
