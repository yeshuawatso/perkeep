/*
Copyright 2011 The Perkeep Authors

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

/*
Package ui contains the resources for the Perkeep web UI: the built output of the React
SPA in ../ui-src (npm run build there writes straight into ./dist -- see ui-src/vite.config.js
and pkg/server/ui.go's UIHandler, which serves this tree for every request that isn't one
of the backend's own API routes).
*/
package ui // import "perkeep.org/server/perkeepd/ui"

import (
	"embed"
	"io/fs"
)

//go:embed dist
var distFiles embed.FS

// Files is the built SPA's root: Files.Open("index.html"), Files.Open("assets/foo.js"), etc.
var Files, _ = fs.Sub(distFiles, "dist")
