import { useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Table from "react-bootstrap/Table";
import { Link } from "react-router-dom";

import { listMyShares, revokeShare } from "../api/client.js";

const MODE_LABELS = { local: "Local user", registered: "Registered user", external: "Anyone with link" };

// AccountPage.jsx's "My Shares" tab. A separate component, in its own
// module, rather than a function defined inside AccountPage's render body
// -- see docs/multi-tenant-roadmap.md's Phase 1 post-ship lesson on why a
// nested `function Foo() {}` rendered as `<Foo />` remounts (and loses
// state/focus) on every parent re-render; importing a real module sidesteps
// that entirely.
export default function MySharesTab() {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState(null);

  async function reload() {
    try {
      setShares(await listMyShares());
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function doRevoke(share) {
    if (!window.confirm("Revoke this share? The link will stop working immediately.")) return;
    setRevoking(share.shareRecord);
    try {
      await revokeShare(share);
      await reload();
    } finally {
      setRevoking(null);
    }
  }

  if (error) return <Alert variant="danger">{error}</Alert>;
  if (!shares) return <div className="text-muted">Loading…</div>;

  return (
    <div>
      <Table size="sm" className="align-middle">
        <thead>
          <tr>
            <th>Item</th>
            <th>Shared with</th>
            <th>Expires</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => (
            <tr key={s.shareRecord}>
              <td>
                <Link to={`/detail/${s.target}`}>{s.itemTitle || s.target}</Link>
              </td>
              <td>
                {MODE_LABELS[s.mode] || s.mode}
                {s.recipient ? ` (${s.recipient})` : ""}
              </td>
              <td className="text-muted">{s.expires ? new Date(s.expires).toLocaleString() : "Never"}</td>
              <td className="text-muted">{s.createdAt ? new Date(s.createdAt).toLocaleString() : ""}</td>
              <td className="text-end">
                <Button
                  size="sm"
                  variant="outline-danger"
                  disabled={revoking === s.shareRecord}
                  onClick={() => doRevoke(s)}
                >
                  Revoke
                </Button>
              </td>
            </tr>
          ))}
          {!shares.length && (
            <tr>
              <td colSpan={5} className="text-muted">
                You haven&apos;t shared anything yet.
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </div>
  );
}
