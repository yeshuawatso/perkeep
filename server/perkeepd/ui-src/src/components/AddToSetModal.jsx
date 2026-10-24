import { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Modal from "react-bootstrap/Modal";

import { addAttribute, COLLECTION_NODE_TYPE, createPermanode, setAttribute } from "../api/client.js";
import NewSetModal from "./NewSetModal.jsx";
import SetPicker from "./SetPicker.jsx";

// Replaces the old "select target set" -> "select as current set" -> uncheck
// it -> check the other items -> "Add to picked set" dance (SelectionActions'
// former selectAsCurrentSet/addToCurrentSet) with one modal: pick an existing
// set (search or the 5 most recent) or create a new one, either way adding
// every selected ref as a camliMember in one step.
export default function AddToSetModal({ show, onHide, selectedRefs, onAdded }) {
  const [mode, setMode] = useState("pick"); // "pick" | "create"
  const [target, setTarget] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (show) {
      setMode("pick");
      setTarget(null);
      setWorking(false);
    }
  }, [show]);

  async function addTo(setRef) {
    setWorking(true);
    try {
      await Promise.all(selectedRefs.map((ref) => addAttribute(setRef, "camliMember", ref)));
      onAdded(setRef);
    } finally {
      setWorking(false);
    }
  }

  async function createAndAdd(name) {
    const pm = await createPermanode();
    await setAttribute(pm, "title", name);
    await setAttribute(pm, "camliNodeType", COLLECTION_NODE_TYPE);
    await addTo(pm);
  }

  if (mode === "create") {
    return (
      <NewSetModal
        show={show}
        onHide={onHide}
        onCreate={createAndAdd}
        title="Create set and add items"
      />
    );
  }

  return (
    <Modal show={show} onHide={working ? undefined : onHide} centered>
      <Modal.Header closeButton={!working}>
        <Modal.Title>Add {selectedRefs.length} item{selectedRefs.length === 1 ? "" : "s"} to set</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <SetPicker selected={target} onSelect={setTarget} />
      </Modal.Body>
      <Modal.Footer className="d-flex justify-content-between">
        <Button disabled={working || !target} onClick={() => addTo(target)}>
          {working ? "Adding…" : "Add"}
        </Button>
        <Button variant="outline-secondary" disabled={working} onClick={() => setMode("create")}>
          Create new…
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
