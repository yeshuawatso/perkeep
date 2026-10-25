import { useCallback, useEffect, useState } from "react";

import { login as apiLogin, setAuthToken, setUnauthorizedHandler } from "../api/client.js";

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

  const login = useCallback(async (username, password) => {
    const result = await apiLogin(username, password);
    setCurrent({ token: result.token, username: result.username || username });
  }, []);

  const logout = useCallback(() => setCurrent(null), []);

  return { token: state?.token || null, username: state?.username || null, login, logout };
}
