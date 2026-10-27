import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useNavigate } from "react-router-dom";

import { serverErrorMessage } from "../api/client.js";
import PasswordRequirementHint from "../components/PasswordRequirementHint.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { usePasswordPolicy } from "../hooks/usePasswordPolicy.js";

// Standalone route (see App.jsx), only reachable when GET /auth/signup-enabled
// says so -- the server enforces that too (ErrSignupDisabled), this is just UX.
export default function SignupPage() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const { signup } = useAuth();
  const policy = usePasswordPolicy();
  const navigate = useNavigate();

  const weakPassword = password && policy.regex ? !policy.regex.test(password) : false;

  async function submit(e) {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await signup(username.trim(), email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(serverErrorMessage(err) || "Could not create account.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
      <Form onSubmit={submit} className="p-4 border rounded shadow-sm" style={{ width: 320 }}>
        <div className="d-flex align-items-center mb-3">
          <i className="bi bi-archive-fill me-2 fs-3" />
          <h4 className="mb-0">Sign up</h4>
        </div>
        {error && (
          <Alert variant="danger" className="py-2">
            {error}
          </Alert>
        )}
        <Form.Group className="mb-3">
          <Form.Label>Username</Form.Label>
          <Form.Control
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={working}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Email</Form.Label>
          <Form.Control
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={working}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Form.Text className="text-muted">We'll send a link here to verify your account.</Form.Text>
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Password</Form.Label>
          <Form.Control
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={working}
          />
          <PasswordRequirementHint description={policy.description} matches={password ? !weakPassword : undefined} />
        </Form.Group>
        <Button
          type="submit"
          className="w-100"
          disabled={working || !username.trim() || !email.trim() || !password || weakPassword}
        >
          {working ? "Creating account…" : "Sign up"}
        </Button>
        <div className="text-center mt-3">
          <Link to="/login">Already have an account? Sign in</Link>
        </div>
      </Form>
    </div>
  );
}
