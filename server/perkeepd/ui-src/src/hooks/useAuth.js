import { useCallback, useEffect, useState } from "react";

import {
  getAccount,
  impersonate as apiImpersonate,
  login as apiLogin,
  setAuthToken,
  setUnauthorizedHandler,
  signup as apiSignup,
} from "../api/client.js";

const STORAGE_KEY = "perkeep.auth";

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private window / blocked storage -- the session just won't survive a reload.
  }
}

// Module-level store (same idiom as client.js's memoized discoveryPromise):
// login/logout from any one component (e.g. AppNavbar's Logout item) has to
// be visible to every other useAuth() caller (e.g. App.jsx's RequireAuth
// guard), and client.js's apiFetch needs the current token without a React
// import, so this is the single source of truth both read from.
let current = readStored();
const listeners = new Set();
setAuthToken(current?.token || null);

function setCurrent(value) {
  current = value;
  writeStored(value);
  setAuthToken(value?.token || null);
  listeners.forEach((l) => l(value));
}

// Any 401 (expired/invalid session JWT, revoked API token used from the
// browser, etc.) drops the stored session so the next render's RequireAuth
// check sends the user back to /login.
setUnauthorizedHandler(() => setCurrent(null));

export function useAuth() {
  const [state, setState] = useState(current);

  useEffect(() => {
    listeners.add(setState);
    return () => listeners.delete(setState);
  }, []);

  // login()/impersonate()/signup() only get {token, username} back --
  // isAdmin, verified, and (for impersonate) impersonatedBy come from GET
  // /auth/account, so anything that needs them (the navbar's Admin item,
  // the impersonation banner, the verify-email banner) calls this once a
  // token exists. AppLayout does this on mount; AccountPage's own
  // getAccount() call keeps the Account page itself independently up to
  // date.
  const refreshAccount = useCallback(async () => {
    if (!current?.token) return;
    const acct = await getAccount();
    setCurrent({
      ...current,
      isAdmin: acct.isAdmin,
      verified: acct.verified,
      impersonatedBy: acct.impersonatedBy || null,
    });
  }, []);

  const login = useCallback(
    async (username, password) => {
      const result = await apiLogin(username, password);
      setCurrent({ token: result.token, username: result.username || username });
      await refreshAccount();
    },
    [refreshAccount],
  );

  // Logs the new account in immediately -- an unverified account is
  // allowed to use the server, just not to upload (see
  // pkg/blobserver/handlers' VerifiedFunc); the verify-email banner
  // (components/VerifyEmailBanner.jsx) covers the rest.
  const signup = useCallback(
    async (username, email, password) => {
      const result = await apiSignup(username, email, password);
      setCurrent({ token: result.token, username: result.username || username });
      await refreshAccount();
    },
    [refreshAccount],
  );

  const logout = useCallback(() => setCurrent(null), []);

  // Admin-only (server enforces this -- see pkg/accounts/admin.go).
  // Replaces the current session outright; there's no dual-session
  // juggling -- returning to your own account is just logging back in.
  const impersonate = useCallback(
    async (username) => {
      const result = await apiImpersonate(username);
      setCurrent({ token: result.token, username });
      await refreshAccount();
    },
    [refreshAccount],
  );

  return {
    token: state?.token || null,
    username: state?.username || null,
    isAdmin: state?.isAdmin || false,
    // Defaults to true (not false) while unknown/not-yet-fetched -- same
    // reasoning as the server's own attrVerified convention (account.go):
    // absence means "nothing to warn about here", not "show the banner".
    verified: state?.verified !== false,
    impersonatedBy: state?.impersonatedBy || null,
    login,
    signup,
    logout,
    impersonate,
    refreshAccount,
  };
}
