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
	"encoding/json"
	"net/http"

	"perkeep.org/pkg/messaging"
)

// smtpConfigView is handleGetSMTPConfig's response shape -- Password is
// deliberately never included (mirrors tokens.go's CreateAPIToken: a
// secret is returned once, on creation, and never stored or re-shown).
// HasPassword lets the admin UI show "a password is set" without ever
// learning what it is.
type smtpConfigView struct {
	Host        string              `json:"host"`
	Port        int                 `json:"port"`
	Username    string              `json:"username"`
	Security    messaging.Security  `json:"security"`
	From        string              `json:"from"`
	HasPassword bool                `json:"hasPassword"`
}

func (s *Store) handleGetSMTPConfig(w http.ResponseWriter, r *http.Request, ident *Identity) {
	cfg, err := messaging.LoadConfig()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, smtpConfigView{
		Host:        cfg.Host,
		Port:        cfg.Port,
		Username:    cfg.Username,
		Security:    cfg.Security,
		From:        cfg.From,
		HasPassword: cfg.Password != "",
	})
}

// handleSetSMTPConfig saves the admin-submitted SMTP config. An empty
// Password field means "keep whatever's already stored" -- the admin UI
// never has the real password to resubmit, so this is the only way to
// change host/port/etc without also having to re-enter it.
func (s *Store) handleSetSMTPConfig(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		Host     string             `json:"host"`
		Port     int                `json:"port"`
		Username string             `json:"username"`
		Password string             `json:"password"`
		Security messaging.Security `json:"security"`
		From     string             `json:"from"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	password := body.Password
	if password == "" {
		existing, err := messaging.LoadConfig()
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		password = existing.Password
	}
	cfg := messaging.Config{
		Host:     body.Host,
		Port:     body.Port,
		Username: body.Username,
		Password: password,
		Security: body.Security,
		From:     body.From,
	}
	if err := messaging.SaveConfig(cfg); err != nil {
		http.Error(w, "could not save config", http.StatusInternalServerError)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

// handleTestSend sends a trivial, hardcoded test message through the
// currently-saved SMTP config -- not through messaging.Render, since this
// is just proving connectivity/credentials work, not exercising the
// production templates (Phase 4/5 are those templates' first real
// callers). The real SMTP error is returned verbatim on failure: that
// error text (bad host, auth rejected, TLS failure, ...) is exactly what
// an admin debugging their own mail server config needs to see.
func (s *Store) handleTestSend(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body struct {
		To string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.To == "" {
		http.Error(w, "missing \"to\" address", http.StatusBadRequest)
		return
	}
	cfg, err := messaging.LoadConfig()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	sender := messaging.SMTPSender{Config: cfg}
	msg := messaging.Message{
		To:      body.To,
		Subject: "Perkeep test email",
		Body:    "This is a test message from your Perkeep server's Notifications settings. If you're reading this, your SMTP configuration works.",
	}
	if err := sender.Send(r.Context(), msg); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}
