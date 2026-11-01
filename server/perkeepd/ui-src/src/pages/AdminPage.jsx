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
  addOrUpdateStorageBackup,
  createUser,
  deleteStorageBackup,
  deleteUser,
  getSMTPConfig,
  getStorageConfig,
  getUsers,
  grantAdmin,
  promoteStorageBackup,
  resetPassword,
  revokeAdmin,
  sendTestEmail,
  serverErrorMessage,
  setSMTPConfig,
  testStorageConfig,
} from "../api/client.js";
import PasswordRequirementHint from "../components/PasswordRequirementHint.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { usePasswordPolicy } from "../hooks/usePasswordPolicy.js";

// Storage backend types the admin-UI's "Add backup" form knows how to
// render fields for -- matches pkg/types/serverconfig.StorageTarget.Type
// (storagetarget.Args is the source of truth for what each actually
// requires; this list and the fields below are a convenience, not an
// independent source of validation).
const BACKUP_STORAGE_TYPES = [
  { value: "s3", label: "S3 (or S3-compatible)" },
  { value: "b2", label: "Backblaze B2" },
  { value: "googlecloudstorage", label: "Google Cloud Storage" },
  { value: "googledrive", label: "Google Drive" },
];

const EMPTY_BACKUP_FORM = {
  name: "",
  type: "s3",
  bucket: "",
  dir: "",
  hostname: "",
  awsAccessKey: "",
  awsSecretKey: "",
  gcsAuthMode: "auto", // "auto" | "serviceAccount" | "oauth2" -- UI-only, not sent as-is
  gcsClientID: "",
  gcsClientSecret: "",
  gcsRefreshToken: "",
  gcsServiceAccountKey: "",
  googleClientID: "",
  googleClientSecret: "",
  googleRefreshToken: "",
  googleDriveParentID: "",
};

// Fields client.js's addOrUpdateStorageBackup/testStorageConfig actually
// send -- gcsAuthMode above is UI-only and never sent, and gcsClientID is
// derived from it ("auto" or the typed OAuth2 client ID).
function backupFormToTarget(f) {
  const t = {
    name: f.name.trim(),
    type: f.type,
    bucket: f.bucket.trim(),
    dir: f.dir.trim(),
    hostname: f.hostname.trim(),
    awsAccessKey: f.awsAccessKey.trim(),
    awsSecretKey: f.awsSecretKey,
    gcsClientSecret: f.gcsClientSecret,
    gcsRefreshToken: f.gcsRefreshToken,
    gcsServiceAccountKey: f.gcsServiceAccountKey,
    googleClientID: f.googleClientID.trim(),
    googleClientSecret: f.googleClientSecret,
    googleRefreshToken: f.googleRefreshToken,
    googleDriveParentID: f.googleDriveParentID.trim(),
  };
  if (f.type === "googlecloudstorage") {
    t.gcsClientID = f.gcsAuthMode === "auto" ? "auto" : f.gcsClientID.trim();
    if (f.gcsAuthMode !== "serviceAccount") t.gcsServiceAccountKey = "";
    if (f.gcsAuthMode !== "oauth2") {
      t.gcsClientSecret = "";
      t.gcsRefreshToken = "";
    }
  }
  return t;
}

