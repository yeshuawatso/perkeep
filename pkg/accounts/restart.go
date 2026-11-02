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
	"log"
	"net/http"
	"time"

	"perkeep.org/internal/osutil"
)

// handleRestartServer re-executes the running perkeepd binary in place
// (same PID, same container -- see osutil.RestartProcess) so that config
// changes which aren't hot-reloaded (storage topology today; see
// storage.go) take effect without an operator having to reach outside the
// process (docker/systemd/...) to restart it. This is exactly what
// sending this process a SIGHUP has always done (see perkeepd.go's
// handleSignals) -- this route just exposes that existing, previously
// unwired mechanism to the admin UI, rather than introducing a new
// restart path.
//
// The response is written and flushed before the restart happens, so the
// caller gets a real "ok" rather than the connection just dying -- the
// restart itself happens a moment later, from a goroutine, after this
// handler has returned.
func (s *Store) handleRestartServer(w http.ResponseWriter, r *http.Request, ident *Identity) {
	writeJSON(w, map[string]any{"ok": true})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		if err := osutil.RestartProcess(); err != nil {
			// RestartProcess only returns on failure (success replaces
			// this process's image entirely) -- log and leave the server
			// running as-is rather than taking it down over a failed
			// restart attempt.
			log.Printf("accounts: admin-triggered restart failed: %v", err)
		}
	}()
}
