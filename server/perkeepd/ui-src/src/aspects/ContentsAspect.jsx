import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { describe } from "../api/client.js";
import ResultsGrid from "../components/ResultsGrid.jsx";
import SelectionActions from "../components/SelectionActions.jsx";
import { memberRefs } from "../content/classify.js";
import { useAppContext } from "../context/AppContext.jsx";
import { useSelection } from "../hooks/useSelection.js";

// A container permanode's members -- these are a plain multi-valued
// attribute on the permanode itself (camliMember / camliPath:*), not a
// search query, so "Contents" just describes them directly.
export default function ContentsAspect({ disco, permanode, attrs, onChanged }) {
  const navigate = useNavigate();
  const { requestUpload } = useAppContext();
  const refs = memberRefs(attrs);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const { selected, toggle, clear } = useSelection(refs);

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
        navigate={navigate}
      />
      <ResultsGrid
        disco={disco}
        refs={refs}
        meta={meta}
        selected={selected}
        onToggleSelect={toggle}
        onOpen={(ref) => navigate(`/detail/${ref}`, { state: { siblingRefs: refs, parentRef: permanode } })}
        onDroppedMembers={() => {
          describe(refs).then((r) => setMeta(r.meta || {}));
          onChanged?.();
        }}
        loading={loading}
        done
        onLoadMore={() => {}}
        emptyMessage={
          !loading &&
          refs.length === 0 && (
            <div className="text-center text-muted py-5">
              <i className="bi bi-folder2-open fs-1 d-block mb-2" />
              This set is empty.
              <div className="mt-3">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => requestUpload(permanode)}>
                  Upload files
                </button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
