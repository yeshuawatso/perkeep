import { useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import Table from "react-bootstrap/Table";
import Tab from "react-bootstrap/Tab";
import Tabs from "react-bootstrap/Tabs";
import { useNavigate } from "react-router-dom";

import {
  createUser,
  deleteUser,
  getSMTPConfig,
  getUsers,
  grantAdmin,
  resetPassword,
  revokeAdmin,
  sendTestEmail,
  serverErrorMessage,
  setSMTPConfig,
} from "../api/client.js";
import PasswordRequirementHint from "../components/PasswordRequirementHint.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { usePasswordPolicy } from "../hooks/usePasswordPolicy.js";

// Menu: Perkeep | -> Admin (admins only -- see AppNavbar.jsx). "Users" and
// "Notifications" (SMTP setup, docs/multi-tenant-roadmap.md Phase 3) tabs.
export default function AdminPage() {
  const { username: currentUsername, impersonate } = useAuth();
  const navigate = useNavigate();
  const policy = usePasswordPolicy();

  const [users, setUsers] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const [newUsername, setNewUsername] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const [busyUser, setBusyUser] = useState(null); // username currently mid-action, for per-row spinners/disable

  const [resetTarget, setResetTarget] = useState(null); // username, or null when the modal is closed
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetWorking, setResetWorking] = useState(false);
  const [resetError, setResetError] = useState(null);

  // smtpForm.password is always "" on load (the server never sends it
  // back -- see getSMTPConfig) and is only sent on save if the admin
  // actually typed a new one; hasPassword reflects what's really stored.
  const [smtpForm, setSmtpForm] = useState({ host: "", port: 587, username: "", password: "", security: "starttls", from: "" });
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const [smtpLoadError, setSmtpLoadError] = useState(null);
  const [smtpLoaded, setSmtpLoaded] = useState(false);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpSaveError, setSmtpSaveError] = useState(null);
  const [smtpSaveOk, setSmtpSaveOk] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testError, setTestError] = useState(null);
  const [testOk, setTestOk] = useState(false);

  async function reload() {
    try {
      setUsers(await getUsers());
    } catch (err) {
      setLoadError(String(err));
    }
  }

  async function reloadSmtpConfig() {
    try {
      const cfg = await getSMTPConfig();
      setSmtpForm({ host: cfg.host, port: cfg.port, username: cfg.username, password: "", security: cfg.security, from: cfg.from });
      setSmtpHasPassword(cfg.hasPassword);
    } catch (err) {
      setSmtpLoadError(String(err));
    } finally {
      setSmtpLoaded(true);
    }
  }

  useEffect(() => {
    reload();
    reloadSmtpConfig();
  }, []);

  async function submitSmtpConfig(e) {
    e.preventDefault();
    setSmtpSaving(true);
    setSmtpSaveError(null);
    setSmtpSaveOk(false);
    try {
      await setSMTPConfig({ ...smtpForm, port: Number(smtpForm.port) });
      await reloadSmtpConfig();
      setSmtpSaveOk(true);
    } catch (err) {
      setSmtpSaveError(serverErrorMessage(err) || String(err));
    } finally {
      setSmtpSaving(false);
    }
  }

  async function submitTestSend(e) {
    e.preventDefault();
    setTestSending(true);
    setTestError(null);
    setTestOk(false);
    try {
      await sendTestEmail(testTo.trim());
      setTestOk(true);
    } catch (err) {
      setTestError(serverErrorMessage(err) || String(err));
    } finally {
      setTestSending(false);
    }
  }

  async function submitCreate(e) {
    e.preventDefault();
    setCreating(true);
    setActionError(null);
    try {
      await createUser(newUsername.trim(), newPassword, newEmail.trim());
      setNewUsername("");
      setNewEmail("");
      setNewPassword("");
      await reload();
    } catch (err) {
      setActionError(serverErrorMessage(err) || String(err));
    } finally {
      setCreating(false);
    }
  }

  function openReset(username) {
    setResetTarget(username);
    setResetPasswordValue("");
    setResetError(null);
  }

  async function submitReset(e) {
    e.preventDefault();
    setResetWorking(true);
    setResetError(null);
    try {
      await resetPassword(resetTarget, resetPasswordValue);
      setResetTarget(null);
    } catch (err) {
      setResetError(serverErrorMessage(err) || "Could not reset password.");
    } finally {
      setResetWorking(false);
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

  function renderUsersTab() {
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
                      {!isSelf && (
                        // Never your own row -- that's what Account page's
                        // Change Password (which checks your current
                        // password) is for. See ErrSelfReset.
                        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => openReset(u.username)}>
                          Reset password
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
        <Form onSubmit={submitCreate} className="d-flex align-items-start gap-2" style={{ maxWidth: 560 }}>
          <Form.Control
            placeholder="New username"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            disabled={creating}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <div>
            <Form.Control
              type="email"
              placeholder="Email (optional)"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              disabled={creating}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <Form.Text className="text-muted">Lets this user use "forgot password".</Form.Text>
          </div>
          <div>
            <Form.Control
              type="password"
              placeholder="Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={creating}
            />
            <PasswordRequirementHint
              description={policy.description}
              matches={newPassword && policy.regex ? policy.regex.test(newPassword) : undefined}
            />
          </div>
          <Button
            type="submit"
            disabled={creating || !newUsername.trim() || !newPassword || (policy.regex && !policy.regex.test(newPassword))}
          >
            {creating ? "Creating…" : "Create user"}
          </Button>
        </Form>

        <Modal show={resetTarget != null} onHide={() => setResetTarget(null)}>
          <Modal.Header closeButton>
            <Modal.Title>Reset password for {resetTarget}</Modal.Title>
          </Modal.Header>
          <Form onSubmit={submitReset}>
            <Modal.Body>
              {resetError && (
                <Alert variant="danger" className="py-2">
                  {resetError}
                </Alert>
              )}
              <Form.Group>
                <Form.Label>New password</Form.Label>
                <Form.Control
                  type="password"
                  autoFocus
                  value={resetPasswordValue}
                  onChange={(e) => setResetPasswordValue(e.target.value)}
                  disabled={resetWorking}
                />
                <PasswordRequirementHint
                  description={policy.description}
                  matches={resetPasswordValue && policy.regex ? policy.regex.test(resetPasswordValue) : undefined}
                />
              </Form.Group>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="outline-secondary" onClick={() => setResetTarget(null)} disabled={resetWorking}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={resetWorking || !resetPasswordValue || (policy.regex && !policy.regex.test(resetPasswordValue))}
              >
                {resetWorking ? "Resetting…" : "Reset password"}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      </>
    );
  }

  function renderNotificationsTab() {
    if (smtpLoadError) return <Alert variant="danger">{smtpLoadError}</Alert>;
    if (!smtpLoaded) return <div className="text-muted">Loading…</div>;
    return (
      <>
        <Form onSubmit={submitSmtpConfig} style={{ maxWidth: 480 }}>
          <h5>SMTP settings</h5>
          {smtpSaveError && (
            <Alert variant="danger" dismissible onClose={() => setSmtpSaveError(null)}>
              {smtpSaveError}
            </Alert>
          )}
          {smtpSaveOk && (
            <Alert variant="success" dismissible onClose={() => setSmtpSaveOk(false)}>
              Saved.
            </Alert>
          )}
          <Form.Group className="mb-2">
            <Form.Label>Host</Form.Label>
            <Form.Control
              value={smtpForm.host}
              onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })}
              disabled={smtpSaving}
            />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Port</Form.Label>
            <Form.Control
              type="number"
              value={smtpForm.port}
              onChange={(e) => setSmtpForm({ ...smtpForm, port: e.target.value })}
              disabled={smtpSaving}
            />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Security</Form.Label>
            <Form.Select
              value={smtpForm.security}
              onChange={(e) => setSmtpForm({ ...smtpForm, security: e.target.value })}
              disabled={smtpSaving}
            >
              <option value="none">None (plaintext)</option>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS (implicit)</option>
            </Form.Select>
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Username</Form.Label>
            <Form.Control
              value={smtpForm.username}
              onChange={(e) => setSmtpForm({ ...smtpForm, username: e.target.value })}
              disabled={smtpSaving}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Password {smtpHasPassword && <span className="text-muted">(unchanged if left blank)</span>}</Form.Label>
            <Form.Control
              type="password"
              value={smtpForm.password}
              onChange={(e) => setSmtpForm({ ...smtpForm, password: e.target.value })}
              disabled={smtpSaving}
              placeholder={smtpHasPassword ? "••••••••" : ""}
            />
          </Form.Group>
          <Form.Group className="mb-3">
            <Form.Label>From address</Form.Label>
            <Form.Control
              value={smtpForm.from}
              onChange={(e) => setSmtpForm({ ...smtpForm, from: e.target.value })}
              disabled={smtpSaving}
            />
          </Form.Group>
          <Button type="submit" disabled={smtpSaving || !smtpForm.host}>
            {smtpSaving ? "Saving…" : "Save"}
          </Button>
        </Form>

        <hr className="my-4" style={{ maxWidth: 480 }} />

        <Form onSubmit={submitTestSend} className="d-flex align-items-start gap-2" style={{ maxWidth: 480 }}>
          <Form.Control
            placeholder="Send a test email to…"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            disabled={testSending}
          />
          <Button type="submit" variant="outline-secondary" disabled={testSending || !testTo.trim()}>
            {testSending ? "Sending…" : "Send test"}
          </Button>
        </Form>
        {testError && (
          <Alert variant="danger" className="mt-2" style={{ maxWidth: 480 }} dismissible onClose={() => setTestError(null)}>
            {testError}
          </Alert>
        )}
        {testOk && (
          <Alert variant="success" className="mt-2" style={{ maxWidth: 480 }} dismissible onClose={() => setTestOk(false)}>
            Sent.
          </Alert>
        )}
      </>
    );
  }

  return (
    <div className="p-3 p-md-4">
      <h3>Admin</h3>
      <Tabs defaultActiveKey="users" className="mb-3">
        <Tab eventKey="users" title="Users">
          {renderUsersTab()}
        </Tab>
        <Tab eventKey="notifications" title="Notifications">
          {renderNotificationsTab()}
        </Tab>
      </Tabs>
    </div>
  );
}
