import { useEffect, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import { useNavigate, useSearchParams } from "react-router-dom";

import { describe, parseQueryInput, ROOT_BROWSE_CONSTRAINT, search } from "../api/client.js";
import ResultsGrid from "../components/ResultsGrid.jsx";
import SelectionActions from "../components/SelectionActions.jsx";
import { useAppContext } from "../context/AppContext.jsx";
import { useSearchSession } from "../hooks/useSearchSession.js";
import { useSelection } from "../hooks/useSelection.js";

export default function SearchPage() {
  const { disco, requestUpload } = useAppContext();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const rawQ = params.get("q") || "";
  // A query string can be either plain search-expression text, or a literal
  // JSON constraint (the Favorites menu item, or a "raw:{...}" search-box
  // entry) -- see parseQueryInput's own comment for why that distinction has
  // to be made before the query ever reaches search()/useSearchSession. No
  // query at all means the default "Browse" view, which is the root-folder
  // constraint, not "every permanode" -- see ROOT_BROWSE_CONSTRAINT's comment.
  const queryValue = useMemo(() => (rawQ ? parseQueryInput(rawQ) : ROOT_BROWSE_CONSTRAINT), [rawQ]);
  const isAdvanced = !!rawQ && queryValue !== null && typeof queryValue === "object";

  const session = useSearchSession(queryValue);
  const { selected, toggle, clear, selectAll } = useSelection(session.refs);
  const [extraMeta, setExtraMeta] = useState({});

  // Clear selection whenever the query itself changes.
  useEffect(() => {
    clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawQ]);

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
    const result = await search(queryValue, { limit: -1, describe: false });
    selectAll((result.blobs || []).map((b) => b.blob));
  }

  if (!disco) return null;

  const meta = { ...session.meta, ...extraMeta };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h5 className="mb-0 text-truncate">
          {!rawQ ? "Browse" : isAdvanced ? "Advanced search" : `Search: ${rawQ}`}
        </h5>
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
        navigate={navigate}
      />

      <ResultsGrid
        disco={disco}
        refs={session.refs}
        meta={meta}
        selected={selected}
        onToggleSelect={toggle}
        onOpen={(ref) => navigate(`/detail/${ref}`, { state: { siblingRefs: session.refs } })}
        onDroppedMembers={(targetRef) =>
          describe([targetRef]).then((r) => setExtraMeta((m) => ({ ...m, ...(r.meta || {}) })))
        }
        loading={session.loading}
        done={session.done}
        onLoadMore={session.loadMore}
        emptyMessage={
          !rawQ &&
          !session.loading &&
          session.refs.length === 0 && (
            <div className="text-center text-muted py-5">
              <i className="bi bi-cloud-upload fs-1 d-block mb-2" />
              There are no files yet.
              <div className="mt-3">
                <Button size="sm" onClick={() => requestUpload(null)}>
                  Upload files
                </Button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
