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
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"perkeep.org/internal/osutil"
	"perkeep.org/pkg/blob"
	"perkeep.org/pkg/blobserver"
	"perkeep.org/pkg/blobserver/storagetarget"
	"perkeep.org/pkg/health"
	"perkeep.org/pkg/types/serverconfig"
)

// The admin-UI storage panel reads and writes the server's actual
// high-level config file (osutil.UserServerConfigPath()) directly --
// unlike SMTP (pkg/messaging/config.go), storage topology isn't its own
// side-channel config: it's what pkg/serverinit's genconfig.go reads at
// boot to build the real low-level blobserver config, so there's nowhere
// else for it to live. See docs/multi-tenant-roadmap.md for why this
// means a save here only takes effect on the next restart (storage
// objects are constructed once at boot and held as long-lived references
// throughout the server -- there's no hot-reload path, matching how
// every other server-side config change in this project is applied).

// readServerConfigTyped reads the server config file for typed display
// (handleGetStorageConfig). It intentionally does NOT go through
// serverinit.Load/LoadFile -- those also run genLowLevelConfig, which can
// fail for reasons unrelated to storage (a missing identity file, for
// example) and would make a read-only GET unnecessarily fragile. A plain
// json.Unmarshal doesn't evaluate jsonconfig "functions" (e.g. an "_env"
// value) the way the real loader does, so a field set that way displays
// as empty here -- an accepted limitation, same class as SMTP's
// secret-masking tradeoffs.
func readServerConfigTyped() (*serverconfig.Config, error) {
	b, err := os.ReadFile(osutil.UserServerConfigPath())
	if err != nil {
		return nil, err
	}
	var conf serverconfig.Config
	if err := json.Unmarshal(b, &conf); err != nil {
		return nil, err
	}
	return &conf, nil
}

