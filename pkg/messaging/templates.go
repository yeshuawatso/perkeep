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
	"bytes"
	"embed"
	"fmt"
	"strings"
	"text/template"
)

//go:embed templates/*.txt
var templateFS embed.FS

// Render fills the named built-in template with data and returns the
// resulting Message (To is left empty -- the caller always knows the
// recipient, Render only knows the content). Each template file's first
// line is "Subject: ...", followed by a blank line, then the body -- both
// halves are rendered as the same Go text/template so either can
// reference fields of data.
//
// Editing these via the admin UI is out of scope for this phase (see
// docs/multi-tenant-roadmap.md Phase 3); Phase 4 (verify-email,
// forgot-password) and Phase 5 (share-notice) are this function's first
// real callers -- Phase 3 itself only proves the mechanism works via the
// admin Notifications tab's test-send button, which builds its Message
// directly rather than through Render.
func Render(name string, data any) (Message, error) {
	raw, err := templateFS.ReadFile("templates/" + name + ".txt")
	if err != nil {
		return Message{}, fmt.Errorf("messaging: unknown template %q: %w", name, err)
	}
	tmpl, err := template.New(name).Parse(string(raw))
	if err != nil {
		return Message{}, fmt.Errorf("messaging: parsing template %q: %w", name, err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return Message{}, fmt.Errorf("messaging: rendering template %q: %w", name, err)
	}
	subject, body := splitSubject(buf.String())
	return Message{Subject: subject, Body: body}, nil
}

// splitSubject pulls the "Subject: ..." header off the top of a rendered
// template, trimming the single blank line between it and the body.
func splitSubject(rendered string) (subject, body string) {
	const prefix = "Subject:"
	nl := strings.IndexByte(rendered, '\n')
	if nl < 0 || !strings.HasPrefix(rendered, prefix) {
		return "", strings.TrimLeft(rendered, "\n")
	}
	subject = strings.TrimSpace(strings.TrimPrefix(rendered[:nl], prefix))
	rest := rendered[nl+1:]
	rest = strings.TrimPrefix(rest, "\n") // the blank line separating header from body
	return subject, rest
}
