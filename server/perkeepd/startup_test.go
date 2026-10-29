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

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"perkeep.org/pkg/auth"
	"perkeep.org/pkg/health"
)

func TestStartupLog(t *testing.T) {
	l := new(startupLog)
	fmt.Fprintf(l, "one\ntw")
	fmt.Fprintf(l, "o\nthree\n")
	if got, want := l.Lines(), []string{"one", "two", "three"}; !slices.Equal(got, want) {
		t.Errorf("Lines = %q; want %q", got, want)
	}

	// Once full, it keeps the most recent lines.
	l = new(startupLog)
	for i := range startupLogLines + 10 {
		fmt.Fprintf(l, "line %d\n", i)
	}
	got := l.Lines()
	if len(got) != startupLogLines {
		t.Fatalf("got %d lines; want %d", len(got), startupLogLines)
	}
	if got[0] != "line 10" || got[len(got)-1] != fmt.Sprintf("line %d", startupLogLines+9) {
		t.Errorf("lines run from %q to %q; want line 10 to line %d", got[0], got[len(got)-1], startupLogLines+9)
	}
}

func TestStartupHandler(t *testing.T) {
	l := new(startupLog)
	fmt.Fprintf(l, "loading <corpus>\n")
	mon := health.New()
	newHandler := func(exposeLog bool) *startupHandler {
		return &startupHandler{log: l, start: time.Now(), healthz: http.HandlerFunc(mon.ServeHealthz), exposeLog: exposeLog}
	}
	getFrom := func(h *startupHandler, path string, header ...string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", path, nil)
		for i := 0; i+1 < len(header); i += 2 {
			req.Header.Set(header[i], header[i+1])
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	auth.SetMode(&auth.UserPass{Username: "owner", Password: "secret"})
	t.Cleanup(func() { auth.SetMode(auth.None{}) })

	hOff := newHandler(false)

	// API requests, including discovery, are told to come back later,
	// regardless of ExposeStartupLog.
	for _, rec := range []*httptest.ResponseRecorder{
		getFrom(hOff, "/bs/camli/sha224-abc"),
		getFrom(hOff, "/?camli.mode=config"),
		getFrom(hOff, "/ui/", "Accept", "text/x-camli-configuration"),
	} {
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
			t.Errorf("API request: got %d, Retry-After %q; want 503 with Retry-After", rec.Code, rec.Header().Get("Retry-After"))
		}
	}

	// The health summary is public, and says the server is starting.
	if rec := getFrom(hOff, "/healthz"); rec.Code != http.StatusServiceUnavailable || rec.Body.String() != "starting\n" {
		t.Errorf("/healthz: got %d %q; want 503 %q", rec.Code, rec.Body, "starting\n")
	}

	// ExposeStartupLog unset (the default): the page never asks for
	// credentials and never shows the log, no matter the auth mode.
	for _, path := range []string{"/", "/ui/"} {
		rec := getFrom(hOff, path)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("exposeLog=false, %s: got %d; want 503", path, rec.Code)
		}
		if body := rec.Body.String(); strings.Contains(body, "loading &lt;corpus&gt;") {
			t.Errorf("exposeLog=false, %s: body shows the log, want the generic page:\n%s", path, body)
		}
	}
	auth.SetMode(auth.None{})
	if rec := getFrom(hOff, "/ui/"); rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "loading &lt;corpus&gt;") {
		t.Errorf("exposeLog=false under auth.None, /ui/: got %d, body %q; want 503 with no log", rec.Code, rec.Body.String())
	}

	// ExposeStartupLog set: same as the handler's old always-on behavior.
	hOn := newHandler(true)
	auth.SetMode(&auth.UserPass{Username: "owner", Password: "secret"})
	if rec := getFrom(hOn, "/ui/"); rec.Code != http.StatusUnauthorized {
		t.Errorf("exposeLog=true, unauthenticated /ui/: got %d; want 401", rec.Code)
	}

	auth.SetMode(auth.None{})
	for _, path := range []string{"/", "/ui/"} {
		rec := getFrom(hOn, path)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("exposeLog=true, %s: got %d; want 503", path, rec.Code)
		}
		if body := rec.Body.String(); !strings.Contains(body, "loading &lt;corpus&gt;") {
			t.Errorf("exposeLog=true, %s: body doesn't show the escaped log line:\n%s", path, body)
		}
	}
}
