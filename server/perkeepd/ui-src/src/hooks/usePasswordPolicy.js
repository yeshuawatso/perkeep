import { useEffect, useMemo, useState } from "react";

import { getPasswordPolicy } from "../api/client.js";

// The server's optional password-strength policy (pkg/accounts'
// passwordPolicyPattern/passwordPolicyDescription config keys). It's
// server configuration, not per-user state, so it's fetched once and
// shared by every form that collects a new password (Account page,
// Admin page's create-user and reset-password forms).
let cached = null;

export function usePasswordPolicy() {
  const [policy, setPolicy] = useState(cached || {});

  useEffect(() => {
    if (cached) return;
    getPasswordPolicy()
      .then((p) => {
        cached = p;
        setPolicy(p);
      })
      .catch(() => setPolicy({}));
  }, []);

  // Not every RE2 pattern an operator might configure has a JS RegExp
  // equivalent (no lookaround, no inline flags like "(?i)") -- if
  // construction throws, there's simply no live client-side preview. The
  // description still shows regardless, and the server is the real
  // enforcement point either way.
  const regex = useMemo(() => {
    if (!policy.pattern) return null;
    try {
      return new RegExp(policy.pattern);
    } catch {
      return null;
    }
  }, [policy.pattern]);

  return { ...policy, regex };
}
