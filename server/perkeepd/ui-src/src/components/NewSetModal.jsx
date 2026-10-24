import { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";

// Header menu -> "New set": name the set up front instead of creating it
// with a fixed "New set" title that can then only be changed by deleting
// and re-adding the title attribute by hand.
export default function NewSetModal({ show, onHide, onCreate, initialName, title }) {
  const [name, setName] = useState(initialName || "New set");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (show) {
      setName(initialName || "New set");
      setWorking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, initialName]);

  async function submit(e) {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    try {
      await onCreate(name.trim() || initialName || "New set");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal show={show} onHide={working ? undefined : onHide} centered>
      <Modal.Header closeButton={!working}>
        <Modal.Title>{title || "New set"}</Modal.Title>
      </Modal.Header>
      <Form onSubmit={submit}>
        <Modal.Body>
          <Form.Label htmlFor="new-set-name">Name</Form.Label>
          <Form.Control
            id="new-set-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            disabled={working}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onHide} disabled={working}>
            Cancel
          </Button>
          <Button type="submit" disabled={working}>
            {working ? "Creating…" : "Create"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