// readServerConfigRaw reads the server config file as a raw key->JSON
// map, so writeServerConfigRaw can change only the storage-related keys
// and leave every other key (auth, rateLimitExemptIPs, immich, ...)
// byte-for-byte untouched.
func readServerConfigRaw() (map[string]json.RawMessage, error) {
	b, err := os.ReadFile(osutil.UserServerConfigPath())
	if err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// writeServerConfigRaw persists m, replacing whatever was there before.
// Atomic write: a crash mid-write must never leave a half-written config
// that fails to parse on next boot (same reasoning as
// loadOrCreateJWTSecret/messaging.SaveConfig's tmp-then-rename).
func writeServerConfigRaw(m map[string]json.RawMessage) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	path := osutil.UserServerConfigPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func setRawField(m map[string]json.RawMessage, key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	m[key] = b
	return nil
}

// legacyVendorNames is every synthetic Name a legacy top-level vendor
// field produces when it's wired as a backup (or as primary, when none
// of BlobPath/MemoryStorage/Primary claims /bs/ first) -- see
// pkg/serverinit/genconfig.go's addS3Config/addB2Config/
// addGoogleDriveConfig/addGoogleCloudStorageConfig. Declaration order
// here matches genconfig.go's own call order in build(), which is also
// the effective primary-precedence order when more than one legacy
// vendor field is set without BlobPath/MemoryStorage/Primary.
var legacyVendorNames = []string{"s3", "b2", "googledrive", "googlecloudstorage"}

func legacyVendorValue(conf *serverconfig.Config, name string) string {
	switch name {
	case "s3":
		return conf.S3
	case "b2":
		return conf.B2
	case "googledrive":
		return conf.GoogleDrive
	case "googlecloudstorage":
		return conf.GoogleCloudStorage
	}
	return ""
}

// legacyPrimaryName returns which legacy vendor field (if any) is
// currently acting as primary storage -- true only when nothing else
// (BlobPath, MemoryStorage, Primary) already claims that role, mirroring
// genconfig.go's own isReplica := hasPrefix("/bs/") check.
func legacyPrimaryName(conf *serverconfig.Config) string {
	if conf.Primary != nil || conf.BlobPath != "" || conf.MemoryStorage {
		return ""
	}
	for _, name := range legacyVendorNames {
		if legacyVendorValue(conf, name) != "" {
			return name
		}
	}
	return ""
}

// syncStatusView mirrors blobserver.SyncStatus for JSON display.
type syncStatusView struct {
	BlobsRemaining     int   `json:"blobsRemaining"`
	BytesRemaining     int64 `json:"bytesRemaining"`
	LastCopySecondsAgo int   `json:"lastCopySecondsAgo"`
	RecentErrors       int64 `json:"recentErrors"`
	Caught             bool  `json:"caught"`
	// Unknown is true when live status couldn't be read -- e.g. this
	// backup was just saved and hasn't been applied via restart yet, so
	// no "/sync-to-<name>/" handler exists to ask.
	Unknown bool `json:"unknown,omitempty"`
}

// syncStatus looks up name's live "/sync-to-<name>/" handler (if any --
// see pkg/serverinit/genconfig.go's addReplicationTarget) through
// InitHandler's stashed handler finder, and reads its status through the
// blobserver.SyncStatuser interface, never importing pkg/server directly
// (see blobserver.SyncStatuser's doc comment for why).
func (s *Store) syncStatus(name string) syncStatusView {
	if s.handlers == nil {
		return syncStatusView{Unknown: true}
	}
	_, handlers := s.handlers.AllHandlers()
	h, ok := handlers[fmt.Sprintf("/sync-to-%s/", name)]
	if !ok {
		return syncStatusView{Unknown: true}
	}
	ss, ok := h.(blobserver.SyncStatuser)
	if !ok {
		return syncStatusView{Unknown: true}
	}
	st := ss.SyncStatus()
	return syncStatusView{
		BlobsRemaining:     st.BlobsRemaining,
		BytesRemaining:     st.BytesRemaining,
		LastCopySecondsAgo: st.LastCopySecondsAgo,
		RecentErrors:       st.RecentErrors,
		Caught:             st.Caught(),
	}
}

// storageTargetView is a serverconfig.StorageTarget with every secret
// field reduced to a Has<Field> bool -- mirrors notifications.go's
// smtpConfigView.HasPassword convention: a secret already on file is
// never re-sent to the browser once saved.
type storageTargetView struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Bucket   string `json:"bucket,omitempty"`
	Dir      string `json:"dir,omitempty"`
	Hostname string `json:"hostname,omitempty"`
	Path     string `json:"path,omitempty"`

	AWSAccessKey    string `json:"awsAccessKey,omitempty"`
	HasAWSSecretKey bool   `json:"hasAwsSecretKey,omitempty"`

	GCSClientID             string `json:"gcsClientID,omitempty"`
	HasGCSClientSecret      bool   `json:"hasGcsClientSecret,omitempty"`
	HasGCSRefreshToken      bool   `json:"hasGcsRefreshToken,omitempty"`
	HasGCSServiceAccountKey bool   `json:"hasGcsServiceAccountKey,omitempty"`

	GoogleClientID        string `json:"googleClientID,omitempty"`
	HasGoogleClientSecret bool   `json:"hasGoogleClientSecret,omitempty"`
	HasGoogleRefreshToken bool   `json:"hasGoogleRefreshToken,omitempty"`
	GoogleDriveParentID   string `json:"googleDriveParentID,omitempty"`

	// Status is only populated for backups (never Primary, which has no
	// SyncHandler of its own).
	Status *syncStatusView `json:"status,omitempty"`

	// Legacy is true for a backup derived from one of the top-level
	// s3/b2/googledrive/googlecloudstorage fields rather than a
	// replicateTo entry -- the admin-UI frontend uses it to hide the
	// "Edit" action for these rows, since only the bare colon-string is
	// known (see handleGetStorageConfig), not structured fields to edit.
	Legacy bool `json:"legacy,omitempty"`
}

func toView(t serverconfig.StorageTarget, status *syncStatusView) storageTargetView {
	return storageTargetView{
		Name:                    t.Name,
		Type:                    t.Type,
		Bucket:                  t.Bucket,
		Dir:                     t.Dir,
		Hostname:                t.Hostname,
		Path:                    t.Path,
		AWSAccessKey:            t.AWSAccessKey,
		HasAWSSecretKey:         t.AWSSecretKey != "",
		GCSClientID:             t.GCSClientID,
		HasGCSClientSecret:      t.GCSClientSecret != "",
		HasGCSRefreshToken:      t.GCSRefreshToken != "",
		HasGCSServiceAccountKey: t.GCSServiceAccountKey != "",
		GoogleClientID:          t.GoogleClientID,
		HasGoogleClientSecret:   t.GoogleClientSecret != "",
		HasGoogleRefreshToken:   t.GoogleRefreshToken != "",
		GoogleDriveParentID:     t.GoogleDriveParentID,
		Status:                  status,
	}
}

