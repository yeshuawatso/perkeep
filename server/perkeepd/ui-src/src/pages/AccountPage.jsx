import { useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Table from "react-bootstrap/Table";

import { changePassword, changeUsername, createApiToken, getAccount, revokeApiToken } from "../api/client.js";

// Menu: Perkeep | -> Account. Change username, change password, and
// create/revoke the per-user API tokens that replace a shared Basic-auth
// password for curl/scripting (see hooks/useAuth.js, pkg/accounts).
export default function AccountPage() {
  const [account, setAccount] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [newUsername, setNewUsername] = useState("");
  const [usernamePassword, setUsernamePassword] = useState("");
  const [usernameWorking, setUsernameWorking] = useState(false);
  const [usernameError, setUsernameError] = useState(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordWorking, setPasswordWorking] = useState(false);
  const [passwordError, setPasswordError] = useState(null);
  const [passwordDone, setPasswordDone] = useState(false);

  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenWorking, setTokenWorking] = useState(false);
  const [newToken, setNewToken] = useState(null);

  async function reload() {
    try {
      const a = await getAccount();
      setAccount(a);
      setNewUsername(a.username);
    } catch (err) {
      setLoadError(String(err));
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function submitUsername(e) {
    e.preventDefault();
    setUsernameWorking(true);
    setUsernameError(null);
    try {
      await changeUsername(newUsername.trim(), usernamePassword);
      setUsernamePassword("");
      await reload();
    } catch {
      setUsernameError("Could not change username -- check your password.");
    } finally {
      setUsernameWorking(false);
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    setPasswordWorking(true);
    setPasswordError(null);
    setPasswordDone(false);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordDone(true);
    } catch {
      setPasswordError("Could not change password -- check your current password.");
    } finally {
      setPasswordWorking(false);
    }
  }

  async function submitNewToken(e) {
    e.preventDefault();
    setTokenWorking(true);
    try {
      const result = await createApiToken(tokenLabel.trim() || "API token");
      setNewToken(result.token);
      setTokenLabel("");
      await reload();
    } finally {
      setTokenWorking(false);
    }
  }

  async function doRevoke(id) {
    if (!window.confirm("Revoke this API token? Anything using it will stop working immediately.")) return;
    await revokeApiToken(id);
    await reload();
  }

  if (loadError) {
    return (
      <div className="p-4">
        <Alert variant="danger">{loadError}</Alert>
      </div>
    );
  }
  if (!account) return <div className="p-4 text-muted">Loading…</div>;

  return (
    <div className="p-3 p-md-4" style={{ maxWidth: 640 }}>
      <h3>Account</h3>

      <Form onSubmit={submitUsername} className="mb-4 pb-3 border-bottom">
        <h5>Username</h5>
        {usernameError && (
          <Alert variant="danger" className="py-2">
            {usernameError}
          </Alert>
        )}
        <Form.Group className="mb-2">
          <Form.Label>Username</Form.Label>
          <Form.Control
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            disabled={usernameWorking}
          />
        </Form.Group>
        <Form.Group className="mb-2">
          <Form.Label>Current password</Form.Label>
          <Form.Control
            type="password"
            value={usernamePassword}
            onChange={(e) => setUsernamePassword(e.target.value)}
            disabled={usernameWorking}
          />
        </Form.Group>
        <Button type="submit" disabled={usernameWorking || !newUsername.trim() || !usernamePassword}>
          {usernameWorking ? "Saving…" : "Save username"}
        </Button>
      </Form>

      <Form onSubmit={submitPassword} className="mb-4 pb-3 border-bottom">
        <h5>Password</h5>
        {passwordError && (
          <Alert variant="danger" className="py-2">
            {passwordError}
          </Alert>
        )}
        {passwordDone && (
          <Alert variant="success" className="py-2">
            Password changed.
          </Alert>
        )}
        <Form.Group className="mb-2">
          <Form.Label>Current password</Form.Label>
          <Form.Control
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={passwordWorking}
          />
        </Form.Group>
        <Form.Group className="mb-2">
          <Form.Label>New password</Form.Label>
          <Form.Control
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={passwordWorking}
          />
        </Form.Group>
        <Button type="submit" disabled={passwordWorking || !currentPassword || !newPassword}>
          {passwordWorking ? "Saving…" : "Change password"}
        </Button>
      </Form>

      <div>
        <h5>API tokens</h5>
        <p className="text-muted small">
          Use an API token instead of your password for curl/scripts:{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
        {newToken && (
          <Alert variant="success" dismissible onClose={() => setNewToken(null)}>
            <div className="mb-1">Copy this now -- it won&apos;t be shown again:</div>
            <code className="d-block text-break">{newToken}</code>
          </Alert>
        )}
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(account.apiTokens || []).map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td className="text-muted">{new Date(t.createdAt).toLocaleString()}</td>
                <td className="text-end">
                  <Button size="sm" variant="outline-danger" onClick={() => doRevoke(t.id)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {!account.apiTokens?.length && (
              <tr>
                <td colSpan={3} className="text-muted">
                  No API tokens yet.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
        <Form onSubmit={submitNewToken} className="d-flex gap-2">
          <Form.Control
            placeholder="Label (e.g. laptop backup script)"
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.target.value)}
            disabled={tokenWorking}
          />
          <Button type="submit" disabled={tokenWorking}>
            {tokenWorking ? "Creating…" : "Create token"}
          </Button>
        </Form>
      </div>
    </div>
  );
}
