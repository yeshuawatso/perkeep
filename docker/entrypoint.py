#!/usr/bin/env python3
"""Container entrypoint for perkeepd.

First boot: no server-config.json exists yet at $CAMLI_CONFIG_DIR, so this script does
nothing but exec perkeepd directly -- perkeepd's own serverinit.WriteDefaultConfigFile
already auto-generates a SQLite-backed config plus a fresh GPG identity the first time it
starts with no config file present (see pkg/serverinit/genconfig.go), and there is no safe
way to pre-empt that from outside the Go process. Env-driven settings (auth, baseURL,
switching to postgres) only take effect from the *second* boot onward, once that file
exists for this script to patch -- this mirrors how the real migration was actually done
and verified by hand against chaos-v3-perkeep-host (boot once, then edit server-config.json,
then restart), rather than inventing an unverified single-boot path.

Migrating the index backend to postgres needs a `-reindex -recovery=2` pass the one time the
backend actually changes -- blobpacked keeps its own separate zip-manifest metadata that a
plain -reindex doesn't rebuild (see doc/server-config.md). That pass is safe to repeat (it
fully rebuilds from the real blobs/zip packs each time, not an incremental patch), so on any
boot where the config already says postgres but the "it finished and the server came up
healthy" marker is missing -- including a boot right after a kill mid-recovery -- this script
reissues the same flags rather than trusting a flag that was only ever set once.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

PERKEEPD = "perkeepd"  # on $PATH in both the generic Dockerfile and any derivative of it
CONFIG_DIR = os.environ["CAMLI_CONFIG_DIR"]
CONFIG_PATH = os.path.join(CONFIG_DIR, "server-config.json")
RECOVERY_MARKER = os.path.join(CONFIG_DIR, ".postgres_recovery_done")
HEALTH_URL = "http://127.0.0.1:3179/"
HEALTH_POLL_TIMEOUT_S = 180


def _load_config() -> dict | None:
    if not os.path.exists(CONFIG_PATH):
        return None
    with open(CONFIG_PATH) as f:
        return json.load(f)


def _save_config(conf: dict) -> None:
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(conf, f, indent=4)
    os.replace(tmp, CONFIG_PATH)  # atomic -- a kill mid-write can never leave a half-written config


def _patch_config(conf: dict) -> bool:
    """Applies env-driven settings on top of an already-bootstrapped config. Returns True if
    the postgres migration's one-time -reindex/-recovery pass is needed as a result."""
    changed = False
    needs_recovery = False

    web_user = os.environ.get("PERKEEP_WEB_USER")
    web_password = os.environ.get("PERKEEP_WEB_PASSWORD")
    if web_user and web_password:
        # PERKEEP_AUTH_MODE selects the auth.AuthMode these credentials are
        # parsed as -- "userpass" (HTTP Basic, the default) or "jwt" (login
        # screen + per-user API tokens; these become the bootstrap account's
        # username/password the first time, then are ignored -- see
        # pkg/accounts and doc/server-config.md).
        auth_mode = os.environ.get("PERKEEP_AUTH_MODE", "userpass")
        desired_auth = f"{auth_mode}:{web_user}:{web_password}"
        if conf.get("auth") != desired_auth:
            conf["auth"] = desired_auth
            changed = True

    base_url = os.environ.get("PERKEEP_BASE_URL")
    if base_url and conf.get("baseURL") != base_url:
        conf["baseURL"] = base_url
        changed = True

    if os.environ.get("PERKEEP_INDEX_BACKEND") == "postgres":
        pg_host = os.environ.get("PERKEEP_PG_HOST", "postgres")
        pg_user = os.environ.get("PERKEEP_PG_USER", "perkeep")
        pg_password = os.environ["PERKEEP_PG_PASSWORD"]
        desired_pg = f"{pg_user}@{pg_host}:{pg_password}"
        if conf.get("postgres") != desired_pg or "sqlite" in conf:
            conf.pop("sqlite", None)
            conf["postgres"] = desired_pg
            changed = True
            needs_recovery = True

    if changed:
        _save_config(conf)
    return needs_recovery


def _recovery_already_pending() -> bool:
    conf = _load_config()
    return bool(conf and "postgres" in conf and not os.path.exists(RECOVERY_MARKER))


def _wait_for_healthy_then_mark(will_mark: bool) -> None:
    """A 401 IS the server being up -- PERKEEP_WEB_USER/PASSWORD makes that the expected
    response for an unauthenticated root request. Treating it as "not up yet" (urllib raises
    HTTPError for any non-2xx) meant the marker never got written whenever auth was also
    configured, so every single restart would silently redo the full wipe-and-reindex pass
    forever instead of just once -- caught live, not theoretically, running this exact test."""
    deadline = time.monotonic() + HEALTH_POLL_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(HEALTH_URL, timeout=2)
            break
        except urllib.error.HTTPError:
            break  # got a real HTTP response (e.g. 401) -- the server is up
        except Exception:  # noqa: BLE001 -- connection refused, timeout, etc: not up yet
            pass
        time.sleep(1)
    else:
        print("perkeep-entrypoint: server never became reachable; leaving recovery marker "
              "unset so the next restart retries the recovery pass", flush=True)
        return
    if will_mark:
        open(RECOVERY_MARKER, "a").close()
        print("perkeep-entrypoint: server healthy, marked postgres recovery as done", flush=True)


def main() -> None:
    conf = _load_config()
    needs_recovery = False
    if conf is not None:
        needs_recovery = _patch_config(conf) or _recovery_already_pending()

    args = [PERKEEPD, "-openbrowser=false"]
    if needs_recovery:
        args += ["-reindex", "-recovery=2"]
        print(f"perkeep-entrypoint: launching with recovery pass: {args}", flush=True)

    child = subprocess.Popen(args)

    def _forward(signum, _frame):
        child.send_signal(signum)

    signal.signal(signal.SIGTERM, _forward)
    signal.signal(signal.SIGINT, _forward)

    if needs_recovery:
        threading.Thread(target=_wait_for_healthy_then_mark, args=(True,), daemon=True).start()

    sys.exit(child.wait())


if __name__ == "__main__":
    main()