type storageConfigView struct {
	// Primary is set when conf.Primary is explicitly configured.
	Primary *storageTargetView `json:"primary,omitempty"`
	// LegacyPrimary names which legacy field (blobPath/memoryStorage/
	// s3/b2/googledrive/googlecloudstorage) is acting as primary instead,
	// when Primary isn't set -- display-only, see legacyPrimaryName.
	LegacyPrimary string              `json:"legacyPrimary,omitempty"`
	Backups       []storageTargetView `json:"backups"`
}

func (s *Store) handleGetStorageConfig(w http.ResponseWriter, r *http.Request, ident *Identity) {
	conf, err := readServerConfigTyped()
	if err != nil {
		http.Error(w, "could not read server config", http.StatusInternalServerError)
		return
	}
	view := storageConfigView{Backups: []storageTargetView{}}
	if conf.Primary != nil {
		v := toView(*conf.Primary, nil)
		view.Primary = &v
	} else {
		// legacyPrimaryName only ever reports a *vendor* field acting as
		// primary (it exists for the backups-list dedup logic below) --
		// it deliberately returns "" when blobPath/memoryStorage is what
		// actually claims /bs/, which is the common case, so check those
		// first here rather than showing a misleading "not configured".
		switch {
		case conf.MemoryStorage:
			view.LegacyPrimary = "memoryStorage"
		case conf.BlobPath != "":
			view.LegacyPrimary = "blobPath"
		default:
			view.LegacyPrimary = legacyPrimaryName(conf)
		}
	}
	primaryName := legacyPrimaryName(conf)
	for _, name := range legacyVendorNames {
		val := legacyVendorValue(conf, name)
		if val == "" || name == primaryName {
			continue
		}
		// Legacy fields are plain colon-strings, not structured --
		// show just enough to identify them (name/type), not a full
		// parse back into every field. Editing a legacy backup in
		// detail requires re-entering it as a replicateTo entry (see
		// handleAddOrUpdateBackup); this view is for listing/deleting.
		status := s.syncStatus(name)
		view.Backups = append(view.Backups, storageTargetView{
			Name:   name,
			Type:   name,
			Status: &status,
			Legacy: true,
		})
	}
	for _, t := range conf.ReplicateTo {
		status := s.syncStatus(t.Name)
		view.Backups = append(view.Backups, toView(t, &status))
	}
	writeJSON(w, view)
}

