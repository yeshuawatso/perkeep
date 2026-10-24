import { useEffect, useMemo, useState } from "react";
import Nav from "react-bootstrap/Nav";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { describe } from "../api/client.js";
import { resolvedFile, titleOf } from "../content/classify.js";
import { useAppContext } from "../context/AppContext.jsx";
import AudioAspect from "../aspects/AudioAspect.jsx";
import BlobAspect from "../aspects/BlobAspect.jsx";
import ContentsAspect from "../aspects/ContentsAspect.jsx";
import DirectoryAspect from "../aspects/DirectoryAspect.jsx";
import DocumentAspect from "../aspects/DocumentAspect.jsx";
import ExifAspect from "../aspects/ExifAspect.jsx";
import ImageAspect from "../aspects/ImageAspect.jsx";
import PermanodeAspect from "../aspects/PermanodeAspect.jsx";

const AUDIO_EXT = ["webm", "ogg", "mp3", "wav", "flac"];

function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export default function DetailPage() {
  const { blobref } = useParams();
  const { disco } = useAppContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(null);

  const siblingRefs = location.state?.siblingRefs || null;
  const parentFromState = location.state?.parentRef || null;

  function refetch() {
    return describe([blobref]).then((r) => setMeta((m) => ({ ...m, ...(r.meta || {}) })));
  }

  useEffect(() => {
    setLoading(true);
    describe([blobref])
      .then((r) => setMeta(r.meta || {}))
      .finally(() => setLoading(false));
  }, [blobref]);

  // Left/Right navigate within the sibling list this detail view was opened
  // from (if any); Escape goes back to search. Suppressed while focus is in
  // an input/textarea (e.g. the permanode attribute editor).
  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!siblingRefs) return;
      const idx = siblingRefs.indexOf(blobref);
      if (idx === -1) return;
      if (e.key === "ArrowLeft" && idx > 0) {
        navigate(`/detail/${siblingRefs[idx - 1]}`, { state: location.state });
      } else if (e.key === "ArrowRight" && idx < siblingRefs.length - 1) {
        navigate(`/detail/${siblingRefs[idx + 1]}`, { state: location.state });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [siblingRefs, blobref, navigate, location.state]);

  const blob = meta[blobref];
  const file = useMemo(() => resolvedFile(meta, blob), [meta, blob]);
  const attrs = blob?.permanode?.attr;
  const hasMembers = attrs && (attrs.camliMember?.length > 0 || Object.keys(attrs).some((k) => k.startsWith("camliPath:")));
  const isPermanode = !!blob?.permanode;
  const isImage = !!file?.image;
  const isAudio = file?.file && AUDIO_EXT.includes(ext(file.file.fileName));
  const isDoc = file?.file && (file.file.mimeType === "application/pdf" || file.file.mimeType === "text/plain");
  const isDir = !!file?.dir || blob?.dirChildren;

  const aspects = useMemo(() => {
    const list = [];
    if (hasMembers) list.push({ key: "contents", label: "Contents" });
    if (isImage) list.push({ key: "image", label: "Image" });
    if (isAudio) list.push({ key: "audio", label: "Audio" });
    if (isDoc) list.push({ key: "document", label: "Document" });
    if (isDir) list.push({ key: "directory", label: "Directory" });
    if (isPermanode) list.push({ key: "permanode", label: "Permanode" });
    list.push({ key: "blob", label: "Blob" });
    if (isImage) list.push({ key: "exif", label: "EXIF" });
    return list;
  }, [hasMembers, isImage, isAudio, isDoc, isDir, isPermanode]);

  useEffect(() => {
    if (aspects.length && !aspects.some((a) => a.key === active)) setActive(aspects[0].key);
  }, [aspects, active]);

  if (!disco || loading) return <div className="p-4 text-muted">{"Loading…"}</div>;
  if (!blob) return <div className="p-4 text-muted">Blob not found.</div>;

  const idx = siblingRefs ? siblingRefs.indexOf(blobref) : -1;

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div className="d-flex align-items-center gap-2 text-truncate">
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => navigate(-1)}>
            <i className="bi bi-arrow-left" /> Back
          </button>
          <h5 className="mb-0 text-truncate">{titleOf(meta, blobref)}</h5>
        </div>
        {siblingRefs && idx !== -1 && (
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              disabled={idx <= 0}
              onClick={() => navigate(`/detail/${siblingRefs[idx - 1]}`, { state: location.state })}
            >
              <i className="bi bi-chevron-left" />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              disabled={idx >= siblingRefs.length - 1}
              onClick={() => navigate(`/detail/${siblingRefs[idx + 1]}`, { state: location.state })}
            >
              <i className="bi bi-chevron-right" />
            </button>
          </div>
        )}
      </div>

      <Nav variant="tabs" activeKey={active} onSelect={setActive} className="mb-3">
        {aspects.map((a) => (
          <Nav.Item key={a.key}>
            <Nav.Link eventKey={a.key}>{a.label}</Nav.Link>
          </Nav.Item>
        ))}
      </Nav>

      {active === "contents" && (
        <ContentsAspect disco={disco} permanode={blobref} attrs={attrs} onChanged={refetch} />
      )}
      {active === "image" && <ImageAspect disco={disco} file={file} prevRef={siblingRefs?.[idx - 1]} nextRef={siblingRefs?.[idx + 1]} />}
      {active === "audio" && <AudioAspect disco={disco} file={file} blob={blob} />}
      {active === "document" && <DocumentAspect disco={disco} file={file} />}
      {active === "directory" && <DirectoryAspect disco={disco} blobref={file?.blobRef || blobref} />}
      {active === "permanode" && <PermanodeAspect permanode={blobref} attrs={attrs} onChanged={refetch} />}
      {active === "blob" && <BlobAspect disco={disco} blobref={blobref} blob={blob} />}
      {active === "exif" && <ExifAspect fileRef={file?.blobRef} />}
    </div>
  );
}
