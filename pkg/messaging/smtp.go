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
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// SMTPSender implements Sender over SMTP. It's deliberately not just
// net/smtp.SendMail: that helper only ever does STARTTLS-if-the-server-
// offers-it-else-plaintext, with no way to ask for implicit TLS (port
// 465) or to force plaintext against a local test relay -- both of which
// the admin Notifications tab's Security selector needs to support.
type SMTPSender struct {
	Config Config
}

var _ Sender = SMTPSender{}

const dialTimeout = 15 * time.Second

func (s SMTPSender) Send(ctx context.Context, msg Message) error {
	cfg := s.Config
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	var conn net.Conn
	var err error
	dialer := &net.Dialer{Timeout: dialTimeout}
	switch cfg.Security {
	case SecurityTLS:
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: cfg.Host})
	default: // SecurityNone and SecuritySTARTTLS both start out in plaintext
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("messaging: dialing %s: %w", addr, err)
	}
	defer conn.Close()

	c, err := smtp.NewClient(conn, cfg.Host)
	if err != nil {
		return fmt.Errorf("messaging: smtp handshake with %s: %w", addr, err)
	}
	defer c.Close()

	if cfg.Security == SecuritySTARTTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("messaging: %s does not offer STARTTLS", addr)
		}
		if err := c.StartTLS(&tls.Config{ServerName: cfg.Host}); err != nil {
			return fmt.Errorf("messaging: STARTTLS with %s: %w", addr, err)
		}
	}

	if cfg.Username != "" {
		if ok, _ := c.Extension("AUTH"); ok {
			auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
			if err := c.Auth(auth); err != nil {
				return fmt.Errorf("messaging: authenticating as %s: %w", cfg.Username, err)
			}
		}
	}

	from := cfg.From
	if from == "" {
		from = cfg.Username
	}
	if err := c.Mail(from); err != nil {
		return fmt.Errorf("messaging: MAIL FROM %s: %w", from, err)
	}
	if err := c.Rcpt(msg.To); err != nil {
		return fmt.Errorf("messaging: RCPT TO %s: %w", msg.To, err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("messaging: DATA: %w", err)
	}
	if _, err := w.Write(buildRFC822(from, msg)); err != nil {
		return fmt.Errorf("messaging: writing message body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("messaging: finishing message body: %w", err)
	}
	return c.Quit()
}

// buildRFC822 renders a minimal plaintext RFC 822 message. Good enough for
// verification links and plaintext notices; not building out MIME/HTML
// parts since nothing in this phase or the next two needs them.
func buildRFC822(from string, msg Message) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", msg.To)
	fmt.Fprintf(&b, "Subject: %s\r\n", msg.Subject)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(msg.Body)
	return []byte(b.String())
}
