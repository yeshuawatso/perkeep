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

import "testing"

func TestConfigRoundTrip(t *testing.T) {
	t.Setenv("CAMLI_CONFIG_DIR", t.TempDir())

	got, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig on fresh dir: %v", err)
	}
	if got != (Config{}) {
		t.Fatalf("LoadConfig on fresh dir = %+v, want zero value", got)
	}

	want := Config{
		Host:     "smtp.example.com",
		Port:     587,
		Username: "bot@example.com",
		Password: "s3cret",
		Security: SecuritySTARTTLS,
		From:     "Perkeep <bot@example.com>",
	}
	if err := SaveConfig(want); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	got, err = LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig after save: %v", err)
	}
	if got != want {
		t.Fatalf("LoadConfig after save = %+v, want %+v", got, want)
	}
}
