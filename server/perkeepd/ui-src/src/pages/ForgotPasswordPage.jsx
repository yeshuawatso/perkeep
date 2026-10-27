import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link } from "react-router-dom";

import { forgotPassword } from "../api/client.js";

// Standalone route (see App.jsx). Always shows the same success message
// whether or not emailOrUsername matched a real account -- see
// pkg/accounts' RequestPasswordReset on why (account enumeration); this
// page must never let the response itself leak that distinction either.
export default function ForgotPasswordPage() {
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [working, setWorking] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await forgotPassword(emailOrUsername.trim());
      setSent(true);
    } catch {
      // The only failures that reach here are server-side (bad request,
      // or the server has no baseURL configured) -- never "no such
      // account", which the server itself never distinguishes.
      setError("Something went wrong. Please try again later.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
      <Form onSubmit={submit} className="p-4 border rounded shadow-sm" style={{ width: 320 }}>
        <div className="d-flex align-items-center mb-3">
          <i className="bi bi-archive-fill me-2 fs-3" />
          <h4 className="mb-0">Reset password</h4>
        </div>
        {error && (
          <Alert variant="danger" className="py-2">
            {error}
          </Alert>
        )}
        {sent ? (
          <Alert variant="success" className="py-2">
            If an account matches, we've sent a password reset link to its email address.
          </Alert>
        ) : (
          <>
            <Form.Group className="mb-3">
              <Form.Label>Username or email</Form.Label>
              <Form.Control
                autoFocus
                value={emailOrUsername}
                onChange={(e) => setEmailOrUsername(e.target.value)}
                disabled={working}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Form.Group>
            <Button type="submit" className="w-100" disabled={working || !emailOrUsername.trim()}>
              {working ? "Sending…" : "Send reset link"}
            </Button>
          </>
        )}
        <div className="text-center mt-3">
          <Link to="/login">Back to sign in</Link>
        </div>
      </Form>
    </div>
  );
}
