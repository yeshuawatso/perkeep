import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Collapse from "react-bootstrap/Collapse";

import {
  addAttribute,
  createPermanode,
  createShareClaim,
  createStaticSet,
  delAttribute,
  deletePermanode,
  downloadUrl,
  joinUrl,
  setAttribute,
} from "../api/client.js";
import { resolvedFile } from "../content/classify.js";
import MessageModal from "./MessageModal.jsx";
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
export default function SelectionActions({
  disco,
  selectedRefs,
  meta,
  onChanged,
  onClear,
  parentRef,
  currentSet,
  onSetCurrentSet,
  navigate,
}) {
  const [busy, setBusy] = useState(false);
  const [shareResult, setShareResult] = useState(null);
  const [note, setNote] = useState(null);
  const [tagsOpen, setTagsOpen] = useState(true);

  if (selectedRefs.length === 0) return null;

  const singlePermanode = selectedRefs.length === 1 ? selectedRefs[0] : null;
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
      await Promise.all(selectedRefs.map((ref) => addAttribute(pm, "camliMember", ref)));
      navigate(`/detail/${pm}`);
    });
  }

  function selectAsCurrentSet() {
    onSetCurrentSet(singlePermanode);
    setNote(`"${singlePermanode}" set as the target -- select more items, then "Add to picked set."`);
  }

  function addToCurrentSet() {
    run(async () => {
      await Promise.all(selectedRefs.map((ref) => addAttribute(currentSet, "camliMember", ref)));
      onClear();
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

  function share() {
    run(async () => {
      if (selectedRefs.length === 1) {
        const target = singleFile?.blobRef || singlePermanode;
        const claimRef = await createShareClaim(target, { transitive: true });
        const url = singleFile
          ? `${disco.shareRoot}${target}?via=${claimRef}&assemble=1`
          : `${disco.shareRoot}${claimRef}`;
        setShareResult(url);
      } else {
        const setRef = await createStaticSet(selectedRefs);
        const claimRef = await createShareClaim(setRef, { transitive: true });
        setShareResult(`${disco.shareRoot}${claimRef}`);
      }
    });
  }

  const canSelectAsCurrentSet = selectedRefs.length === 1;
  const canAddToCurrentSet = !!currentSet;
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
      {note && (
        <Alert variant="info" dismissible onClose={() => setNote(null)} className="py-1 small">
          {note}
        </Alert>
      )}
      <div className="d-flex flex-wrap gap-2 mb-2">
        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={createSet}>
          Create set with items
        </Button>
        {canSelectAsCurrentSet && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={selectAsCurrentSet}>
            Select as current set
          </Button>
        )}
        {canAddToCurrentSet && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={addToCurrentSet}>
            Add to picked set
          </Button>
        )}
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
      <MessageModal show={!!shareResult} onHide={() => setShareResult(null)} title="Share URL">
        <a href={shareResult} target="_blank" rel="noreferrer">
          {shareResult}
        </a>
      </MessageModal>
    </div>
  );
}
