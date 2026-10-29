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
  // user browsing and exact-@username "registered" sharing both resolve
  // an account to its on-file email and send the same link, so a
  // deployment only ever offers one or the other, never both -- a
  // local/trusted instance exposes the directory; a public/untrusted one
  // doesn't, since letting any account enumerate every other account is
  // the thing that's unsafe there.
  const [directoryAvailable, setDirectoryAvailable] = useState(false);
  const [localUser, setLocalUser] = useState("");
  const [handle, setHandle] = useState("");
  const [handleStatus, setHandleStatus] = useState(null); // null | "checking" | "found" | "not-found"
  const [email, setEmail] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  // Set from sendShareNotice's response when "registered" mode's typed
  // @username doesn't match any account -- there's no email on file to
  // notify, so this is shown to the sharer instead (see pkg/accounts'
  // handleSharesNotify), telling them to pass the link along themselves.
  const [registerNotice, setRegisterNotice] = useState(null);
  // Whether the "Copied to clipboard" confirmation is currently showing --
  // see copyResultLink below for why the link itself isn't shown as text.
  const [copied, setCopied] = useState(false);
  // Diagnostic lines from the last copy attempt, shown inline -- there's no
  // devtools available on a phone, so this is the only way to see why a
  // copy silently failed (e.g. navigator.clipboard not existing at all on
  // a plain-HTTP origin, which is what iOS Safari does: the Clipboard API
  // is restricted to secure contexts and isn't just "limited" on HTTP, it
  // isn't present on window.navigator at all).
  const [copyTrace, setCopyTrace] = useState(null);
  const debounceRef = useRef(null);
  const copiedTimerRef = useRef(null);

  // "Registered" mode identifies a recipient by their exact @username,
  // never an email address -- resolving by email would let the sharer
  // test whether some address has an account here. The leading "@" is
  // what lets this be told apart from an email address up front, before
  // any lookup happens (see pkg/accounts' parseUsernameHandle).
  const handleIsValid = /^@[^\s@]+$/.test(handle.trim());

  // The mode this deployment offers alongside "external", and its label
  // -- "local" (directory picker) when the directory is available,
  // "registered" (exact-@username input) when it isn't.
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
    setRegisterNotice(null);
    setCopied(false);
    setCopyTrace(null);
    setDirectory([]);
    setDirectoryAvailable(false);
    // A 403 here (exposeUserDirectory is off) is expected, not an error
    // -- it just means this deployment uses the exact-@username
    // "registered" flow instead of the local-user picker.
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
    // Only resolve once the handle actually looks like "@username" --
    // never send a bare word or an email-shaped string to the lookup,
    // same format rule the server enforces (parseUsernameHandle).
    if (!handleIsValid) {
      setHandleStatus("bad-format");
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
  }, [mode, handle, handleIsValid]);

  const recipient = mode === "local" ? localUser : mode === "registered" ? handle.trim() : email.trim();
  const canSubmit =
    !working &&
    (mode !== "local" || !!localUser) &&
    // "registered" mode doesn't require the typed handle to already
    // match an account -- an unmatched @username still creates a working
    // share link, just with no notification sent (see pkg/accounts'
    // handleSharesNotify's doc on why there's nothing to email in that
    // case). It does require the "@username" format and a finished
    // lookup, though, so a malformed or still-checking handle can't be
    // submitted.
    (mode !== "registered" || (handleIsValid && handleStatus !== "checking"));

  // Last-resort copy path for when navigator.clipboard isn't there at all
  // (see copyResultLink) -- document.execCommand("copy") is deprecated but
  // still works in a plain-HTTP/insecure-context tab, which is exactly the
  // case the async Clipboard API refuses outright, not just restricts.
  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but still focusable/selectable -- execCommand("copy")
    // only acts on the current selection, so the element needs real focus.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }

  // Copies resultUrl to the clipboard instead of relying on the sharer
  // long-press-selecting it out of the link text -- on iOS that often
  // grabs only part of the URL and doesn't even reliably offer "Copy
  // Link" in the context menu, since the link is hidden behind the
  // plain-text "Link" label below rather than shown in full.
  //
  // navigator.clipboard is only defined in a "secure context" (HTTPS, or
  // localhost) -- on a plain-HTTP deployment (e.g. this project's own
  // disposable test host) it's simply absent on iOS/Safari, not merely
  // permission-gated, so the old code's try/catch around
  // navigator.clipboard.writeText was silently swallowing a TypeError on
  // every tap there. Confirmed directly with a WebKit/iPhone-emulated
  // Playwright run against the test host: `navigator.clipboard` was
  // `undefined` and the call threw "undefined is not an object
  // (evaluating 'navigator.clipboard.writeText')". The trace below surfaces
  // that instead of hiding it, and legacyCopy() above is attempted next so
  // the copy still works on an insecure origin.
  async function copyResultLink() {
    const trace = [
      `origin: ${location.protocol}//${location.host}`,
      `isSecureContext: ${window.isSecureContext}`,
      `navigator.clipboard present: ${!!navigator.clipboard}`,
    ];
    let ok = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(resultUrl);
        ok = true;
        trace.push("copied via navigator.clipboard.writeText");
      } catch (err) {
        trace.push(`navigator.clipboard.writeText threw: ${err?.name}: ${err?.message}`);
      }
    } else {
      trace.push("navigator.clipboard.writeText not available -- likely a non-HTTPS origin");
    }
    if (!ok) {
      try {
        ok = legacyCopy(resultUrl);
        trace.push(ok ? "copied via document.execCommand(\"copy\") fallback" : 'document.execCommand("copy") fallback returned false');
      } catch (err) {
        trace.push(`execCommand("copy") fallback threw: ${err?.name}: ${err?.message}`);
      }
    }
    setCopied(ok);
    setCopyTrace(trace.join("\n"));
    if (ok) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  }

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
        try {
          const notice = await sendShareNotice({
            target,
            shareClaimRef,
            isFile,
            itemTitle,
            mode,
            recipient,
            expiresIn: expiresInLabel(expiryDays),
          });
          if (notice?.notRegistered) {
            // "Registered" mode's handle didn't match any account -- there's
            // no email on file to notify, so tell the sharer to pass the
            // link along themselves (see pkg/accounts' handleSharesNotify).
            setRegisterNotice({ handle: recipient, registerUrl: notice.registerUrl });
          }
        } catch {
          // Best-effort, same as every other notification send in this
          // codebase (handler.go's sendNotification) -- the link above is
          // always shown regardless, so a failed/unconfigured send never
          // strands the sharer with nothing to give the recipient.
        }
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
          <p>Share link{recipient && !registerNotice ? " created and sent" : " created"}:</p>
          <div className="d-flex align-items-center gap-2">
            <a href={resultUrl} target="_blank" rel="noreferrer">
              Link
            </a>
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={copyResultLink}
              aria-label="Copy link to clipboard"
            >
              <i className={`bi ${copied ? "bi-clipboard-check" : "bi-clipboard"}`} />
            </Button>
            {copied && <span className="text-success small">Copied to clipboard!</span>}
          </div>
          {copyTrace && (
            <pre
              className="text-muted small bg-light border rounded p-2 mt-2 mb-0"
              style={{ userSelect: "all", whiteSpace: "pre-wrap" }}
            >
              {copyTrace}
            </pre>
          )}
          {registerNotice && (
            <Alert variant="info" className="py-2 mt-3 mb-0">
              No one named <strong>{registerNotice.handle}</strong> is registered here yet, so no
              email was sent. Pass the link above along to them yourself, along with: &ldquo;You
              need an account to add this to your library &mdash; register here:
              {" "}
              <a href={registerNotice.registerUrl}>{registerNotice.registerUrl}</a>&rdquo;
            </Alert>
          )}
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
                <Form.Label>Username</Form.Label>
                <Form.Control
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  disabled={working}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="@username"
                />
                {handleStatus === "bad-format" && (
                  <Form.Text className="text-muted">Must start with @, e.g. @alice.</Form.Text>
                )}
                {handleStatus === "checking" && <Form.Text className="text-muted">Checking…</Form.Text>}
                {handleStatus === "found" && <Form.Text className="text-success">Account found.</Form.Text>}
                {handleStatus === "not-found" && (
                  <Form.Text className="text-muted">
                    No account matches that username yet -- you can still share the link, but no
                    notification will be sent.
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