// handleAddOrUpdateBackup saves a replicateTo entry, keyed by Name. An
// empty secret field means "keep existing" on edit, same convention as
// notifications.go's handleSetSMTPConfig.
func (s *Store) handleAddOrUpdateBackup(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body serverconfig.StorageTarget
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Name == "" {
		http.Error(w, "missing \"name\"", http.StatusBadRequest)
		return
	}
	if !blobserver.KnownStorageConstructor(lowLevelStorageType(body.Type)) {
		http.Error(w, fmt.Sprintf("unknown storage type %q", body.Type), http.StatusBadRequest)
		return
	}

	conf, err := readServerConfigTyped()
	if err != nil {
		http.Error(w, "could not read server config", http.StatusInternalServerError)
		return
	}
	if name := legacyPrimaryName(conf); name == body.Name {
		http.Error(w, fmt.Sprintf("%q is currently your primary storage (via the legacy %q field), not a backup", body.Name, name), http.StatusBadRequest)
		return
	}

	existingIdx := -1
	for i, t := range conf.ReplicateTo {
		if t.Name == body.Name {
			existingIdx = i
			break
		}
	}
	if existingIdx >= 0 {
		existing := conf.ReplicateTo[existingIdx]
		if body.AWSSecretKey == "" {
			body.AWSSecretKey = existing.AWSSecretKey
		}
		if body.GCSClientSecret == "" {
			body.GCSClientSecret = existing.GCSClientSecret
		}
		if body.GCSRefreshToken == "" {
			body.GCSRefreshToken = existing.GCSRefreshToken
		}
		if body.GCSServiceAccountKey == "" {
			body.GCSServiceAccountKey = existing.GCSServiceAccountKey
		}
		if body.GoogleClientSecret == "" {
			body.GoogleClientSecret = existing.GoogleClientSecret
		}
		if body.GoogleRefreshToken == "" {
			body.GoogleRefreshToken = existing.GoogleRefreshToken
		}
	}
	// Validate the merged target actually produces a usable low-level
	// config before saving it -- catches a missing bucket/path/parent_id
	// etc. up front, same spirit as handleTestStorage but free (no
	// network I/O; storagetarget.Args alone does no I/O).
	if _, _, err := storagetarget.Args(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if existingIdx >= 0 {
		conf.ReplicateTo[existingIdx] = body
	} else {
		conf.ReplicateTo = append(conf.ReplicateTo, body)
	}

	if err := saveStorageFields(conf); err != nil {
		http.Error(w, "could not save server config", http.StatusInternalServerError)
		return
	}
	writeJSON(w, struct {
		OK              bool `json:"ok"`
		RestartRequired bool `json:"restartRequired"`
	}{true, true})
}

// handleDeleteBackup removes a backup by name -- either a replicateTo
// entry, or (per this project's decision to allow it) a legacy vendor
// field, cleared back to "".
func (s *Store) handleDeleteBackup(w http.ResponseWriter, r *http.Request, ident *Identity) {
	name := adminStorageBackupTarget(s, r)
	if name == "" {
		http.Error(w, "missing backup name", http.StatusBadRequest)
		return
	}
	conf, err := readServerConfigTyped()
	if err != nil {
		http.Error(w, "could not read server config", http.StatusInternalServerError)
		return
	}
	if legacyVendorValue(conf, name) != "" {
		setLegacyVendorValue(conf, name, "")
	} else {
		found := false
		out := conf.ReplicateTo[:0]
		for _, t := range conf.ReplicateTo {
			if t.Name == name {
				found = true
				continue
			}
			out = append(out, t)
		}
		if !found {
			http.Error(w, "no such backup", http.StatusNotFound)
			return
		}
		conf.ReplicateTo = out
	}
	if err := saveStorageFields(conf); err != nil {
		http.Error(w, "could not save server config", http.StatusInternalServerError)
		return
	}
	writeJSON(w, struct {
		OK              bool `json:"ok"`
		RestartRequired bool `json:"restartRequired"`
	}{true, true})
}

// handlePromoteBackup is the only way the primary changes -- see
// docs/multi-tenant-roadmap.md. It promotes a caught-up backup (refusing,
// unless force is set, when its SyncHandler reports a backlog) to
// Primary, and moves the previous primary into ReplicateTo as a new
// backup (a fresh, reverse-direction SyncHandler gets wired for it on
// restart), so the pair stays redundant after failover.
func (s *Store) handlePromoteBackup(w http.ResponseWriter, r *http.Request, ident *Identity) {
	name := adminStorageBackupTarget(s, r)
	if name == "" {
		http.Error(w, "missing backup name", http.StatusBadRequest)
		return
	}
	var body struct {
		Force bool `json:"force"`
		// KeepOldPrimary defaults to true (keep redundancy after
		// failover) when omitted -- pass false only when the previous
		// primary is actually gone (a dead disk) and there's nothing to
		// sync back from.
		KeepOldPrimary *bool `json:"keepOldPrimary,omitempty"`
	}
	// An empty body is fine too -- default everything.
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
	}
	keepOldPrimary := body.KeepOldPrimary == nil || *body.KeepOldPrimary

	conf, err := readServerConfigTyped()
	if err != nil {
		http.Error(w, "could not read server config", http.StatusInternalServerError)
		return
	}

	status := s.syncStatus(name)
	if !status.Caught && !body.Force {
		http.Error(w, fmt.Sprintf("backup %q is not caught up yet (%d blobs, %d bytes still queued) -- pass force:true to promote anyway and accept losing anything still queued", name, status.BlobsRemaining, status.BytesRemaining), http.StatusConflict)
		return
	}

	var promoted serverconfig.StorageTarget
	var ok bool
	idx := -1
	for i, t := range conf.ReplicateTo {
		if t.Name == name {
			promoted, idx = t, i
			ok = true
			break
		}
	}
	if !ok {
		if val := legacyVendorValue(conf, name); val != "" && name != legacyPrimaryName(conf) {
			http.Error(w, fmt.Sprintf("promoting a legacy %q backup requires re-adding it as a named backup first (see the storage panel's \"Add backup\")", name), http.StatusBadRequest)
			return
		}
		http.Error(w, "no such backup", http.StatusNotFound)
		return
	}

	// Build the previous primary's own StorageTarget, to carry forward
	// as a new backup -- defaulting true (keep redundancy after
	// failover) unless the caller explicitly says the old primary is
	// gone and there's nothing to sync back from.
	var oldPrimary *serverconfig.StorageTarget
	if conf.Primary != nil {
		t := *conf.Primary
		t.Name = "previous-primary"
		oldPrimary = &t
	}
	// A legacy-field or blobPath/memoryStorage primary can't be
	// re-expressed as a StorageTarget automatically today (blobPath's
	// packBlobs/packRelated nuances aren't modeled by StorageTarget --
	// see wirePrimaryTarget's doc comment) -- the admin keeps the old
	// primary's config as-is and can wire it back manually if wanted.

	// If the old primary was a legacy field (blobPath/memoryStorage/a
	// vendor field) rather than an explicit Primary, capture its
	// synthetic name now, before clearing it below -- oldPrimary (the
	// StorageTarget form) is only ever set from conf.Primary, since
	// legacy primaries can't be re-expressed as a StorageTarget
	// automatically (see the comment above).
	clearedLegacyName := legacyPrimaryName(conf)

	conf.ReplicateTo = append(conf.ReplicateTo[:idx], conf.ReplicateTo[idx+1:]...)
	conf.Primary = nil
	conf.PackRelated = false // only ever meaningful for a *local* blobpacked primary; never carried forward.
	// wirePrimaryTarget deliberately rejects "localdisk"/"diskpacked"/
	// "memory" for the generic Primary field (local/in-memory primary
	// storage stays exclusively the legacy BlobPath/MemoryStorage
	// fields' job -- see its doc comment). A backup of one of those
	// types being promoted has to be routed back into those legacy
	// fields instead, or the resulting config fails to boot.
	switch promoted.Type {
	case "localdisk":
		conf.BlobPath = promoted.Path
		conf.MemoryStorage = false
		conf.PackBlobs = false
	case "diskpacked":
		conf.BlobPath = promoted.Path
		conf.MemoryStorage = false
		conf.PackBlobs = true
	case "memory":
		conf.BlobPath = ""
		conf.MemoryStorage = true
		conf.PackBlobs = false
	default:
		// Cloud/remote primary. Deliberately leave BlobPath/MemoryStorage
		// untouched (not cleared) -- wirePrimaryTarget takes over /bs/
		// whenever Primary is set regardless of their value, but
		// addReplicationTarget still needs one of them to exist purely
		// to hold each backup's own replication queue file, independent
		// of what's primary (see the relaxed check in build()). Clearing
		// them here would make it impossible to ever add a backup again
		// once a cloud target is promoted.
		promoted.Name = "" // Name is meaningless for Primary
		conf.Primary = &promoted
	}
	if clearedLegacyName != "" {
		setLegacyVendorValue(conf, clearedLegacyName, "")
	}
	if oldPrimary != nil && keepOldPrimary {
		oldPrimary.Name = uniqueBackupName(conf.ReplicateTo, oldPrimary.Name)
		conf.ReplicateTo = append(conf.ReplicateTo, *oldPrimary)
	}

	if err := saveStorageFields(conf); err != nil {
		http.Error(w, "could not save server config", http.StatusInternalServerError)
		return
	}
	writeJSON(w, struct {
		OK              bool `json:"ok"`
		RestartRequired bool `json:"restartRequired"`
	}{true, true})
}

