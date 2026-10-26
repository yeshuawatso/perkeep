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

// Package messaging provides a provider-agnostic way to notify a user
// outside of the web UI -- email via SMTP today, with Slack/Telegram/Bark
// expected to implement the same Sender interface later without any
// interface change. This package is deliberately a leaf: it has no
// dependency on pkg/accounts or anything else that models Perkeep
// accounts, so it can be imported from pkg/accounts (which is exactly how
// the admin Notifications-tab routes in pkg/accounts/notifications.go
// reach it) without any import-cycle risk.
package messaging // import "perkeep.org/pkg/messaging"

import "context"

// Message is a provider-agnostic notification. Not every Sender uses every
// field (a Slack Sender, for instance, has no use for Subject), but all of
// them are cheap to carry and ignore.
type Message struct {
	To      string // recipient address/handle, meaning depends on the Sender
	Subject string
	Body    string
}

// Sender delivers a Message. The only implementation today is SMTPSender;
// this interface exists so Phase 4 (self-signup verification emails) and
// Phase 5 (external share notices) can be written against Sender instead
// of SMTPSender directly, and so a future Slack/Telegram/Bark Sender slots
// in without touching those call sites.
type Sender interface {
	Send(ctx context.Context, msg Message) error
}
