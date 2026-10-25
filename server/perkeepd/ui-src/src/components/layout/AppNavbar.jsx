import { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Dropdown from "react-bootstrap/Dropdown";
import Form from "react-bootstrap/Form";
import InputGroup from "react-bootstrap/InputGroup";
import Navbar from "react-bootstrap/Navbar";
import { useNavigate } from "react-router-dom";

import { FUSE_ROOTS_QUERY_PARAM, getServerStatus } from "../../api/client.js";

// Header: logo, search box, and the "Perkeep |" dropdown menu -- port of
// header.js's menu (Home/Upload/New set/Import share/FUSE (was "Favorites")/
// Importers/Server status/Account/Logout/About/Help; see perkeep-ui-spec.md §5).
export default function AppNavbar({
  onToggleSidebar,
  searchText,
  onSubmitSearch,
  onUpload,
  onNewSet,
  onImportShare,
  disco,
  username,
  onLogout,
}) {
  const [draft, setDraft] = useState(searchText);
  const [status, setStatus] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setDraft(searchText);
  }, [searchText]);

  useEffect(() => {
    getServerStatus().then(setStatus).catch(() => {});
  }, []);

  function submit(e) {
    e.preventDefault();
    onSubmitSearch(draft);
  }

  async function about() {
    const s = status || (await getServerStatus().catch(() => null));
    window.alert(s ? `Perkeep\nVersion: ${s.Version || "unknown"}` : "Perkeep");
  }

  return (
    <Navbar bg="dark" variant="dark" sticky="top" className="px-2 px-md-3 app-navbar">
      <Button
        variant="outline-light"
        className="d-lg-none me-2"
        aria-label="Toggle navigation"
        onClick={onToggleSidebar}
      >
        <i className="bi bi-list" />
      </Button>
      <Dropdown className="me-2 me-md-4">
        <Dropdown.Toggle variant="dark" className="d-flex align-items-center border-0">
          <i className="bi bi-archive-fill me-2" />
          <span className="d-none d-sm-inline">Perkeep</span>
        </Dropdown.Toggle>
        <Dropdown.Menu>
          <Dropdown.Item onClick={() => navigate("/")}>Home</Dropdown.Item>
          <Dropdown.Item onClick={onUpload}>{"Upload…"}</Dropdown.Item>
          <Dropdown.Item onClick={onNewSet}>New set</Dropdown.Item>
          <Dropdown.Item onClick={onImportShare}>Import share</Dropdown.Item>
          <Dropdown.Divider />
          <Dropdown.Item onClick={() => navigate(`/?q=${encodeURIComponent(FUSE_ROOTS_QUERY_PARAM)}`)}>
            FUSE
          </Dropdown.Item>
          {/* The Go server renders its own complete importer setup UI (account
              lists, add-account forms, OAuth flows) at this path, independent
              of the SPA -- a real page nav, not a React route. */}
          {disco?.importerRoot && <Dropdown.Item href={disco.importerRoot}>Importers</Dropdown.Item>}
          {disco?.statusRoot && (
            <Dropdown.Item href={disco.statusRoot} target="_blank" rel="noreferrer">
              Server status
            </Dropdown.Item>
          )}
          <Dropdown.Divider />
          <Dropdown.Item onClick={() => navigate("/account")}>
            {username ? `Account (${username})` : "Account"}
          </Dropdown.Item>
          <Dropdown.Item onClick={onLogout}>Log out</Dropdown.Item>
          <Dropdown.Divider />
          <Dropdown.Item onClick={() => setShowHelp(true)}>Help</Dropdown.Item>
          <Dropdown.Item onClick={about}>About</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown>
      <Form className="flex-grow-1" onSubmit={submit}>
        <InputGroup>
          <InputGroup.Text className="bg-secondary border-secondary text-light d-none d-sm-flex">
            <i className="bi bi-search" />
          </InputGroup.Text>
          <Form.Control
            id="app-search-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search (tag:foo, is:image, after:2020-01-01, ...)"
            aria-label="Search"
          />
          <Button type="submit" variant="primary">
            <i className="bi bi-search d-lg-none" />
            <span className="d-none d-lg-inline">Search</span>
          </Button>
        </InputGroup>
      </Form>
      <SearchHelpModal show={showHelp} onHide={() => setShowHelp(false)} />
    </Navbar>
  );
}

const PREDICATES = [
  ["after: / before:", "after:2020-01-01"],
  ["attr:", "attr:foo:bar or attr:foo:~bar"],
  ["tag:", "tag:vacation"],
  ["title:", "title:foo (substring)"],
  ["ref:", "ref:sha1-abc (jumps to that blob)"],
  ["is:image / is:landscape / is:portrait / is:pano", ""],
  ["width: / height:", "width:480-1024"],
  ["filename:", "filename:*.pdf"],
  ["camera:", "camera:Nikon*"],
  ["is:post / is:like / is:checkin / is:bookmark", ""],
  ["is:untagged", ""],
  ["is:fitness / is:run / is:hike / is:ride / is:ebike", ""],
  ["miles: / km: / meters:", "miles:5-10"],
  ["has:location", ""],
  ["loc:", 'loc:"New York, New York"'],
  ["locrect:", "locrect:N,W,S,E"],
  ["childrenof: / parentof:", "childrenof:sha1-abc"],
  ["format:", "format:jpg"],
];

function SearchHelpModal({ show, onHide }) {
  if (!show) return null;
  return (
    <div className="modal d-block" tabIndex="-1" role="dialog" style={{ background: "rgba(0,0,0,.5)" }}>
      <div className="modal-dialog modal-dialog-scrollable">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Search syntax</h5>
            <button type="button" className="btn-close" onClick={onHide} />
          </div>
          <div className="modal-body">
            <table className="table table-sm">
              <tbody>
                {PREDICATES.map(([k, v]) => (
                  <tr key={k}>
                    <td><code>{k}</code></td>
                    <td className="text-muted">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-muted small mb-0">
              Combine with spaces (AND) or <code>or</code>; parenthesize to group; prefix with{" "}
              <code>-</code> to negate. <code>raw:&#123;...&#125;</code> sends a literal JSON constraint.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
