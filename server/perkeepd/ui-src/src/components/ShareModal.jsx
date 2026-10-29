import { useEffect, useRef, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";

import { createShareClaim, createShareRecord, getUserDirectory, resolveRecipient, sendShareNotice } from "../api/client.js";

const EXPIRY_PRESETS = [
  { label: "Never", value: "" },
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
];

function expiryToDate(days) {
  if (!days) return "";
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function expiresInLabel(days) {
  if (!days) return "";
  return days === 1 ? "1 day" : `${days} days`;
}

// SelectionActions.jsx's "Share" button opens this instead of going
// straight to createShareClaim -- see docs/multi-tenant-roadmap.md's
// Phase 5 section. target/isFile/itemTitle describe what's being shared
// (the same distinction SelectionActions.jsx's old share() already made
// between a single file vs. a permanode/set) -- this modal just adds the
// target-mode picker, expiration, and (for local/registered/external-
// with-email) the notify email on top of the same createShareClaim call.
export default function ShareModal({ show, onHide, disco, target, isFile, itemTitle }) {
  const [mode, setMode] = useState("external");
  const [directory, setDirectory] = useState([]);
  // Whether GET /auth/directory is actually available -- the server
  // operator's exposeUserDirectory setting (pkg/types/serverconfig.
  // Config.ExposeUserDirectory) decides this, not a UI toggle: local-
  // user browsing and exact-email "registered" sharing are the same
  // underlying mechanism (both just resolve to an email and send the
  // same link), so a deployment only ever offers one or the other, never
  // both -- a local/trusted instance exposes the directory; a public/
  // untrusted one doesn't, since letting any account enumerate every
  // other account is the thing that's unsafe there.
  const [directoryAvailable, setDirectoryAvailable] = useState(false);
  const [localUser, setLocalUser] = useState("");
  const [handle, setHandle] = useState("");
  const [handleStatus, setHandleStatus] = useState(null); // null | "checking" | "found" | "not-found"
  const [email, setEmail] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const debounceRef = useRef(null);

  // The mode this deployment offers alongside "external", and its label
  // -- "local" (directory picker) when the directory is available,
  // "registered" (exact-email input) when it isn't.
  const directoryMode = directoryAvailable ? "local" : "registered";
  const directoryModeLabel = directoryAvailable ? "A local user" : "A registered user";

  useEffect(() => {
    if (!show) return;
    setMode("external");
    setLocalUser("");
    setHandle("");
    setHandleStatus(null);
    setEmail("");
    setExpiryDays("");
    setWorking(false);
    setError(null);
    setResultUrl(null);
    setDirectory([]);
    setDirectoryAvailable(false);
    // A 403 here (exposeUserDirectory is off) is expected, not an error
    // -- it just means this deployment uses the exact-email "registered"
    // flow instead of the local-user picker.
    getUserDirectory()
      .then((usernames) => {
        setDirectory(usernames);
        setDirectoryAvailable(true);
      })
      .catch(() => {
        setDirectory([]);
        setDirectoryAvailable(false);
      });
  }, [show]);

  useEffect(() => {
    if (mode !== "registered" || !handle.trim()) {
      setHandleStatus(null);
      return;
    }
    setHandleStatus("checking");
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      resolveRecipient(handle.trim())
        .then((r) => setHandleStatus(r.found ? "found" : "not-found"))
        .catch(() => setHandleStatus(null));
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [mode, handle]);

  const recipient = mode === "local" ? localUser : mode === "registered" ? handle.trim() : email.trim();
  const canSubmit =
    !working &&
    (mode !== "local" || !!localUser) &&
    // "registered" mode no longer requires the typed address to already
    // match an account (handleStatus === "found") -- an unmatched
    // address still gets an email inviting them to register (see
    // pkg/accounts' handleSharesNotify), so only block submit while the
    // live lookup is still in flight or the field is empty.
    (mode !== "registered" || (handleStatus !== "checking" && !!handle.trim()));

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setWorking(true);
    setError(null);
    try {
      const expires = expiryToDate(expiryDays);
      const shareClaimRef = await createShareClaim(target, { transitive: true, expires });
      await createShareRecord({ shareClaimRef, target, mode, recipient, itemTitle, expires });
      const url = isFile
        ? `${disco.shareRoot}${target}?via=${shareClaimRef}&assemble=1`
        : `${disco.shareRoot}${shareClaimRef}`;
      setResultUrl(url);
      if (recipient) {
        await sendShareNotice({
          target,
          shareClaimRef,
          isFile,
          itemTitle,
          mode,
          recipient,
          expiresIn: expiresInLabel(expiryDays),
        }).catch(() => {
          // Best-effort, same as every other notification send in this
          // codebase (handler.go's sendNotification) -- the link above is
          // always shown regardless, so a failed/unconfigured send never
          // strands the sharer with nothing to give the recipient.
        });
      }
    } catch (err) {
      setError(err?.message || "Could not create share link.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal show={show} onHide={working ? undefined : onHide} centered>
      <Modal.Header closeButton={!working}>
        <Modal.Title>Share</Modal.Title>
      </Modal.Header>
      {resultUrl ? (
        <Modal.Body>
          <p>Share link{recipient ? " created and sent" : " created"}:</p>
          <a href={resultUrl} target="_blank" rel="noreferrer">
            {resultUrl}
          </a>
        </Modal.Body>
      ) : (
        <Form onSubmit={submit}>
          <Modal.Body>
            {error && (
              <Alert variant="danger" className="py-2">
                {error}
              </Alert>
            )}
            <Form.Group className="mb-3">
              <Form.Label>Share with</Form.Label>
              <div className="d-flex gap-3">
                {[
                  ["external", "Anyone with the link"],
                  [directoryMode, directoryModeLabel],
                ].map(([val, label]) => (
                  <Form.Check
                    key={val}
                    type="radio"
                    id={`share-mode-${val}`}
                    name="share-mode"
                    label={label}
                    checked={mode === val}
                    disabled={working}
                    onChange={() => setMode(val)}
                  />
                ))}
              </div>
            </Form.Group>
            {mode === "local" && (
              <Form.Group className="mb-3">
                <Form.Label>User</Form.Label>
                <Form.Select value={localUser} onChange={(e) => setLocalUser(e.target.value)} disabled={working}>
                  <option value="">Select a user…</option>
                  {directory.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            )}
            {mode === "registered" && (
              <Form.Group className="mb-3">
                <Form.Label>Email address</Form.Label>
                <Form.Control
                  type="email"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  disabled={working}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="name@example.com"
                />
                {handleStatus === "checking" && <Form.Text className="text-muted">Checking…</Form.Text>}
                {handleStatus === "found" && <Form.Text className="text-success">Account found.</Form.Text>}
                {handleStatus === "not-found" && (
                  <Form.Text className="text-muted">
                    No account matches that address yet -- they&apos;ll get an email inviting them to register.
                  </Form.Text>
                )}
              </Form.Group>
            )}
            {mode === "external" && (
              <Form.Group className="mb-3">
                <Form.Label>Email (optional)</Form.Label>
                <Form.Control
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={working}
                  placeholder="Leave blank to just get a link"
                />
              </Form.Group>
            )}
            <Form.Group className="mb-2">
              <Form.Label>Expires</Form.Label>
              <Form.Select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} disabled={working}>
                {EXPIRY_PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline-secondary" onClick={onHide} disabled={working}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {working ? "Sharing…" : "Share"}
            </Button>
          </Modal.Footer>
        </Form>
      )}
    </Modal>
  );
}
