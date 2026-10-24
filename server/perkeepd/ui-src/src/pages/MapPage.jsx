import "leaflet/dist/leaflet.css";
import L from "leaflet";
import "leaflet.markercluster";
import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import { useNavigate, useSearchParams } from "react-router-dom";

import { bucketHeight, detailUrl, search, thumbnailUrl } from "../api/client.js";
import { resolvedFile, titleOf } from "../content/classify.js";
import { useAppContext } from "../context/AppContext.jsx";

// Fix Leaflet's default marker icon URLs, which assume a bundler-unaware
// relative path that Vite doesn't preserve.
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

const QUERY_LIMIT = 250;
const DEBOUNCE_MS = 500;

// Port of map.js/mapquery.js: a debounced, pan/zoom-driven search using the
// `locrect:` predicate, with marker clustering (gated on discovery's
// mapClustering flag). Pixel-perfect marker icon styling (Leaflet
// AwesomeMarkers + Font Awesome) is not reproduced -- Leaflet's own default
// pin is used instead -- but clustering, popups, and viewport-driven search
// are all real.
function MapLayer({ disco, baseQuery, onCountChange }) {
  const map = useMap();
  const clusterGroupRef = useRef(null);
  const debounceRef = useRef(null);
  const skipFirstZoomend = useRef(true);
  const navigate = useNavigate();

  useEffect(() => {
    const group = disco.mapClustering ? L.markerClusterGroup() : L.layerGroup();
    clusterGroupRef.current = group;
    map.addLayer(group);
    return () => map.removeLayer(group);
  }, [map, disco.mapClustering]);

  async function runQuery() {
    const bounds = map.getBounds();
    const locrect = `locrect:${bounds.getNorth()},${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()}`;
    const expr = baseQuery ? `${baseQuery} ${locrect}` : `has:location ${locrect}`;
    const result = await search(expr, { sort: "map", limit: disco.mapClustering ? QUERY_LIMIT : 100 });
    const group = clusterGroupRef.current;
    if (!group) return;
    group.clearLayers();
    const meta = result.description?.meta || {};
    let count = 0;
    for (const { blob: ref } of result.blobs || []) {
      const described = meta[ref];
      const loc = described?.location;
      if (!loc) continue;
      count++;
      const marker = L.marker([loc.latitude, loc.longitude]);
      const file = resolvedFile(meta, described);
      const title = titleOf(meta, ref);
      const thumb = file?.image ? thumbnailUrl(disco, file.blobRef, file.file?.fileName, { mh: bucketHeight(64) }) : null;
      const html = thumb
        ? `<a href="${detailUrl(disco, ref)}"><img src="${thumb}" width="64" height="64" style="object-fit:cover"/></a>`
        : `<a href="${detailUrl(disco, ref)}">${title}</a>`;
      marker.bindPopup(html);
      group.addLayer(marker);
    }
    onCountChange(count);
  }

  useEffect(() => {
    function onMoveEnd() {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(runQuery, DEBOUNCE_MS);
    }
    function onZoomEnd() {
      if (skipFirstZoomend.current) {
        skipFirstZoomend.current = false;
        return;
      }
      onMoveEnd();
    }
    map.on("moveend", onMoveEnd);
    map.on("zoomend", onZoomEnd);
    runQuery();
    return () => {
      map.off("moveend", onMoveEnd);
      map.off("zoomend", onZoomEnd);
      clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, baseQuery]);

  return null;
}

export default function MapPage() {
  const { disco } = useAppContext();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(params.get("q") || "");
  const [count, setCount] = useState(null);

  if (!disco) return null;

  return (
    <div>
      <form
        className="d-flex gap-2 mb-2"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(draft ? { q: draft } : {});
        }}
      >
        <input
          className="form-control"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Optional search to combine with the current map view"
        />
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
      </form>
      {count !== null && <div className="small text-muted mb-2">{count} located item(s) in view</div>}
      <MapContainer center={[20, 0]} zoom={2} style={{ height: "70vh", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapLayer disco={disco} baseQuery={params.get("q") || ""} onCountChange={setCount} />
      </MapContainer>
    </div>
  );
}
