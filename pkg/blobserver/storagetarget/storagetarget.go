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

// Package storagetarget translates a serverconfig.StorageTarget (the
// generic, driver-agnostic shape used by Config.Primary and
// Config.ReplicateTo, and by the admin-UI storage panel) into the
// low-level blobserver handler type + jsonconfig args that
// blobserver.CreateStorage needs.
//
// This logic lives in its own leaf package, rather than in
// pkg/serverinit (which builds the full low-level config at boot) or
// pkg/accounts (which uses it for the admin UI's "test connection"
// action), because pkg/accounts cannot import pkg/serverinit: both
// pkg/serverinit and pkg/blobserver/handlers already import pkg/accounts,
// so the reverse import would be a cycle. Both sides import this package
// instead.
package storagetarget // import "perkeep.org/pkg/blobserver/storagetarget"

import (
	"fmt"
	"path"

	"go4.org/jsonconfig"

	"perkeep.org/internal/secret"
	"perkeep.org/pkg/blobserver"
	"perkeep.org/pkg/types/serverconfig"
)

// Args translates t into the low-level blobserver handler type and
// jsonconfig args blobserver.CreateStorage(handlerType, loader, args)
// needs, validating fields and resolving credential values (the same
// "@path"/"@@" conventions as the rest of the high-level config, see
// internal/secret) along the way. It does not create the storage itself,
// and does no network I/O.
func Args(t serverconfig.StorageTarget) (handlerType string, args jsonconfig.Obj, err error) {
	if t.Type == "" {
		return "", nil, fmt.Errorf("storage target %q: missing \"type\"", t.Name)
	}
	if !blobserver.KnownStorageConstructor(lowLevelType(t.Type)) {
		return "", nil, fmt.Errorf("storage target %q: unknown type %q", t.Name, t.Type)
	}
	switch t.Type {
	case "s3":
		return s3Args(t, false)
	case "b2":
		return s3Args(t, true)
	case "googlecloudstorage":
		return gcsArgs(t)
	case "googledrive":
		return driveArgs(t)
	case "localdisk":
		return localdiskArgs(t)
	case "diskpacked":
		return diskpackedArgs(t)
	case "memory":
		return "memory", jsonconfig.Obj{}, nil
	default:
		// Unreachable: lowLevelType/KnownStorageConstructor above would
		// already have rejected anything not handled here.
		return "", nil, fmt.Errorf("storage target %q: unsupported type %q", t.Name, t.Type)
	}
}

// lowLevelType maps a StorageTarget.Type to the string it's registered
// under via blobserver.RegisterStorageConstructor, where that differs
// from the friendly name used in this package's own schema (currently
// only "localdisk", which the pkg/blobserver/localdisk package itself
// registers as "filesystem" -- kept as "localdisk" here since that
// matches the Go package name and is clearer to an admin than the
// low-level historical name).
func lowLevelType(typ string) string {
	if typ == "localdisk" {
		return "filesystem"
	}
	return typ
}

// resolveField resolves value via secret.Resolve ("@path" reads a file,
// "@@" escapes a literal leading "@"), wrapping any error with field for
// a clearer message. An empty value resolves to "" unchanged.
func resolveField(field, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	v, err := secret.Resolve(value)
	if err != nil {
		return "", fmt.Errorf("storage target: %s: %w", field, err)
	}
	return v, nil
}

// bucketWithDir joins bucket and dir the same way the s3/googlecloudstorage
// drivers themselves split a combined "bucket/dir" string back apart
// (see their own newFromConfig): a plain path join is exactly what they
// expect to receive and re-split.
func bucketWithDir(bucket, dir string) string {
	if dir == "" {
		return bucket
	}
	return path.Join(bucket, dir)
}

func s3Args(t serverconfig.StorageTarget, isB2 bool) (string, jsonconfig.Obj, error) {
	if t.Bucket == "" {
		return "", nil, fmt.Errorf("storage target %q: \"bucket\" is required", t.Name)
	}
	accessKey, err := resolveField("awsAccessKey", t.AWSAccessKey)
	if err != nil {
		return "", nil, err
	}
	secretKey, err := resolveField("awsSecretKey", t.AWSSecretKey)
	if err != nil {
		return "", nil, err
	}
	if isB2 {
		// B2's endpoint isn't AWS, so (a) there's no IAM-style default
		// credential chain to fall back to the way plain "s3" can -- see
		// pkg/blobserver/s3's handling of omitted keys -- and (b) a
		// hostname is required, not optional: the driver treats an empty
		// hostname as "this is really AWS" (see s3.go's isAWSHostname
		// check), which would silently send B2 credentials/requests to
		// AWS's own endpoint instead of Backblaze's.
		if accessKey == "" || secretKey == "" {
			return "", nil, fmt.Errorf("storage target %q: awsAccessKey and awsSecretKey are both required for type \"b2\"", t.Name)
		}
		if t.Hostname == "" {
			return "", nil, fmt.Errorf("storage target %q: \"hostname\" is required for type \"b2\" (Backblaze's own S3-compatible endpoint, e.g. \"s3.us-west-002.backblazeb2.com\")", t.Name)
		}
	}
	args := jsonconfig.Obj{
		"bucket": bucketWithDir(t.Bucket, t.Dir),
	}
	if accessKey != "" {
		args["aws_access_key"] = accessKey
	}
	if secretKey != "" {
		args["aws_secret_access_key"] = secretKey
	}
	if t.Hostname != "" {
		args["hostname"] = t.Hostname
	}
	typ := "s3"
	if isB2 {
		typ = "b2"
	}
	return typ, args, nil
}

