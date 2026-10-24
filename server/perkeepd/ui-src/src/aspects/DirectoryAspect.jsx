import { useEffect, useState } from "react";

import { addAttribute, createPermanode, getFileTree } from "../api/client.js";

// Recursively-expandable file tree -- port of directory_detail.js. Root is
// always expanded; children are fetched lazily, once, on expand. The "P"
// link creates a new permanode wrapping that exact file/dir blob (so it can
// be tagged/organized), same as the old UI -- it does not navigate there.
export default function DirectoryAspect({ disco, blobref, depth = 0 }) {
  const [children, setChildren] = useState(null);
  const [expanded, setExpanded] = useState(depth === 0);
  const [creating, setCreating] = useState(null);

  useEffect(() => {
    if (expanded && children === null) {
      getFileTree(disco, blobref).then((r) => setChildren(r.children || []));
    }
  }, [expanded, children, disco, blobref]);

  async function createWrapper(ref) {
    setCreating(ref);
    try {
      const pm = await createPermanode();
      await addAttribute(pm, "camliContent", ref);
      window.alert(`Created permanode ${pm} for this item.`);
    } finally {
      setCreating(null);
    }
  }

  return (
    <div style={{ paddingLeft: depth * 16 }}>
      {depth > 0 && (
        <button
          type="button"
          className="btn btn-sm btn-link p-0 me-1"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "−" : "+"}
        </button>
      )}
      {expanded && (
        <ul className="list-unstyled mb-0">
          {(children || []).map((child) => (
            <li key={child.blobRef} className="d-flex align-items-center gap-2">
              <i className={`bi ${child.type === "directory" ? "bi-folder" : "bi-file-earmark"}`} />
              <a href={`./${child.blobRef}`}>{child.name}</a>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary py-0 px-1"
                disabled={creating === child.blobRef}
                title="Create a permanode wrapping this item"
                onClick={() => createWrapper(child.blobRef)}
              >
                P
              </button>
              {child.type === "directory" && (
                <DirectoryAspect disco={disco} blobref={child.blobRef} depth={depth + 1} />
              )}
            </li>
          ))}
          {children && children.length === 0 && <li className="text-muted small">Empty directory</li>}
        </ul>
      )}
    </div>
  );
}
