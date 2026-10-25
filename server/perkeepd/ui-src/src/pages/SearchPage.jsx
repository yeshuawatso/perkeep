import { useEffect, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import { useNavigate, useSearchParams } from "react-router-dom";

import { describe, FUSE_ROOTS_QUERY_PARAM, parseQueryInput, ROOT_BROWSE_CONSTRAINT, search } from "../api/client.js";
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
  // JSON constraint (the FUSE menu item, or a "raw:{...}" search-box entry)
  // -- see parseQueryInput's own comment for why that distinction has to be
  // made before the query ever reaches search()/useSearchSession. No query
  // at all means the default "Browse" view, which is the root-folder
  // constraint, not "every permanode" -- see ROOT_BROWSE_CONSTRAINT's comment.
  const queryValue = useMemo(() => (rawQ ? parseQueryInput(rawQ) : ROOT_BROWSE_CONSTRAINT), [rawQ]);
  const isAdvanced = !!rawQ && queryValue !== null && typeof queryValue === "object";
  const isFuseRootsQuery = rawQ === FUSE_ROOTS_QUERY_PARAM;

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
          {!rawQ ? "Browse" : isFuseRootsQuery ? "FUSE" : isAdvanced ? "Advanced search" : `Search: ${rawQ}`}
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
          !session.loading &&
          session.refs.length === 0 &&
          (isFuseRootsQuery ? (
            <div className="text-center text-muted py-5 mx-auto" style={{ maxWidth: "32rem" }}>
              <i className="bi bi-hdd-network fs-1 d-block mb-2" />
              No FUSE roots yet.
              <div className="small mt-2 text-start">
                <p>
                  A permanode shows up here once it's named as a root in Perkeep's FUSE mount --
                  there's no way to create one from the browser. On a machine with the Perkeep
                  tools installed:
                </p>
                <pre className="bg-body-tertiary p-2 rounded">
                  {"pk-mount /mnt/perkeep\n" + "mkdir /mnt/perkeep/roots/my-root"}
                </pre>
                <p className="mb-0">
                  That <code>mkdir</code> creates a permanode with a <code>camliRoot</code>{" "}
                  attribute set to <code>my-root</code>, and anything you then add under that
                  directory becomes browsable here. See{" "}
                  <a href="https://perkeep.org/doc/clients/fuse" target="_blank" rel="noreferrer">
                    perkeep.org/doc/clients/fuse
                  </a>{" "}
                  for the full setup.
                </p>
              </div>
            </div>
          ) : (
            !rawQ && (
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
          ))
        }
      />
    </div>
  );
}
