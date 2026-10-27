import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { resetPasswordWithToken, serverErrorMessage } from "../api/client.js";
import PasswordRequirementHint from "../components/PasswordRequirementHint.jsx";
import { usePasswordPolicy } from "../hooks/usePasswordPolicy.js";

// Standalone route (see App.jsx), reached from the link in the
// forgot-password email -- "?token=...".
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [working, setWorking] = useState(false);
  const policy = usePasswordPolicy();
  const navigate = useNavigate();

  const weakPassword = password && policy.regex ? !policy.regex.test(password) : false;

  async function submit(e) {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await resetPasswordWithToken(token, password);
      setDone(true);
    } catch (err) {
      setError(serverErrorMessage(err) || "Could not reset password. The link may have expired.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
      <Form onSubmit={submit} className="p-4 border rounded shadow-sm" style={{ width: 320 }}>
        <div className="d-flex align-items-center mb-3">
          <i className="bi bi-archive-fill me-2 fs-3" />
          <h4 className="mb-0">Choose a new password</h4>
        </div>
        {!token && <Alert variant="danger">This link is missing its token.</Alert>}
        {error && (
          <Alert variant="danger" className="py-2">
            {error}
          </Alert>
        )}
        {done ? (
          <>
            <Alert variant="success" className="py-2">
              Your password has been reset.
            </Alert>
            <Button className="w-100" onClick={() => navigate("/login")}>
              Sign in
            </Button>
          </>
        ) : (
          <>
            <Form.Group className="mb-3">
              <Form.Label>New password</Form.Label>
              <Form.Control
                autoFocus
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={working || !token}
              />
              <PasswordRequirementHint
                description={policy.description}
                matches={password ? !weakPassword : undefined}
              />
            </Form.Group>
            <Button type="submit" className="w-100" disabled={working || !token || !password || weakPassword}>
              {working ? "Resetting…" : "Reset password"}
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
