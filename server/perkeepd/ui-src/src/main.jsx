import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "./styles/app.css";

import App from "./App.jsx";

// perkeepd serves this SPA from whatever prefix the "ui" handler is configured at (often
// "/ui/", but not guaranteed) -- basename has to come from where the document actually
// loaded from, not a hardcoded guess, or client-side routing/links break under any other
// prefix. Stripping the last segment off window.location.pathname only works one level
// deep (e.g. "/ui/map"); a route with its own path segment, like "detail/:blobref", needs
// two segments stripped, and there's no way to tell from the current pathname alone how
// much of it is "prefix" versus "route" -- loading "/ui/detail/<ref>" directly used to
// compute basename "/ui/detail/" and silently match no route at all (blank page, no error).
// pkg/server/ui.go knows its own prefix and now renders a <base href> for it into every
// response that serves this shell, so read that instead of guessing from the URL. Dev mode
// (vite dev server, no Go-rendered <base>) falls back to "/".
const baseTag = document.querySelector("base");
const basename = baseTag ? new URL(baseTag.href).pathname : "/";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