func gcsArgs(t serverconfig.StorageTarget) (string, jsonconfig.Obj, error) {
	if t.Bucket == "" {
		return "", nil, fmt.Errorf("storage target %q: \"bucket\" is required", t.Name)
	}
	serviceAccountJSON, err := resolveField("gcsServiceAccountKey", t.GCSServiceAccountKey)
	if err != nil {
		return "", nil, err
	}
	clientSecret, err := resolveField("gcsClientSecret", t.GCSClientSecret)
	if err != nil {
		return "", nil, err
	}
	refreshToken, err := resolveField("gcsRefreshToken", t.GCSRefreshToken)
	if err != nil {
		return "", nil, err
	}

	// jsonconfig.RequiredObject on the parent config asserts its value is a
	// plain map[string]any -- a nested jsonconfig.Obj (a named type over the
	// same underlying map) fails that type assertion even though it's
	// structurally identical, so this must stay map[string]any, not
	// jsonconfig.Obj, to match the pattern genconfig.go already uses for
	// the same nesting (e.g. addGoogleCloudStorageConfig).
	auth := map[string]any{}
	switch {
	case serviceAccountJSON != "":
		if t.GCSClientID != "" {
			return "", nil, fmt.Errorf("storage target %q: gcsServiceAccountKey and gcsClientID are mutually exclusive", t.Name)
		}
		auth["service_account_json"] = serviceAccountJSON
	case t.GCSClientID != "":
		auth["client_id"] = t.GCSClientID
		if clientSecret != "" {
			auth["client_secret"] = clientSecret
		}
		if refreshToken != "" {
			auth["refresh_token"] = refreshToken
		}
	default:
		return "", nil, fmt.Errorf("storage target %q: must set one of gcsServiceAccountKey, gcsClientID=\"auto\", or gcsClientID/gcsClientSecret/gcsRefreshToken", t.Name)
	}

	return "googlecloudstorage", jsonconfig.Obj{
		"bucket": bucketWithDir(t.Bucket, t.Dir),
		"auth":   auth,
	}, nil
}

func driveArgs(t serverconfig.StorageTarget) (string, jsonconfig.Obj, error) {
	if t.GoogleDriveParentID == "" {
		return "", nil, fmt.Errorf("storage target %q: \"googleDriveParentID\" is required", t.Name)
	}
	clientID, err := resolveField("googleClientID", t.GoogleClientID)
	if err != nil {
		return "", nil, err
	}
	clientSecret, err := resolveField("googleClientSecret", t.GoogleClientSecret)
	if err != nil {
		return "", nil, err
	}
	refreshToken, err := resolveField("googleRefreshToken", t.GoogleRefreshToken)
	if err != nil {
		return "", nil, err
	}
	if clientID == "" || clientSecret == "" || refreshToken == "" {
		return "", nil, fmt.Errorf("storage target %q: googleClientID, googleClientSecret, and googleRefreshToken are all required for type \"googledrive\" (see doc/server-config.md for how to obtain a refresh token)", t.Name)
	}
	return "googledrive", jsonconfig.Obj{
		"parent_id": t.GoogleDriveParentID,
		// See the comment on gcsArgs' "auth" map -- must be map[string]any,
		// not jsonconfig.Obj, or RequiredObject rejects it downstream.
		"auth": map[string]any{
			"client_id":     clientID,
			"client_secret": clientSecret,
			"refresh_token": refreshToken,
		},
	}, nil
}

func localdiskArgs(t serverconfig.StorageTarget) (string, jsonconfig.Obj, error) {
	if t.Path == "" {
		return "", nil, fmt.Errorf("storage target %q: \"path\" is required", t.Name)
	}
	return "filesystem", jsonconfig.Obj{"path": t.Path}, nil
}

func diskpackedArgs(t serverconfig.StorageTarget) (string, jsonconfig.Obj, error) {
	if t.Path == "" {
		return "", nil, fmt.Errorf("storage target %q: \"path\" is required", t.Name)
	}
	return "diskpacked", jsonconfig.Obj{"path": t.Path}, nil
}
