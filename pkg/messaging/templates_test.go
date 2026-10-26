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
	"strings"
	"testing"
)

func TestRenderVerifyEmail(t *testing.T) {
	msg, err := Render("verify-email", struct {
		Username  string
		VerifyURL string
		ExpiresIn string
	}{"alice", "https://example.com/verify/abc123", "24 hours"})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if msg.Subject != "Verify your Perkeep account" {
		t.Errorf("Subject = %q", msg.Subject)
	}
	for _, want := range []string{"alice", "https://example.com/verify/abc123", "24 hours"} {
		if !strings.Contains(msg.Body, want) {
			t.Errorf("Body missing %q:\n%s", want, msg.Body)
		}
	}
	if strings.Contains(msg.Body, "Subject:") {
		t.Errorf("Body still contains the Subject header:\n%s", msg.Body)
	}
}

func TestRenderForgotPassword(t *testing.T) {
	msg, err := Render("forgot-password", struct {
		Username  string
		ResetURL  string
		ExpiresIn string
	}{"bob", "https://example.com/reset/xyz", "1 hour"})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if msg.Subject != "Reset your Perkeep password" {
		t.Errorf("Subject = %q", msg.Subject)
	}
	if !strings.Contains(msg.Body, "https://example.com/reset/xyz") {
		t.Errorf("Body missing reset URL:\n%s", msg.Body)
	}
}

func TestRenderShareNotice(t *testing.T) {
	msg, err := Render("share-notice", struct {
		SharerUsername string
		ItemTitle      string
		ShareURL       string
		ExpiresIn      string
	}{"carol", "Vacation photos", "https://example.com/share/qqq", ""})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(msg.Subject, "carol") {
		t.Errorf("Subject = %q", msg.Subject)
	}
	if !strings.Contains(msg.Body, "Vacation photos") || !strings.Contains(msg.Body, "https://example.com/share/qqq") {
		t.Errorf("Body missing expected content:\n%s", msg.Body)
	}
	if strings.Contains(msg.Body, "This link expires") {
		t.Errorf("Body rendered the conditional expiry line with an empty ExpiresIn:\n%s", msg.Body)
	}
}

func TestRenderUnknownTemplate(t *testing.T) {
	if _, err := Render("does-not-exist", nil); err == nil {
		t.Fatal("Render of unknown template name: want error, got nil")
	}
}
