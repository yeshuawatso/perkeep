import { useEffect, useState } from "react";

import { detailUrl, edgesTo, getBlobContents, getClaims } from "../api/client.js";

const BLOBREF_RE = /[a-z0-9]+-[0-9a-f]{16,}/gi;

// Auto-linkifies every blobref-shaped substring in a pretty-printed JSON
// block to that blob's own detail page (regex scan, same as the old UI --
// not a real JSON tree walk).
function Linkified({ disco, text }) {
  const parts = text.split(BLOBREF_RE);
  const matches = text.match(BLOBREF_RE) || [];
  return (
    <pre className="bg-body-tertiary p-2 small" style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {matches[i] && <a href={detailUrl(disco, matches[i])}>{matches[i]}</a>}
        </span>
      ))}
    </pre>
  );
}

function pretty(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// Raw, low-level inspector -- port of blob_detail.js's four sections.
export default function BlobAspect({ disco, blobref, blob }) {
  const [content, setContent] = useState(null);
  const [claims, setClaims] = useState(null);
  const [refs, setRefs] = useState(null);

  useEffect(() => {
    getBlobContents(blobref).then((t) => setContent(pretty(t))).catch(() => setContent(null));
    if (blob?.camliType === "permanode") {
      getClaims(blobref).then((r) => setClaims(r.claims || [])).catch(() => setClaims([]));
    }
    edgesTo(blobref).then((r) => setRefs(r.edgesTo || [])).catch(() => setRefs([]));
  }, [blobref, blob?.camliType]);

  return (
    <div className="p-3">
      <h6>Blob content</h6>
      {content != null ? <Linkified disco={disco} text={content} /> : <div className="text-muted small">(binary or unavailable)</div>}

      <h6 className="mt-4">Indexer metadata</h6>
      <Linkified disco={disco} text={JSON.stringify(blob, null, 2)} />

      {claims && (
        <>
          <h6 className="mt-4">Mutation claims</h6>
          {claims.length === 0 ? (
            <div className="text-muted small">No claims.</div>
          ) : (
            <table className="table table-sm">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Attr</th><th>Value</th><th>Signer</th></tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.blobref}>
                    <td className="text-nowrap">{c.date}</td>
                    <td>{c.type}</td>
                    <td>{c.attr}</td>
                    <td className="text-break">{c.value}</td>
                    <td className="text-truncate" style={{ maxWidth: 160 }}>{c.signer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h6 className="mt-4">Referenced by</h6>
      {refs && refs.length > 0 ? (
        <ul>
          {refs.map((r) => (
            <li key={r.from}>
              <a href={detailUrl(disco, r.from)}>{r.from}</a> <span className="text-muted">({r.fromType})</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-muted small">Nothing references this blob.</div>
      )}
    </div>
  );
}
