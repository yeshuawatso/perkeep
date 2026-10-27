import { useEffect, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useNavigate } from "react-router-dom";

import { getSignupEnabled } from "../api/client.js";
import { useAuth } from "../hooks/useAuth.js";

// Standalone route (see App.jsx) -- rendered without AppLayout/useDiscovery,
// so it works before any authenticated call can succeed.
export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  // Best-effort -- the server enforces this regardless (ErrSignupDisabled);
  // this only decides whether to show the link at all.
  useEffect(() => {
    getSignupEnabled()
      .then((r) => setSignupEnabled(r.enabled))
      .catch(() => setSignupEnabled(false));
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await login(username, password);
      navigate("/", { replace: true });
    } catch {
      setError("Incorrect username or password.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
      <Form onSubmit={submit} className="p-4 border rounded shadow-sm" style={{ width: 320 }}>
        <div className="d-flex align-items-center mb-3">
          <i className="bi bi-archive-fill me-2 fs-3" />
          <h4 className="mb-0">Perkeep</h4>
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
            // Usernames are case-sensitive, but mobile keyboards (notably
            // iOS with a Magic Keyboard) force the first character
            // uppercase by default unless the field opts out -- without
            // this, there's no way to type a lowercase first letter at all.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Password</Form.Label>
          <Form.Control
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={working}
          />
        </Form.Group>
        <Button type="submit" className="w-100" disabled={working || !username || !password}>
          {working ? "Signing in…" : "Sign in"}
        </Button>
        <div className="text-center mt-3 d-flex justify-content-between">
          <Link to="/forgot-password">Forgot password?</Link>
          {signupEnabled && <Link to="/signup">Sign up</Link>}
        </div>
      </Form>
    </div>
  );
}
