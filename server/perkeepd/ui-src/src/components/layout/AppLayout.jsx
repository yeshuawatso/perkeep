import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useSearchParams } from "react-router-dom";

import { COLLECTION_NODE_TYPE, createPermanode, setAttribute } from "../../api/client.js";
import { INTERNAL_DRAG_MIME } from "../../content/classify.js";
import { AppContext } from "../../context/AppContext.jsx";
import { useAuth } from "../../hooks/useAuth.js";
import { useDiscovery } from "../../hooks/useDiscovery.js";
import { useUploadQueue } from "../../hooks/useUploadQueue.js";
import ImportShareModal from "../ImportShareModal.jsx";
import NewSetModal from "../NewSetModal.jsx";
import UploadProgressModal from "../UploadProgressModal.jsx";
import VerifyEmailBanner from "../VerifyEmailBanner.jsx";
import AppNavbar from "./AppNavbar.jsx";
import AppSidebar from "./AppSidebar.jsx";

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { disco } = useDiscovery();
  const { username, isAdmin, verified, impersonatedBy, logout, refreshAccount } = useAuth();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  // login()/impersonate() only know {token, username} -- isAdmin and
  // impersonatedBy come from a follow-up GET /auth/account, needed here
  // for the navbar's Admin item and the impersonation banner below.
  useEffect(() => {
    refreshAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showUpload, setShowUpload] = useState(false);
  const [showImportShare, setShowImportShare] = useState(false);
  const [showNewSet, setShowNewSet] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadTarget, setUploadTarget] = useState(null); // default parentPermanode for the upload dialog
  const uploadQueue = useUploadQueue();
  const dragTimeout = useRef(null);
  // Which set's Contents tab (if any) is currently open -- DetailPage keeps
  // this current via an effect, so the navbar's Upload button (and a raw
  // file drop) can default to "add to this set" without threading per-page
  // upload buttons around.
  const [activeContainer, setActiveContainer] = useState(null);

  const requestUpload = useCallback(
    (parentPermanode) => {
      setUploadTarget(parentPermanode || activeContainer || null);
      setShowUpload(true);
    },
    [activeContainer],
  );

  // parentOverride comes from the upload dialog's own "Add to set" toggle/
  // picker, which may differ from the default requestUpload() was opened
  // with; undefined (not called from the dialog, e.g. a raw OS file drop)
  // falls back to that default.
  function handleFilesChosen(files, parentOverride) {
    uploadQueue.uploadFiles(files, {
      parentPermanode: parentOverride !== undefined ? parentOverride : uploadTarget,
      onDone: () => window.dispatchEvent(new CustomEvent("perkeep:changed")),
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    // A drag that started on one of our own ItemCards always carries this
    // type (see content/classify.js's INTERNAL_DRAG_MIME) -- if it bubbled
    // all the way up here, it wasn't dropped on a valid set, so there's
    // nothing to do. Critically, this check runs before ever looking at
    // dataTransfer.files, which is what stops Chrome's native
    // image-drag-produces-a-file behavior from misfiring an upload for a
    // drag that was never a real OS file in the first place.
    if (e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return;
    if (e.dataTransfer.files?.length) {
      setUploadTarget(activeContainer || null);
      setShowUpload(true);
      handleFilesChosen(e.dataTransfer.files, activeContainer || null);
    }
  }

  function handleDragEnter(e) {
    if (e.dataTransfer.types.includes(INTERNAL_DRAG_MIME)) return;
    e.preventDefault();
    setDragActive(true);
    clearTimeout(dragTimeout.current);
    // Old UI's guard against the drag-active overlay getting stuck if a
    // drag enters and nothing ever drops.
    dragTimeout.current = setTimeout(() => setDragActive(false), 2000);
  }

  async function createNewSet(name = "New set") {
    const pm = await createPermanode();
    await setAttribute(pm, "title", name);
    await setAttribute(pm, "camliNodeType", COLLECTION_NODE_TYPE);
    navigate(`/detail/${pm}`);
    return pm;
  }

  async function handleCreateNewSet(name) {
    await createNewSet(name);
    setShowNewSet(false);
  }

  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("app-search-input")?.focus();
      } else if (e.key === "Escape") {
        navigate("/");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  // Old UI's "?p=<permanode>" / "?b=<blobref>" shortlinks (pkg/server/ui.go's
  // wantsPermanode/wantsBlobInfo) served separate, long-dead legacy pages
  // (permanode.html's cam.PermanodePage doesn't exist in that codebase;
  // blobinfo.html doesn't exist at all -- see perkeep-ui-spec.md §6/§8).
  // Redirect both to the equivalent live aspect of the main detail view
  // instead of resurrecting them.
  useEffect(() => {
    const p = params.get("p");
    const b = params.get("b");
    if (p) navigate(`/detail/${p}`, { replace: true });
    else if (b) navigate(`/detail/${b}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  function submitSearch(text) {
    // "ref:<blobref>" jumps straight to that blob's detail view instead of
    // running a search, same as the old search bar's onSearch handler.
    const m = /^ref:([a-z0-9]+-[0-9a-f]{16,})$/i.exec(text.trim());
    if (m) {
      navigate(`/detail/${m[1]}`);
      return;
    }
    navigate(text ? `/?q=${encodeURIComponent(text)}` : "/");
  }

  return (
    <AppContext.Provider
      value={{
        disco,
        requestUpload,
        openImportShare: () => setShowImportShare(true),
        createNewSet,
        setActiveContainer,
        currentUser: username,
        logout: handleLogout,
      }}
    >
      <div
        className="app-shell"
        onDragEnter={handleDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {dragActive && (
          <div className="drag-overlay d-flex align-items-center justify-content-center">
            <div className="fs-3 text-white">Drop files to upload</div>
          </div>
        )}
        {impersonatedBy && (
          <div className="bg-warning text-dark text-center py-1 small">
            Viewing as <strong>{username}</strong> (impersonated by {impersonatedBy}) --{" "}
            <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={handleLogout}>
              log out
            </button>
          </div>
        )}
        {!verified && <VerifyEmailBanner />}
        <AppNavbar
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          searchText={params.get("q") || ""}
          onSubmitSearch={submitSearch}
          onUpload={() => requestUpload(null)}
          onNewSet={() => setShowNewSet(true)}
          onImportShare={() => setShowImportShare(true)}
          disco={disco}
          username={username}
          isAdmin={isAdmin}
          onLogout={handleLogout}
        />
        <div className="app-body">
          <AppSidebar show={sidebarOpen} onHide={() => setSidebarOpen(false)} />
          <main className="app-content">
            <Outlet />
          </main>
        </div>
      </div>
      <UploadProgressModal
        show={showUpload}
        onHide={() => setShowUpload(false)}
        active={uploadQueue.active}
        progress={uploadQueue.progress}
        status={uploadQueue.status}
        initialParent={uploadTarget}
        onFilesChosen={handleFilesChosen}
      />
      <ImportShareModal show={showImportShare} onHide={() => setShowImportShare(false)} />
      <NewSetModal show={showNewSet} onHide={() => setShowNewSet(false)} onCreate={handleCreateNewSet} />
    </AppContext.Provider>
  );
}
