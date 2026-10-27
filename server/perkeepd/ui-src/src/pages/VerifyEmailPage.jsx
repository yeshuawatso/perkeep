import { useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { serverErrorMessage, verifyEmail } from "../api/client.js";
import { useAuth } from "../hooks/useAuth.js";

// Standalone route (see App.jsx), reached from the link in the
// verify-email email -- "?token=...". Redeems the token on mount (not on
// a button click -- there's nothing to confirm first, the token itself is
// the proof) and, if the viewer happens to already be logged in,
// refreshes their account state so the verify-email banner disappears
// immediately rather than on the next reload.
export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [status, setStatus] = useState(token ? "working" : "missing-token");
  const [error, setError] = useState(null);
  const { token: sessionToken, refreshAccount } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) return;
    verifyEmail(token)
      .then(async () => {
        if (sessionToken) await refreshAccount();
        setStatus("done");
      })
      .catch((err) => {
        setError(serverErrorMessage(err) || "This link is invalid or has expired.");
        setStatus("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
      <div className="p-4 border rounded shadow-sm text-center" style={{ width: 320 }}>
        <div className="d-flex align-items-center justify-content-center mb-3">
          <i className="bi bi-archive-fill me-2 fs-3" />
          <h4 className="mb-0">Verify email</h4>
        </div>
        {status === "working" && <div className="text-muted">Verifying…</div>}
        {status === "missing-token" && <Alert variant="danger">This link is missing its token.</Alert>}
        {status === "error" && <Alert variant="danger">{error}</Alert>}
        {status === "done" && (
          <>
            <Alert variant="success">Your email is verified.</Alert>
            <Button className="w-100" onClick={() => navigate(sessionToken ? "/" : "/login")}>
              {sessionToken ? "Continue" : "Sign in"}
            </Button>
          </>
        )}
        {status !== "done" && (
          <div className="mt-2">
            <Link to="/login">Back to sign in</Link>
          </div>
        )}
      </div>
    </div>
  );
}
