import { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import { useNavigate, useSearchParams } from "react-router-dom";

import { describe, search } from "../api/client.js";
import ResultsGrid from "../components/ResultsGrid.jsx";
import SelectionActions from "../components/SelectionActions.jsx";
import { useAppContext } from "../context/AppContext.jsx";
import { useSearchSession } from "../hooks/useSearchSession.js";
import { useSelection } from "../hooks/useSelection.js";

export default function SearchPage() {
  const { disco } = useAppContext();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") || "";

  const session = useSearchSession(q || null);
  const { selected, toggle, clear, selectAll } = useSelection(session.refs);
  const [currentSet, setCurrentSet] = useState(null);
  const [extraMeta, setExtraMeta] = useState({});

  // Clear selection whenever the query itself changes.
  useEffect(() => {
    clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    function onChanged() {
      refreshSelectedMeta();
    }
    window.addEventListener("perkeep:changed", onChanged);
    return () => window.removeEventListener("perkeep:changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function refreshSelectedMeta() {
    const refs = [...selected];
    if (refs.length === 0) return;
    const result = await describe(refs);
    setExtraMeta((m) => ({ ...m, ...(result.meta || {}) }));
  }

  async function handleSelectAll() {
    const result = await search(q || { camliType: "permanode" }, { limit: -1, describe: false });
    selectAll((result.blobs || []).map((b) => b.blob));
  }

  if (!disco) return null;

  const meta = { ...session.meta, ...extraMeta };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h5 className="mb-0 text-truncate">{q ? `Search: ${q}` : "Browse"}</h5>
        {session.refs.length > 0 && (
          <div className="d-flex gap-2">
            <Button size="sm" variant="outline-secondary" onClick={handleSelectAll}>
              Select all
            </Button>
            {selected.size > 0 && (
              <Button size="sm" variant="outline-secondary" onClick={clear}>
                Clear selection
              </Button>
            )}
          </div>
        )}
      </div>

      {session.socketError && (
        <div className="alert alert-warning py-1 small">
          Live updates are unavailable right now; results shown are from the last successful search.
        </div>
      )}
      {session.error && <div className="alert alert-danger py-1 small">{session.error}</div>}

      <SelectionActions
        disco={disco}
        selectedRefs={[...selected]}
        meta={meta}
        onChanged={() => {
          refreshSelectedMeta();
          window.dispatchEvent(new CustomEvent("perkeep:changed"));
        }}
        onClear={clear}
        currentSet={currentSet}
        onSetCurrentSet={setCurrentSet}
        navigate={navigate}
      />

      <ResultsGrid
        disco={disco}
        refs={session.refs}
        meta={meta}
        selected={selected}
        onToggleSelect={toggle}
        onOpen={(ref) => navigate(`/detail/${ref}`, { state: { siblingRefs: session.refs } })}
        loading={session.loading}
        done={session.done}
        onLoadMore={session.loadMore}
      />
    </div>
  );
}
