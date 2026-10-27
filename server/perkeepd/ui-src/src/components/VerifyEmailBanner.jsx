import { useState } from "react";

import { resendVerification, serverErrorMessage } from "../api/client.js";

// Shown from AppLayout.jsx whenever the signed-in account isn't verified
// yet (self-signup only -- see pkg/accounts' attrVerified doc) -- same
// placement as the Phase 1 impersonation banner. Writes (upload, create,
// etc.) are blocked server-side regardless of whether this is dismissed;
// it's just a visible explanation plus the one action (resend) that gets
// a user unstuck.
export default function VerifyEmailBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // "sent" | error string | null

  if (dismissed) return null;

  async function resend() {
    setSending(true);
    setResult(null);
    try {
      await resendVerification();
      setResult("sent");
    } catch (err) {
      setResult(serverErrorMessage(err) || "Could not resend the verification email.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-warning text-dark text-center py-1 small">
      Please verify your email -- uploads and other changes are disabled until you do.{" "}
      {result === "sent" ? (
        "Verification email sent."
      ) : (
        <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={resend} disabled={sending}>
          {sending ? "Sending…" : "Resend verification email"}
        </button>
      )}
      {result && result !== "sent" && <span className="text-danger ms-2">{result}</span>}{" "}
      <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
