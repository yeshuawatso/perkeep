import { useCallback, useEffect, useRef, useState } from "react";

import { DEFAULT_DESCRIBE_RULES, getAuthToken, getDiscovery, search } from "../api/client.js";

const PAGE_SIZE = 50;

// Port of search_session.js: runs the query, paginates via the `continue`
// token (cam.SearchSession's PAGE_SIZE_), and layers a WebSocket on top for
// live updates -- the old UI's first message after connecting is purely a
// "this socket supports the protocol" probe and is discarded; only the
// second and later messages replace the result set. If the socket errors,
// results just stop updating live (silently; same as the old behavior).
export function useSearchSession(queryExpr) {
  const [state, setState] = useState({
    refs: [],
    meta: {},
    loading: true,
    done: false,
    error: null,
    socketError: false,
  });
  const continueToken = useRef(null);
  const loadingMore = useRef(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // The browser's back/forward cache can restore this page without rerunning
  // mount effects -- a socket closed (and its onerror->socketError:true) right
  // before the page was frozen would otherwise leave that error flag stuck
  // forever, since nothing ever reruns the connect effect below to clear it.
  useEffect(() => {
    function onPageShow(e) {
      if (e.persisted) setReconnectNonce((n) => n + 1);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  function applyResult(result, replace) {
    const refs = (result.blobs || []).map((b) => b.blob);
    const meta = result.description?.meta || {};
    continueToken.current = result.continue || null;
    setState((s) => ({
      ...s,
      loading: false,
      refs: replace ? refs : [...s.refs, ...refs],
      meta: replace ? meta : { ...s.meta, ...meta },
      done: !result.continue,
      error: result.error || null,
    }));
  }

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !continueToken.current) return;
    loadingMore.current = true;
    try {
      const result = await search(queryExpr || { camliType: "permanode" }, {
        limit: PAGE_SIZE,
        continue: continueToken.current,
      });
      applyResult(result, false);
    } finally {
      loadingMore.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryExpr]);

  useEffect(() => {
    let ws;
    let cancelled = false;
    let firstMessage = true;

    continueToken.current = null;
    setState((s) => ({ ...s, loading: true, refs: [], meta: {}, done: false, error: null, socketError: false }));

    search(queryExpr || { camliType: "permanode" }, { limit: PAGE_SIZE })
      .then((result) => !cancelled && applyResult(result, true))
      .catch((err) => !cancelled && setState((s) => ({ ...s, loading: false, error: String(err) })));

    (async () => {
      const disco = await getDiscovery();
      if (cancelled || !disco.searchRoot) return;
      try {
        const httpUrl = new URL("camli/search/ws", new URL(disco.searchRoot, window.location.href));
        httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
        const jwt = getAuthToken();
        if (jwt) httpUrl.searchParams.set("access_token", jwt);
        ws = new WebSocket(httpUrl.toString());
        const tag = "s" + Math.random().toString(36).slice(2);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              tag,
              query: {
                ...(typeof queryExpr === "string"
                  ? { expression: queryExpr }
                  : { constraint: queryExpr || { camliType: "permanode" } }),
                sort: "-created",
                limit: PAGE_SIZE,
                describe: DEFAULT_DESCRIBE_RULES,
              },
            }),
          );
        };
        ws.onmessage = (ev) => {
          if (firstMessage) {
            firstMessage = false;
            return;
          }
          try {
            const msg = JSON.parse(ev.data);
            if (msg.tag === tag && msg.result) applyResult(msg.result, true);
          } catch {
            // ignore malformed push, keep whatever we last had
          }
        };
        ws.onerror = () => !cancelled && setState((s) => ({ ...s, socketError: true }));
      } catch {
        if (!cancelled) setState((s) => ({ ...s, socketError: true }));
      }
    })();

    return () => {
      cancelled = true;
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryExpr, reconnectNonce]);

  return { ...state, loadMore };
}
