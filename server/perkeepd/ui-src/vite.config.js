import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Perkeep's UIHandler (pkg/server/ui.go) mounts this SPA at whatever prefix the user's
// server config gives the "ui" handler (often "/ui/", but configurable) -- there's no way
// to know that prefix at build time, so every asset reference must be relative to the HTML
// document, not absolute from "/". Vite's relative base ("./") does exactly that.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    // pkg/server/ui.go's UIHandler embeds and serves this directory directly (see
    // ../ui/fileembed.go) -- build straight into it rather than copying after the fact.
    outDir: "../ui/dist",
    emptyOutDir: true,
  },
  server: {
    // For `npm run dev` against a real perkeepd: proxy API calls through to it so the
    // app can be iterated on with Vite's dev server (fast HMR) while still hitting real
    // data. Adjust the target to wherever perkeepd is actually listening.
    proxy: {
      "/camli": { target: "http://127.0.0.1:3179", changeOrigin: true },
      "/ui/camli": { target: "http://127.0.0.1:3179", changeOrigin: true },
    },
  },
});