// Menu: Perkeep | -> Admin (admins only -- see AppNavbar.jsx). "Users",
// "Notifications" (SMTP setup), and "Storage" (backup/DR targets,
// docs/multi-tenant-roadmap.md) tabs.
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

  // Storage tab -- see docs/multi-tenant-roadmap.md. storageConfig is
  // null while loading, then { primary, legacyPrimary, backups }.
  const [storageConfig, setStorageConfig] = useState(null);
  const [storageLoadError, setStorageLoadError] = useState(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageActionError, setStorageActionError] = useState(null);
  const [storageRestartNotice, setStorageRestartNotice] = useState(false);
  const [backupBusy, setBackupBusy] = useState(null); // name mid-action

  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupForm, setBackupForm] = useState(EMPTY_BACKUP_FORM);
  const [backupIsEdit, setBackupIsEdit] = useState(false);
  const [backupSaving, setBackupSaving] = useState(false);
  const [backupSaveError, setBackupSaveError] = useState(null);
  const [backupTesting, setBackupTesting] = useState(false);
  const [backupTestResult, setBackupTestResult] = useState(null);

  const [promoteTarget, setPromoteTarget] = useState(null); // name, or null when closed
  const [promoteForce, setPromoteForce] = useState(false);
  const [promoteKeepOld, setPromoteKeepOld] = useState(true);
  const [promoteWorking, setPromoteWorking] = useState(false);
  const [promoteError, setPromoteError] = useState(null);

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

  async function reloadStorageConfig() {
    try {
      setStorageConfig(await getStorageConfig());
    } catch (err) {
      setStorageLoadError(String(err));
    } finally {
      setStorageLoaded(true);
    }
  }

  useEffect(() => {
    reload();
    reloadSmtpConfig();
    reloadStorageConfig();
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

  function openAddBackup() {
    setBackupForm(EMPTY_BACKUP_FORM);
    setBackupIsEdit(false);
    setBackupSaveError(null);
    setBackupTestResult(null);
    setShowBackupModal(true);
  }

  function openEditBackup(b) {
    setBackupForm({
      ...EMPTY_BACKUP_FORM,
      ...b,
      gcsAuthMode: b.gcsClientID === "auto" ? "auto" : b.hasGcsServiceAccountKey ? "serviceAccount" : "oauth2",
      // Secrets never come back from the server -- leave blank, which
      // addOrUpdateStorageBackup's "empty means keep existing" convention
      // (pkg/accounts/storage.go) handles correctly.
      awsSecretKey: "",
      gcsClientSecret: "",
      gcsRefreshToken: "",
      gcsServiceAccountKey: "",
      googleClientSecret: "",
      googleRefreshToken: "",
    });
    setBackupIsEdit(true);
    setBackupSaveError(null);
    setBackupTestResult(null);
    setShowBackupModal(true);
  }

  async function submitBackup(e) {
    e.preventDefault();
    setBackupSaving(true);
    setBackupSaveError(null);
    try {
      await addOrUpdateStorageBackup(backupFormToTarget(backupForm));
      setShowBackupModal(false);
      setStorageRestartNotice(true);
      await reloadStorageConfig();
    } catch (err) {
      setBackupSaveError(serverErrorMessage(err) || String(err));
    } finally {
      setBackupSaving(false);
    }
  }

  async function testBackupForm() {
    setBackupTesting(true);
    setBackupTestResult(null);
    try {
      await testStorageConfig(backupFormToTarget(backupForm));
      setBackupTestResult({ ok: true });
    } catch (err) {
      setBackupTestResult({ ok: false, message: serverErrorMessage(err) || String(err) });
    } finally {
      setBackupTesting(false);
    }
  }

  async function doDeleteBackup(name) {
    if (
      !window.confirm(
        `Remove backup "${name}" from configuration? This does not delete any data already stored there -- only the replication setup.`,
      )
    ) {
      return;
    }
    setBackupBusy(name);
    setStorageActionError(null);
    try {
      await deleteStorageBackup(name);
      setStorageRestartNotice(true);
      await reloadStorageConfig();
    } catch (err) {
      setStorageActionError(serverErrorMessage(err) || String(err));
    } finally {
      setBackupBusy(null);
    }
  }

  function openPromote(name) {
    setPromoteTarget(name);
    setPromoteForce(false);
    setPromoteKeepOld(true);
    setPromoteError(null);
  }

  async function submitPromote(e) {
    e.preventDefault();
    setPromoteWorking(true);
    setPromoteError(null);
    try {
      await promoteStorageBackup(promoteTarget, { force: promoteForce, keepOldPrimary: promoteKeepOld });
      setPromoteTarget(null);
      setStorageRestartNotice(true);
      await reloadStorageConfig();
    } catch (err) {
      setPromoteError(serverErrorMessage(err) || String(err));
    } finally {
      setPromoteWorking(false);
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

  function renderBackupFields() {
    const disabled = backupSaving;
    const set = (field) => (e) => setBackupForm({ ...backupForm, [field]: e.target.value });
    if (backupForm.type === "s3" || backupForm.type === "b2") {
      return (
        <>
          <Form.Group className="mb-2">
            <Form.Label>Bucket</Form.Label>
            <Form.Control value={backupForm.bucket} onChange={set("bucket")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Directory (optional)</Form.Label>
            <Form.Control value={backupForm.dir} onChange={set("dir")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>
              {backupForm.type === "b2"
                ? "Hostname (Backblaze's S3-compatible endpoint, e.g. s3.us-west-002.backblazeb2.com -- required)"
                : "Hostname (optional -- for an S3-compatible service other than AWS, e.g. MinIO)"}
            </Form.Label>
            <Form.Control value={backupForm.hostname} onChange={set("hostname")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Access key{backupForm.type === "s3" && " (optional -- see below)"}</Form.Label>
            <Form.Control value={backupForm.awsAccessKey} onChange={set("awsAccessKey")} disabled={disabled} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>
              Secret key {backupIsEdit && <span className="text-muted">(unchanged if left blank)</span>}
              {backupForm.type === "s3" && !backupForm.awsAccessKey && !backupForm.awsSecretKey && (
                <span className="text-muted"> -- leave both blank to use the AWS default credential chain (IAM role, env vars, SSO)</span>
              )}
            </Form.Label>
            <Form.Control
              type="password"
              value={backupForm.awsSecretKey}
              onChange={set("awsSecretKey")}
              disabled={disabled}
              placeholder={backupIsEdit ? "••••••••" : ""}
            />
          </Form.Group>
        </>
      );
    }
    if (backupForm.type === "googlecloudstorage") {
      return (
        <>
          <Form.Group className="mb-2">
            <Form.Label>Bucket</Form.Label>
            <Form.Control value={backupForm.bucket} onChange={set("bucket")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Directory (optional)</Form.Label>
            <Form.Control value={backupForm.dir} onChange={set("dir")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Credentials</Form.Label>
            <Form.Select value={backupForm.gcsAuthMode} onChange={set("gcsAuthMode")} disabled={disabled}>
              <option value="auto">Application Default Credentials (service account via environment)</option>
              <option value="serviceAccount">Service account key (paste JSON below)</option>
              <option value="oauth2">OAuth2 client (legacy)</option>
            </Form.Select>
          </Form.Group>
          {backupForm.gcsAuthMode === "serviceAccount" && (
            <Form.Group className="mb-2">
              <Form.Label>
                Service account JSON key {backupIsEdit && <span className="text-muted">(unchanged if left blank)</span>}
              </Form.Label>
              <Form.Control
                as="textarea"
                rows={4}
                value={backupForm.gcsServiceAccountKey}
                onChange={set("gcsServiceAccountKey")}
                disabled={disabled}
                placeholder={backupIsEdit ? "(unchanged)" : '{"type": "service_account", ...}'}
              />
            </Form.Group>
          )}
          {backupForm.gcsAuthMode === "oauth2" && (
            <>
              <Form.Group className="mb-2">
                <Form.Label>Client ID</Form.Label>
                <Form.Control value={backupForm.gcsClientID} onChange={set("gcsClientID")} disabled={disabled} />
              </Form.Group>
              <Form.Group className="mb-2">
                <Form.Label>Client secret {backupIsEdit && <span className="text-muted">(unchanged if left blank)</span>}</Form.Label>
                <Form.Control type="password" value={backupForm.gcsClientSecret} onChange={set("gcsClientSecret")} disabled={disabled} />
              </Form.Group>
              <Form.Group className="mb-2">
                <Form.Label>Refresh token {backupIsEdit && <span className="text-muted">(unchanged if left blank)</span>}</Form.Label>
                <Form.Control type="password" value={backupForm.gcsRefreshToken} onChange={set("gcsRefreshToken")} disabled={disabled} />
              </Form.Group>
            </>
          )}
        </>
      );
    }
    if (backupForm.type === "googledrive") {
      return (
        <>
          <Alert variant="info" className="py-2">
            Google Drive needs a refresh token minted outside Perkeep for now -- see doc/server-config.md.
            A "Connect with Google" button that does this for you is designed but not yet built (see
            pkg/accounts/storage_drive_oauth.go).
          </Alert>
          <Form.Group className="mb-2">
            <Form.Label>Folder ID (the Drive folder to store blobs in)</Form.Label>
            <Form.Control value={backupForm.googleDriveParentID} onChange={set("googleDriveParentID")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Client ID</Form.Label>
            <Form.Control value={backupForm.googleClientID} onChange={set("googleClientID")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Client secret {backupIsEdit && <span className="text-muted">(unchanged if left blank)</span>}</Form.Label>
            <Form.Control type="password" value={backupForm.googleClientSecret} onChange={set("googleClientSecret")} disabled={disabled} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Refresh token {backupIsEdit && <span className="text-muted">(unchanged if left blank)</span>}</Form.Label>
            <Form.Control type="password" value={backupForm.googleRefreshToken} onChange={set("googleRefreshToken")} disabled={disabled} />
          </Form.Group>
        </>
      );
    }
    return null;
  }

  function statusLabel(status) {
    if (!status || status.unknown) return <span className="text-muted">Unknown (restart may be needed)</span>;
    if (status.caught) return <span className="text-success">Caught up</span>;
    return (
      <span className="text-warning">
        Catching up ({status.blobsRemaining} blobs, {status.bytesRemaining} bytes remaining)
      </span>
    );
  }

  function renderStorageTab() {
    if (storageLoadError) return <Alert variant="danger">{storageLoadError}</Alert>;
    if (!storageLoaded || !storageConfig) return <div className="text-muted">Loading…</div>;
    const primaryLabel = storageConfig.primary
      ? `${storageConfig.primary.name || "(unnamed)"} (${storageConfig.primary.type})`
      : storageConfig.legacyPrimary
        ? `${storageConfig.legacyPrimary} (legacy field)`
        : "(not configured)";
    return (
      <>
        {storageRestartNotice && (
          <Alert variant="warning" dismissible onClose={() => setStorageRestartNotice(false)}>
            Saved. This change takes effect on the server's next restart -- storage isn't hot-reloaded.
          </Alert>
        )}
        {storageActionError && (
          <Alert variant="danger" dismissible onClose={() => setStorageActionError(null)}>
            {storageActionError}
          </Alert>
        )}
        <h5>Primary storage</h5>
        <p>
          <strong>{primaryLabel}</strong>
        </p>
        <p className="text-muted">
          There's no direct "change primary" action here -- promote an already-caught-up backup below instead. That's
          both safer (it only ever promotes something that's confirmed to already have your data) and is the real
          failover operation this is for.
        </p>

        <h5 className="mt-4">Backups</h5>
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {storageConfig.backups.map((b) => {
              const busy = backupBusy === b.name;
              return (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{b.type}</td>
                  <td>{statusLabel(b.status)}</td>
                  <td className="text-end">
                    <div className="d-inline-flex gap-2">
                      {!b.legacy && (
                        <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => openEditBackup(b)}>
                          Edit
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline-primary"
                        disabled={busy}
                        onClick={() => openPromote(b.name)}
                      >
                        Promote to primary
                      </Button>
                      <Button size="sm" variant="outline-danger" disabled={busy} onClick={() => doDeleteBackup(b.name)}>
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {storageConfig.backups.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted">
                  No backups configured.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
        <Button onClick={openAddBackup}>Add backup</Button>

        <Modal show={showBackupModal} onHide={() => !backupSaving && setShowBackupModal(false)} size="lg">
          <Modal.Header closeButton={!backupSaving}>
            <Modal.Title>{backupIsEdit ? `Edit backup "${backupForm.name}"` : "Add backup"}</Modal.Title>
          </Modal.Header>
          <Form onSubmit={submitBackup}>
            <Modal.Body>
              {backupSaveError && (
                <Alert variant="danger" className="py-2">
                  {backupSaveError}
                </Alert>
              )}
              <Form.Group className="mb-2">
                <Form.Label>Name</Form.Label>
                <Form.Control
                  value={backupForm.name}
                  onChange={(e) => setBackupForm({ ...backupForm, name: e.target.value })}
                  disabled={backupSaving || backupIsEdit}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>Type</Form.Label>
                <Form.Select
                  value={backupForm.type}
                  onChange={(e) => setBackupForm({ ...backupForm, type: e.target.value })}
                  disabled={backupSaving || backupIsEdit}
                >
                  {BACKUP_STORAGE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              {renderBackupFields()}
              {backupTestResult && (
                <Alert variant={backupTestResult.ok ? "success" : "danger"} className="py-2 mt-2">
                  {backupTestResult.ok ? "Connection OK." : backupTestResult.message}
                </Alert>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="outline-secondary" onClick={testBackupForm} disabled={backupSaving || backupTesting}>
                {backupTesting ? "Testing…" : "Test connection"}
              </Button>
              <Button variant="outline-secondary" onClick={() => setShowBackupModal(false)} disabled={backupSaving}>
                Cancel
              </Button>
              <Button type="submit" disabled={backupSaving || !backupForm.name.trim()}>
                {backupSaving ? "Saving…" : "Save"}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>

        <Modal show={promoteTarget != null} onHide={() => !promoteWorking && setPromoteTarget(null)}>
          <Modal.Header closeButton={!promoteWorking}>
            <Modal.Title>Promote "{promoteTarget}" to primary?</Modal.Title>
          </Modal.Header>
          <Form onSubmit={submitPromote}>
            <Modal.Body>
              {promoteError && (
                <Alert variant="danger" className="py-2">
                  {promoteError}
                </Alert>
              )}
              <p>
                <strong>{promoteTarget}</strong> will become the primary storage. The current primary will be kept as
                a backup of it, unless you uncheck that below.
              </p>
              <Form.Check
                type="checkbox"
                id="promote-keep-old"
                label="Keep the current primary as a backup after promotion (recommended)"
                checked={promoteKeepOld}
                onChange={(e) => setPromoteKeepOld(e.target.checked)}
                disabled={promoteWorking}
                className="mb-2"
              />
              <Form.Check
                type="checkbox"
                id="promote-force"
                label="Promote even if this backup isn't fully caught up (anything still queued won't be on the new primary)"
                checked={promoteForce}
                onChange={(e) => setPromoteForce(e.target.checked)}
                disabled={promoteWorking}
              />
            </Modal.Body>
            <Modal.Footer>
              <Button variant="outline-secondary" onClick={() => setPromoteTarget(null)} disabled={promoteWorking}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={promoteWorking}>
                {promoteWorking ? "Promoting…" : "Promote"}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
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
        <Tab eventKey="storage" title="Storage">
          {renderStorageTab()}
        </Tab>
      </Tabs>
    </div>
  );
}
