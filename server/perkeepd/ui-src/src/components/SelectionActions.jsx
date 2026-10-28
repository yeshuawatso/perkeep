import { useState } from "react";
import Button from "react-bootstrap/Button";
import Collapse from "react-bootstrap/Collapse";

import {
  addAttribute,
  COLLECTION_NODE_TYPE,
  createPermanode,
  createStaticSet,
  delAttribute,
  deletePermanode,
  downloadUrl,
  joinUrl,
  setAttribute,
} from "../api/client.js";
import { isSet, resolvedFile, titleOf } from "../content/classify.js";
import AddToSetModal from "./AddToSetModal.jsx";
import NewSetModal from "./NewSetModal.jsx";
import ShareModal from "./ShareModal.jsx";
import TagsControl from "./TagsControl.jsx";

function openDownloadForm(disco, refs) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = joinUrl(disco.downloadHelper, "");
  form.style.display = "none";
  const input = document.createElement("input");
  input.name = "files";
  input.value = refs.join(",");
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

// The sidebar's bulk/selection action set -- see perkeep-ui-spec.md §5. Shown
// whenever at least one item is selected, in either the main search/browse
// grid or a container's "Contents" view (parentRef set in the latter case).
export default function SelectionActions({ disco, selectedRefs, meta, onChanged, onClear, parentRef, navigate }) {
  const [busy, setBusy] = useState(false);
  const [shareTarget, setShareTarget] = useState(null);
  const [tagsOpen, setTagsOpen] = useState(true);
  const [showConvert, setShowConvert] = useState(false);
  const [showAddToSet, setShowAddToSet] = useState(false);

  if (selectedRefs.length === 0) return null;

  const singlePermanode = selectedRefs.length === 1 ? selectedRefs[0] : null;
  const singleAttrs = singlePermanode ? meta[singlePermanode]?.permanode?.attr : null;
  const singleFile = singlePermanode ? resolvedFile(meta, meta[singlePermanode]) : null;

  async function run(fn) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  function createSet() {
    run(async () => {
      const pm = await createPermanode();
      await setAttribute(pm, "title", "New set");
      await setAttribute(pm, "camliNodeType", COLLECTION_NODE_TYPE);
      await Promise.all(selectedRefs.map((ref) => addAttribute(pm, "camliMember", ref)));
      navigate(`/detail/${pm}`);
    });
  }

  function convertToSet(name) {
    run(async () => {
      await setAttribute(singlePermanode, "title", name);
      await setAttribute(singlePermanode, "camliNodeType", COLLECTION_NODE_TYPE);
      setShowConvert(false);
      onChanged();
    });
  }

  function removeFromSet() {
    run(async () => {
      await Promise.all(selectedRefs.map((ref) => delAttribute(parentRef, "camliMember", ref)));
      onClear();
      onChanged();
    });
  }

  function deleteItems() {
    const n = selectedRefs.length;
    if (!window.confirm(n === 1 ? "Delete item?" : `Delete ${n} items?`)) return;
    run(async () => {
      await Promise.all(selectedRefs.map((ref) => deletePermanode(ref)));
      onClear();
      onChanged();
    });
  }

  function viewOriginal() {
    if (!singleFile?.blobRef) return;
    window.open(downloadUrl(disco, singleFile.blobRef, singleFile.file?.fileName, { inline: true }), "_blank");
  }

  function download() {
    if (selectedRefs.length === 1 && singleFile?.blobRef) {
      window.open(downloadUrl(disco, singleFile.blobRef, singleFile.file?.fileName));
      return;
    }
    openDownloadForm(disco, selectedRefs);
  }

  // Opens ShareModal for a single file/permanode directly, or (multi-select)
  // bundles the selection into a static set first -- same as the old
  // one-shot share() always did, just split out since the modal now needs
  // a real target to exist before it can create the share claim against it.
  function share() {
    if (selectedRefs.length === 1) {
      const target = singleFile?.blobRef || singlePermanode;
      setShareTarget({
        target,
        isFile: !!singleFile?.blobRef,
        itemTitle: titleOf(meta, singlePermanode) || singleFile?.file?.fileName || "Shared item",
      });
      return;
    }
    run(async () => {
      const setRef = await createStaticSet(selectedRefs);
      setShareTarget({ target: setRef, isFile: false, itemTitle: `${selectedRefs.length} items` });
    });
  }

  const canConvertToSet = selectedRefs.length === 1 && !isSet(singleAttrs);
  const canRemoveFromSet = !!parentRef;
  const canViewOrDownloadSingle = selectedRefs.length === 1 && !!singleFile?.blobRef;

  return (
    <div className="selection-actions border rounded p-2 mb-3 bg-body-tertiary">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <strong>{selectedRefs.length} selected</strong>
        <Button variant="link" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className="d-flex flex-wrap gap-2 mb-2">
        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => setShowAddToSet(true)}>
          Add to set
        </Button>
        {canConvertToSet && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => setShowConvert(true)}>
            Convert to set
          </Button>
        )}
        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={createSet}>
          Create set with items
        </Button>
        {canRemoveFromSet && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={removeFromSet}>
            Remove from set
          </Button>
        )}
        {canViewOrDownloadSingle && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={viewOriginal}>
            View original
          </Button>
        )}
        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={download}>
          Download
        </Button>
        {disco.shareRoot && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={share}>
            Share
          </Button>
        )}
        <Button size="sm" variant="outline-danger" disabled={busy} onClick={deleteItems}>
          Delete
        </Button>
      </div>
      <Button
        variant="link"
        size="sm"
        className="p-0 mb-1"
        onClick={() => setTagsOpen((o) => !o)}
        aria-expanded={tagsOpen}
      >
        Update tags
      </Button>
      <Collapse in={tagsOpen}>
        <div>
          <TagsControl selectedRefs={selectedRefs} meta={meta} onChanged={onChanged} />
        </div>
      </Collapse>
      <ShareModal
        show={!!shareTarget}
        onHide={() => setShareTarget(null)}
        disco={disco}
        target={shareTarget?.target}
        isFile={shareTarget?.isFile}
        itemTitle={shareTarget?.itemTitle}
      />
      {canConvertToSet && (
        <NewSetModal
          show={showConvert}
          onHide={() => setShowConvert(false)}
          onCreate={convertToSet}
          initialName={titleOf(meta, singlePermanode)}
          title="Convert to set"
        />
      )}
      <AddToSetModal
        show={showAddToSet}
        onHide={() => setShowAddToSet(false)}
        selectedRefs={selectedRefs}
        onAdded={() => {
          setShowAddToSet(false);
          onClear();
          onChanged();
        }}
      />
    </div>
  );
}
