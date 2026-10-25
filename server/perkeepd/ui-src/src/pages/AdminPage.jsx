import { useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";
import Tab from "react-bootstrap/Tab";
import Tabs from "react-bootstrap/Tabs";
import { useNavigate } from "react-router-dom";

import { createUser, deleteUser, getUsers, grantAdmin, revokeAdmin } from "../api/client.js";
import { useAuth } from "../hooks/useAuth.js";

// Menu: Perkeep | -> Admin (admins only -- see AppNavbar.jsx). Only a
// "Users" tab exists today; react-bootstrap Tabs is used anyway so a
// future "Notifications" tab (see docs/multi-tenant-roadmap.md Phase 3)
// is a one-line addition, not a redesign. No stub tab for it yet -- a
// visible tab for an unbuilt feature would just be confusing.
export default function AdminPage() {
  const { username: currentUsername, impersonate } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const [busyUser, setBusyUser] = useState(null); // username currently mid-action, for per-row spinners/disable

  async function reload() {
    try {
      setUsers(await getUsers());
    } catch (err) {
      setLoadError(String(err));
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function submitCreate(e) {
    e.preventDefault();
    setCreating(true);
    setActionError(null);
    try {
      await createUser(newUsername.trim(), newPassword);
      setNewUsername("");
      setNewPassword("");
      await reload();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setCreating(false);
    }
  }

  async function withBusy(username, fn) {
    setBusyUser(username);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setBusyUser(null);
    }
  }

  async function doDelete(username) {
    if (!window.confirm(`Delete user "${username}"? This can't be undone.`)) return;
    await withBusy(username, () => deleteUser(username));
  }

  async function doImpersonate(username) {
    if (!window.confirm(`Switch to viewing as "${username}"? You'll need to log back in as yourself afterward.`)) {
      return;
    }
    await impersonate(username);
    navigate("/");
  }

  function UsersTab() {
    if (loadError) return <Alert variant="danger">{loadError}</Alert>;
    if (!users) return <div className="text-muted">Loading…</div>;
    return (
      <>
        {actionError && (
          <Alert variant="danger" dismissible onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const busy = busyUser === u.username;
              const isSelf = u.username.toLowerCase() === currentUsername?.toLowerCase();
              return (
                <tr key={u.username}>
                  <td>{u.username}</td>
                  <td>{u.isAdmin && <Badge bg="primary">Admin</Badge>}</td>
                  <td className="text-end">
                    <div className="d-inline-flex gap-2">
                      {u.isAdmin ? (
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          onClick={() => withBusy(u.username, () => revokeAdmin(u.username))}
                        >
                          Revoke admin
                        </Button>
                      ) : (
                        // Granting admin to yourself is never allowed (server
                        // enforces this too) -- hide the button for your own row
                        // rather than let you click it and see an error.
                        !isSelf && (
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            disabled={busy}
                            onClick={() => withBusy(u.username, () => grantAdmin(u.username))}
                          >
                            Grant admin
                          </Button>
                        )
                      )}
                      {!isSelf && (
                        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => doImpersonate(u.username)}>
                          Impersonate
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline-danger"
                        disabled={busy}
                        onClick={() => doDelete(u.username)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Form onSubmit={submitCreate} className="d-flex gap-2" style={{ maxWidth: 480 }}>
          <Form.Control
            placeholder="New username"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            disabled={creating}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Form.Control
            type="password"
            placeholder="Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={creating}
          />
          <Button type="submit" disabled={creating || !newUsername.trim() || !newPassword}>
            {creating ? "Creating…" : "Create user"}
          </Button>
        </Form>
      </>
    );
  }

  return (
    <div className="p-3 p-md-4">
      <h3>Admin</h3>
      <Tabs defaultActiveKey="users" className="mb-3">
        <Tab eventKey="users" title="Users">
          <UsersTab />
        </Tab>
      </Tabs>
    </div>
  );
}
