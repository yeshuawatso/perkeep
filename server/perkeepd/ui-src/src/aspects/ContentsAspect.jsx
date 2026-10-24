import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { describe } from "../api/client.js";
import ResultsGrid from "../components/ResultsGrid.jsx";
import SelectionActions from "../components/SelectionActions.jsx";
import { useSelection } from "../hooks/useSelection.js";

function memberRefs(attrs) {
  const refs = [...(attrs?.camliMember || [])];
  for (const [k, vs] of Object.entries(attrs || {})) {
    if (k.startsWith("camliPath:")) refs.push(...vs);
  }
  return [...new Set(refs)];
}

// A container permanode's members -- these are a plain multi-valued
// attribute on the permanode itself (camliMember / camliPath:*), not a
// search query, so "Contents" just describes them directly.
export default function ContentsAspect({ disco, permanode, attrs, onChanged }) {
  const navigate = useNavigate();
  const refs = memberRefs(attrs);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const { selected, toggle, clear } = useSelection(refs);
  const [currentSet, setCurrentSet] = useState(null);

  useEffect(() => {
    if (refs.length === 0) {
      setMeta({});
      setLoading(false);
      return;
    }
    setLoading(true);
    describe(refs)
      .then((r) => setMeta(r.meta || {}))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.join(",")]);

  return (
    <div className="p-3">
      <SelectionActions
        disco={disco}
        selectedRefs={[...selected]}
        meta={meta}
        onChanged={() => {
          describe(refs).then((r) => setMeta(r.meta || {}));
          onChanged?.();
        }}
        onClear={clear}
        parentRef={permanode}
        currentSet={currentSet}
        onSetCurrentSet={setCurrentSet}
        navigate={navigate}
      />
      <ResultsGrid
        disco={disco}
        refs={refs}
        meta={meta}
        selected={selected}
        onToggleSelect={toggle}
        onOpen={(ref) => navigate(`/detail/${ref}`, { state: { siblingRefs: refs, parentRef: permanode } })}
        loading={loading}
        done
        onLoadMore={() => {}}
        emptyMessage="This set has no members yet."
      />
    </div>
  );
}
