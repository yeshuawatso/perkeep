import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useSearchParams } from "react-router-dom";

import { createPermanode, setAttribute } from "../../api/client.js";
import { AppContext } from "../../context/AppContext.jsx";
import { useDiscovery } from "../../hooks/useDiscovery.js";
import { useUploadQueue } from "../../hooks/useUploadQueue.js";
import ImportShareModal from "../ImportShareModal.jsx";
import NewSetModal from "../NewSetModal.jsx";
import UploadProgressModal from "../UploadProgressModal.jsx";
import AppNavbar from "./AppNavbar.jsx";
import AppSidebar from "./AppSidebar.jsx";

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { disco } = useDiscovery();

  const [showUpload, setShowUpload] = useState(false);
  const [showImportShare, setShowImportShare] = useState(false);
  const [showNewSet, setShowNewSet] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const uploadTarget = useRef(null); // parentPermanode for the in-flight upload, if any
  const uploadQueue = useUploadQueue();
  const dragTimeout = useRef(null);

  const requestUpload = useCallback((parentPermanode) => {
    uploadTarget.current = parentPermanode || null;
    setShowUpload(true);
  }, []);

  function handleFilesChosen(files) {
    uploadQueue.uploadFiles(files, {
      parentPermanode: uploadTarget.current,
      onDone: () => window.dispatchEvent(new CustomEvent("perkeep:changed")),
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) {
      setShowUpload(true);
      handleFilesChosen(e.dataTransfer.files);
    }
  }

  function handleDragEnter(e) {
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
    <AppContext.Provider value={{ disco, requestUpload, openImportShare: () => setShowImportShare(true), createNewSet }}>
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
        <AppNavbar
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          searchText={params.get("q") || ""}
          onSubmitSearch={submitSearch}
          onUpload={() => requestUpload(null)}
          onNewSet={() => setShowNewSet(true)}
          onImportShare={() => setShowImportShare(true)}
          disco={disco}
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
        onFilesChosen={handleFilesChosen}
      />
      <ImportShareModal show={showImportShare} onHide={() => setShowImportShare(false)} />
      <NewSetModal show={showNewSet} onHide={() => setShowNewSet(false)} onCreate={handleCreateNewSet} />
    </AppContext.Provider>
  );
}
