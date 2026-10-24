import { useEffect, useRef, useState } from "react";
import Form from "react-bootstrap/Form";
import ListGroup from "react-bootstrap/ListGroup";

import { describe, searchSets } from "../api/client.js";

// Search box + list backing "Add to Set" (SelectionActions/AddToSetModal) and
// the upload dialog's "Add to set" toggle. Defaults to the 5 most-recently-
// created sets; typing replaces that list with title matches. A 500ms
// debounce after each keystroke is simpler than branching on touch vs.
// desktop input events and reads the same either way.
export default function SetPicker({ selected, onSelect }) {
  const [query, setQuery] = useState("");
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef(null);

  function load(q) {
    setLoading(true);
    searchSets(q)
      .then((blobs) => setSets(blobs.map((b) => b.blob)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load("");
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(e) {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(q), 500);
  }

  return (
    <div>
      <Form.Control
        placeholder="Search sets…"
        value={query}
        onChange={onChange}
        className="mb-2"
        autoFocus
      />
      <ListGroup>
        {loading && <ListGroup.Item className="text-muted small">{"Loading…"}</ListGroup.Item>}
        {!loading && sets.length === 0 && (
          <ListGroup.Item className="text-muted small">No sets found.</ListGroup.Item>
        )}
        {!loading &&
          sets.map((ref) => (
            <ListGroup.Item
              key={ref}
              action
              active={ref === selected}
              onClick={() => onSelect(ref)}
            >
              <SetTitle blobRef={ref} />
            </ListGroup.Item>
          ))}
      </ListGroup>
    </div>
  );
}

// Permanode titles aren't included in the plain blobref list searchSets()
// returns -- each row resolves its own via describe(). Note: prop is
// "blobRef", not "ref" -- see ItemCard.jsx's comment on why a literal `ref`
// prop never actually reaches a plain function component.
function SetTitle({ blobRef }) {
  const [title, setTitle] = useState(blobRef);

  useEffect(() => {
    describe([blobRef]).then((r) => {
      const t = r.meta?.[blobRef]?.permanode?.attr?.title?.[0];
      if (t) setTitle(t);
    });
  }, [blobRef]);

  return <span className="text-truncate d-block">{title}</span>;
}
