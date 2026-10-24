import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getExif } from "../api/client.js";

const DIR_LABELS = { IFD0: "Image", IFD1: "Thumbnail", Exif: "Camera settings", GPS: "Location" };

function humanize(name) {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

// On-demand (not from search describe) EXIF viewer -- port of exif_detail.js.
// Read-only; the camera make/model callout links to a `camera:` search.
export default function ExifAspect({ fileRef }) {
  const [state, setState] = useState({ loading: true, tags: null, error: null });
  const navigate = useNavigate();

  useEffect(() => {
    setState({ loading: true, tags: null, error: null });
    getExif(fileRef)
      .then((r) => setState({ loading: false, tags: r.tags || [], error: null }))
      .catch((e) => setState({ loading: false, tags: null, error: String(e) }));
  }, [fileRef]);

  if (state.loading) return <div className="p-3 text-muted">{"Loading EXIF…"}</div>;
  if (state.error) return <div className="p-3 text-muted">No EXIF data available.</div>;

  const make = state.tags.find((t) => t.tag === "010f");
  const model = state.tags.find((t) => t.tag === "0110");
  const camera = [make?.values?.[0], model?.values?.[0]].filter(Boolean).join(" ");

  const grouped = new Map();
  for (const tag of state.tags) {
    if (tag === make || tag === model) continue;
    const label = DIR_LABELS[tag.directory] || "EXIF directory";
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(tag);
  }

  function searchCamera() {
    const needsRaw = /[*~]/.test(camera);
    const q = needsRaw
      ? JSON.stringify({ file: { camera: { contains: camera } } })
      : `camera:"${camera}"`;
    navigate(`/?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="p-3">
      <div className="d-flex justify-content-between align-items-start mb-3">
        <h5 className="mb-0">EXIF</h5>
        <span className="badge text-bg-secondary">Read-only</span>
      </div>
      {camera && (
        <div className="alert alert-light border mb-3">
          <strong>Camera:</strong>{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); searchCamera(); }}>
            {camera}
          </a>
        </div>
      )}
      {[...grouped.entries()].map(([label, tags]) => (
        <div key={label} className="mb-3">
          <h6>{label}</h6>
          <table className="table table-sm">
            <tbody>
              {tags.map((t) => (
                <tr key={t.tag}>
                  <td>{humanize(t.name)}</td>
                  <td className="text-muted small">{t.tag}</td>
                  <td><ExifValue value={t.values.join(", ")} /></td>
                  <td className="text-muted small">{t.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function ExifValue({ value }) {
  const [open, setOpen] = useState(false);
  if (value.length <= 200) return value;
  return open ? (
    value
  ) : (
    <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setOpen(true)}>
      Show full value
    </button>
  );
}