// handleTestStorage builds a (possibly unsaved) StorageTarget from the
// request body and does one cheap, read-only round trip against it --
// proving credentials/connectivity without writing to the real target or
// requiring the config to be saved first. Mirrors notifications.go's
// handleTestSend: the real underlying error is returned verbatim, since
// that's exactly what an admin debugging a storage config needs to see.
func (s *Store) handleTestStorage(w http.ResponseWriter, r *http.Request, ident *Identity) {
	var body serverconfig.StorageTarget
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	handlerType, args, err := storagetarget.Args(body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sto, err := blobserver.CreateStorage(handlerType, noopLoader{}, args)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	// A nonexistent ref: StatBlobs should return cleanly having found
	// nothing, proving the round trip (auth, connectivity, bucket/
	// container existence) works without writing anything.
	probe := blob.RefFromString("storage-test-probe")
	err = sto.StatBlobs(r.Context(), []blob.Ref{probe}, func(blob.SizedRef) error { return nil })
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, struct{ OK bool }{true})
}

// noopLoader is a minimal blobserver.Loader for handleTestStorage's
// throwaway storage -- it never resolves sibling handlers (there are
// none to resolve; the target under test is self-contained), it just
// needs to satisfy the interface.
type noopLoader struct{}

func (noopLoader) MyPrefix() string                           { return "/admin-storage-test/" }
func (noopLoader) BaseURL() string                             { return "" }
func (noopLoader) GetHandlerType(prefix string) string         { return "" }
func (noopLoader) GetHandler(prefix string) (any, error) {
	return nil, blobserver.ErrHandlerTypeNotFound
}
func (noopLoader) GetStorage(prefix string) (blobserver.Storage, error) {
	return nil, blobserver.ErrHandlerTypeNotFound
}
func (noopLoader) FindHandlerByType(handlerType string) (prefix string, handler any, err error) {
	return "", nil, blobserver.ErrHandlerTypeNotFound
}
func (noopLoader) AllHandlers() (map[string]string, map[string]any) {
	return map[string]string{}, map[string]any{}
}
func (noopLoader) Health() *health.Monitor { return nil }

