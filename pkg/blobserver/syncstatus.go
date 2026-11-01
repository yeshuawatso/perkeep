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

package blobserver

// SyncStatus is a snapshot of an async replication handler's progress
// (see pkg/server's SyncHandler, which implements SyncStatuser). It
// lives in this leaf package, rather than alongside SyncHandler itself
// in pkg/server, so that pkg/accounts -- which cannot import pkg/server
// (pkg/server already imports pkg/accounts for ownership checks) -- can
// still read live replication status for its admin-UI storage panel
// (see pkg/accounts/storage.go), by looking up the handler via
// FindHandlerByTyper.AllHandlers() and type-asserting to SyncStatuser,
// without needing pkg/server's own types at all.
type SyncStatus struct {
	// BlobsRemaining and BytesRemaining count what's still queued for
	// replication but not yet confirmed copied -- zero means caught up.
	BlobsRemaining int
	BytesRemaining int64

	// LastCopySecondsAgo is how long ago the last blob was copied, or -1
	// if none has been copied yet this run.
	LastCopySecondsAgo int

	// RecentErrors is the count of replication errors seen so far (not
	// necessarily still failing -- a blob that failed and later
	// succeeded still counts here).
	RecentErrors int64
}

// Caught reports whether status indicates the replication target has no
// known backlog -- the gate pkg/accounts' storage panel uses to decide
// whether promoting this target to primary is safe without forcing.
func (s SyncStatus) Caught() bool {
	return s.BlobsRemaining == 0 && s.BytesRemaining == 0
}

// SyncStatuser is implemented by async replication handlers (currently
// only pkg/server's SyncHandler) that can report their own SyncStatus.
type SyncStatuser interface {
	SyncStatus() SyncStatus
}
