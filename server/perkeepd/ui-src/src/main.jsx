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
// prefix. The document always lives at "<prefix>/index.html" (ui.go's ServeHTTP falls back
// to index.html for everything that isn't a known API path or a built asset), so the
// prefix is everything up to and including the trailing slash of the current path.
const basename = window.location.pathname.replace(/[^/]*$/, "");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