// lowLevelStorageType maps the friendly "localdisk" schema name back to
// the historical registered type "filesystem" -- see
// storagetarget.lowLevelType's identical mapping; duplicated here (one
// line) rather than exported from storagetarget, to keep that package's
// surface area to just Args.
func lowLevelStorageType(typ string) string {
	if typ == "localdisk" {
		return "filesystem"
	}
	return typ
}

// uniqueBackupName returns base, or base suffixed with "-2", "-3", ...
// if base is already used by an entry in existing (e.g. a second
// promotion in a row would otherwise collide on "previous-primary").
func uniqueBackupName(existing []serverconfig.StorageTarget, base string) string {
	used := map[string]bool{}
	for _, t := range existing {
		used[t.Name] = true
	}
	if !used[base] {
		return base
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s-%d", base, n)
		if !used[candidate] {
			return candidate
		}
	}
}

func setLegacyVendorValue(conf *serverconfig.Config, name, val string) {
	switch name {
	case "s3":
		conf.S3 = val
	case "b2":
		conf.B2 = val
	case "googledrive":
		conf.GoogleDrive = val
	case "googlecloudstorage":
		conf.GoogleCloudStorage = val
	}
}

// saveStorageFields re-reads the config file as a raw map (so unrelated
// keys are preserved byte-for-byte) and overwrites only the
// storage-related keys from conf, which the caller has already mutated
// starting from a readServerConfigTyped() snapshot.
func saveStorageFields(conf *serverconfig.Config) error {
	m, err := readServerConfigRaw()
	if err != nil {
		return err
	}
	fields := map[string]any{
		"primary":            conf.Primary,
		"replicateTo":        conf.ReplicateTo,
		"blobPath":           conf.BlobPath,
		"memoryStorage":      conf.MemoryStorage,
		"packBlobs":          conf.PackBlobs,
		"packRelated":        conf.PackRelated,
		"s3":                 conf.S3,
		"b2":                 conf.B2,
		"googledrive":        conf.GoogleDrive,
		"googlecloudstorage": conf.GoogleCloudStorage,
	}
	for key, v := range fields {
		if err := setRawField(m, key, v); err != nil {
			return err
		}
	}
	return writeServerConfigRaw(m)
}

// adminStorageBackupTarget pulls the {name} path segment out of
// "admin/storage/backups/{name}" or "admin/storage/backups/{name}/promote",
// the same way adminUserTarget does for admin/users/{username}.
func adminStorageBackupTarget(s *Store, r *http.Request) string {
	rel := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, s.prefix), "/")
	rest := strings.TrimPrefix(rel, "admin/storage/backups/")
	if i := strings.Index(rest, "/"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}
