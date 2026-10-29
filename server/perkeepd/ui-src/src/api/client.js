// Perkeep API client. One-to-one replacement for the old UI's
// cam.ServerConnection (server_connection.js) -- every call here maps to the
// exact same unchanged backend route that file used; see
// perkeep-ui-spec.md for the full contract this was built against.

let discoveryPromise = null;

export function joinUrl(root, suffix) {
  const base = new URL(root, window.location.href);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(String(suffix).replace(/^\//, ""), base).toString();
}

// --- auth token (JWT) -----------------------------------------------------
// The SPA authenticates with a bearer JWT obtained from /auth/login (see
// hooks/useAuth.js), not HTTP Basic auth, so there's no browser-native
// credential cache to piggyback on. Every fetch() below goes through
// apiFetch(), which attaches the header and watches for 401s; every directly
// loaded resource URL (img/video/a src -- no custom headers possible there)
// carries the token as an "access_token" query param instead, via
// withAccessToken() -- the same query-string escape hatch
// useSearchSession.js already needs for the search WebSocket, applied
// uniformly to thumbnails/downloads/tree/qr as well.
let authToken = null;
let unauthorizedHandler = null;

export function setAuthToken(token) {
  authToken = token;
}

export function getAuthToken() {
  return authToken;
}

// Called by useAuth.js once, with its own logout+redirect-to-/login.
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

function authHeader() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function withAccessToken(url) {
  if (!authToken) return url;
  const u = new URL(url, window.location.href);
  u.searchParams.set("access_token", authToken);
  return u.toString();
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...authHeader(), ...(opts.headers || {}) } });
  if (res.status === 401) unauthorizedHandler?.();
  return res;
}

async function toJsonOrThrow(res, what) {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

// Strips toJsonOrThrow's "<what> failed: <status> " wrapper so callers can
// show the server's actual message (e.g. a password-policy description,
// or "incorrect password") instead of the generic wrapped form. Returns ""
// when there's nothing usable to extract, so callers fall back to their
// own generic copy.
export function serverErrorMessage(err) {
  const m = /failed: \d+\s*(.*)$/s.exec(String(err?.message ?? err ?? ""));
  return m ? m[1].trim() : "";
}

async function fetchDiscovery() {
  // Mirrors index.html's own `<script src="?camli.mode=config">` bootstrap --
  // any GET under the UI prefix with this Accept header hits wantsDiscovery()
  // in pkg/server/ui.go before any other routing, regardless of path.
  const res = await apiFetch(".", { headers: { Accept: "text/x-camli-configuration" } });
  return toJsonOrThrow(res, "discovery");
}

export function getDiscovery() {
  if (!discoveryPromise) discoveryPromise = fetchDiscovery();
  return discoveryPromise;
}

// --- hashing / blobrefs --------------------------------------------------
// New client-generated blobs (signed permanodes/claims, static-sets) are
// named "sha1-<hex>" here. SHA-224, Perkeep's newer default for *indexing*,
// has no native WebCrypto implementation, and blob storage is scheme-agnostic
// per blob, so an sha1- blob is accepted alongside sha224- ones from other
// sources without issue.
//
// crypto.subtle (WebCrypto) is used when available since it hashes off the
// main thread, but it's only defined in a secure context (https:, or
// http://localhost) -- Perkeep is routinely self-hosted on a plain-HTTP LAN
// address, where crypto.subtle is simply undefined. sha1HexPureJs is the
// fallback for that case (verified byte-for-byte against Node's crypto for
// buffers from 0 bytes to several MB, including every block-boundary edge
// case) so hashing -- and therefore every signed upload -- keeps working
// regardless of how the server is reached.
function sha1HexPureJs(bytes) {
  const data = new Uint8Array(bytes);
  const len = data.length;
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  const rotl = (n, b) => (n << b) | (n >>> (32 - b));

  function processBlock(view, offset) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const fullBlocks = Math.floor(len / 64);
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < fullBlocks; i++) processBlock(dataView, i * 64);

  // Final partial block + 0x80 + zero padding + 8-byte big-endian bit length,
  // spilling into a second 64-byte block when there isn't room for both the
  // 0x80 marker and the length in what's left of the current one.
  const remaining = len - fullBlocks * 64;
  const tailLen = remaining + 9 <= 64 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(data.subarray(fullBlocks * 64), 0);
  tail[remaining] = 0x80;
  const bitLenHigh = Math.floor((len * 8) / 0x100000000);
  const bitLenLow = (len * 8) >>> 0;
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(tailLen - 4, bitLenLow, false);
  tailView.setUint32(tailLen - 8, bitLenHigh, false);
  for (let off = 0; off < tailLen; off += 64) processBlock(tailView, off);

  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

async function sha1Ref(bytes) {
  if (window.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `sha1-${hex}`;
  }
  return `sha1-${sha1HexPureJs(bytes)}`;
}

function nowClaimDate() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- signing / raw blob upload --------------------------------------------

// Perkeep's convention is that a stored schema blob's clear text leads with
// camliVersion; constructing the object with it spread first guarantees that
// key ordering survives JSON.stringify (insertion order, for string keys).
async function signObject(obj) {
  const disco = await getDiscovery();
  // Verified live: the sign handler does NOT inject this itself -- it 400s
  // with 'json lacks "camliSigner" key with public key blobref' unless the
  // caller already put it there. The old UI's server_connection.js comment
  // describing it as "injected by sign_" meant client-side, not server-side.
  const clearText = JSON.stringify(
    { camliVersion: 1, camliSigner: disco.signing.publicKeyBlobRef, ...obj },
    null,
    2,
  ) + "\n";
  const res = await apiFetch(disco.signing.signHandler, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "json=" + encodeURIComponent(clearText),
  });
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);
  return res.text();
}

export async function verifySigned(signedText) {
  const disco = await getDiscovery();
  const res = await apiFetch(disco.signing.verifyHandler, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "sjson=" + encodeURIComponent(signedText),
  });
  return toJsonOrThrow(res, "verify");
}

async function uploadBlobText(text) {
  const disco = await getDiscovery();
  const ref = await sha1Ref(new TextEncoder().encode(text));
  const form = new FormData();
  form.append(ref, new Blob([text], { type: "application/json" }), ref);
  const res = await apiFetch(joinUrl(disco.blobRoot, "camli/upload"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`blob upload failed: ${res.status}`);
  return ref;
}

export async function getBlobContents(blobref) {
  const disco = await getDiscovery();
  const res = await apiFetch(joinUrl(disco.blobRoot, `camli/${blobref}`));
  if (!res.ok) throw new Error(`fetch blob failed: ${res.status}`);
  return res.text();
}

// --- permanode / claim mutations ------------------------------------------

export async function createPermanode() {
  const signed = await signObject({ camliType: "permanode", random: String(Math.random()) });
  return uploadBlobText(signed);
}

async function mutateAttribute(claimType, permanode, attribute, value) {
  const signed = await signObject({
    camliType: "claim",
    claimType,
    claimDate: nowClaimDate(),
    permaNode: permanode, // sic -- wire field is literally "permaNode", capital N
    attribute,
    value,
  });
  return uploadBlobText(signed);
}

export const setAttribute = (pm, attr, value) => mutateAttribute("set-attribute", pm, attr, value);
export const addAttribute = (pm, attr, value) => mutateAttribute("add-attribute", pm, attr, value);
// value === "" deletes every value of `attr`, per the old UI's convention.
export const delAttribute = (pm, attr, value = "") => mutateAttribute("del-attribute", pm, attr, value);

export async function deletePermanode(target) {
  const signed = await signObject({ camliType: "claim", claimType: "delete", claimDate: nowClaimDate(), target });
  return uploadBlobText(signed);
}

// expires (an ISO date string, or omitted/"" for no expiration) maps
// straight onto pkg/schema's Claim.Expires field (json:"expires") --
// Share.IsExpired() (already shipped, pkg/server/share.go's entitlement
// walk already enforces it) treats a zero/absent value as never-expiring.
export async function createShareClaim(target, { transitive = false, authType = "haveref", expires = "" } = {}) {
  const signed = await signObject({
    camliType: "claim",
    claimType: "share",
    authType,
    transitive,
    target,
    claimDate: nowClaimDate(),
    ...(expires ? { expires } : {}),
  });
  return uploadBlobText(signed);
}

export async function createStaticSet(members, mergeSets = []) {
  const signed = await signObject({ camliType: "static-set", members, mergeSets });
  return uploadBlobText(signed);
}

// --- search / describe ----------------------------------------------------

// The server's search-expression parser has no support at all for a literal
// JSON constraint embedded in the expression text -- any expression starting
// with "{" hits pkg/search/expr.go's noLiteralSupport error unconditionally,
// regardless of a "raw:" prefix (verified live; the parser has no such
// prefix). So a query string built from a JSON.stringify'd constraint (e.g.
// the Favorites menu item's URL) has to be turned back into a real object
// client-side before being handed to search()/useSearchSession -- this is
// that single parsing point. Also recognizes an explicit "raw:{...}" prefix
// (as advertised in the search-help dialog) for the same literal-constraint
// escape hatch, typed directly into the search box.
export function parseQueryInput(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^raw:/i.test(s)) s = s.slice(4).trim();
  if (s.startsWith("{")) {
    try {
      return JSON.parse(s);
    } catch {
      // Not actually valid JSON -- fall through and let it go to the server
      // as a literal expression, whose own error message is more useful
      // than silently swallowing a typo here.
    }
  }
  return raw;
}

// The describe-expansion recipe the old UI applies to every search result
// page (resolves camliContent/camliContentImage one level, plus foursquare
// venue->photo expansion) so content-type cards don't need a second round trip.
export const DEFAULT_DESCRIBE_RULES = {
  depth: 1,
  rules: [
    { attrs: ["camliContent", "camliContentImage"] },
    { ifCamliNodeType: "foursquare.com:checkin", attrs: ["foursquareVenuePermanode"] },
    { ifCamliNodeType: "foursquare.com:venue", attrs: ["camliPath:photos"], rules: [{ attrs: ["camliPath:*"] }] },
  ],
};

export async function search(exprOrConstraint, opts = {}) {
  const disco = await getDiscovery();
  const body = {
    ...(typeof exprOrConstraint === "string" ? { expression: exprOrConstraint } : { constraint: exprOrConstraint }),
    sort: opts.sort || "-created",
    limit: opts.limit ?? 50,
  };
  if (opts.describe !== false) body.describe = opts.describe || DEFAULT_DESCRIBE_RULES;
  if (opts.around) body.around = opts.around;
  if (opts.continue) body.continue = opts.continue;
  const res = await apiFetch(joinUrl(disco.searchRoot, "camli/search/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return toJsonOrThrow(res, "search");
}

export async function describe(blobrefs, extra = {}) {
  const disco = await getDiscovery();
  const res = await apiFetch(joinUrl(disco.searchRoot, "camli/search/describe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blobrefs, ...DEFAULT_DESCRIBE_RULES, ...extra }),
  });
  return toJsonOrThrow(res, "describe");
}

// Default "Browse" (no search query) constraint: a classic root-folder view --
// permanodes with no parent (not a member of any other set via camliMember or
// camliPath:*), so a set's members disappear from the root once they're added
// to it while the set itself (which has no parent of its own) stays visible.
// A set nested inside another set stays reachable by browsing into its
// parent, same as a subfolder wouldn't show at a filesystem's root either.
// The "parent"/default-EdgeType shape here is exactly what childrenof:/
// parentof: already compile to server-side (pkg/search/predicate.go), just
// inverted with a "not" logical constraint.
// account/apitoken permanodes (see hooks/useAuth.js, pages/AccountPage.jsx)
// are server-internal bookkeeping, not library content -- they have no
// parent either, so without this exclusion they'd otherwise float straight
// into the root browse view next to the user's own files.
function excludeNodeType(nodeType) {
  return { logical: { op: "not", a: { permanode: { attr: "camliNodeType", value: nodeType } } } };
}

// The camliNodeType marker on the small bookkeeping permanode
// createShareClaim's callers create alongside a real share claim (Phase
// 5's "My Shares" tab, see listMyShares/revokeShare below) -- same kind
// of server-internal record as "account"/"apitoken" above.
export const SHARE_RECORD_NODE_TYPE = "shareRecord";

export const ROOT_BROWSE_CONSTRAINT = {
  logical: {
    op: "and",
    a: { camliType: "permanode" },
    b: {
      logical: {
        op: "and",
        a: {
          logical: {
            op: "not",
            a: { permanode: { relation: { relation: "parent", any: { anything: true } } } },
          },
        },
        b: {
          logical: {
            op: "and",
            a: excludeNodeType("account"),
            b: {
              logical: {
                op: "and",
                a: excludeNodeType("apitoken"),
                // shareRecord permanodes (Phase 5's "My Shares" bookkeeping,
                // see createShareClaim's callers) are the same kind of
                // server-internal record as account/apitoken above -- never
                // meant to show up as a library item in the root view.
                b: excludeNodeType(SHARE_RECORD_NODE_TYPE),
              },
            },
          },
        },
      },
    },
  },
};

// The old UI's "Search roots" (renamed "Favorites" in 2016, renamed again to
// "FUSE" here since that's what it actually is) menu item: permanodes with a
// camliRoot attribute, i.e. ones named as a `pk-mount` FUSE roots-directory
// entry. numValue here means "has at least one value for this attribute"
// (internal/searchtypes/query.go), not a numeric-value check -- the
// constraint itself is correct, it's just that nothing in a normal
// browser-only Perkeep install ever sets camliRoot, so this is always empty
// unless the server has been FUSE-mounted at least once. SearchPage uses the
// exact serialized form of this to recognize the query and show setup
// instructions instead of a generic empty state.
export const FUSE_ROOTS_CONSTRAINT = { permanode: { attr: "camliRoot", numValue: { min: 1 } } };
export const FUSE_ROOTS_QUERY_PARAM = JSON.stringify(FUSE_ROOTS_CONSTRAINT);

// The marker attribute that makes a permanode usable as a set container
// regardless of whether it has any members yet (a brand-new set, or an
// existing object just "Converted to Set" -- see PermanodeAspect/
// SelectionActions). See content/classify.js's isSet() for the full check,
// which also recognizes older camliMember-only permanodes that predate this.
export const COLLECTION_NODE_TYPE = "collection";

// The 5 most-recently-created sets, or sets whose title matches `query` --
// backs the "Add to Set" picker's default list / live search.
export async function searchSets(query, { limit = 5 } = {}) {
  const base = {
    logical: {
      op: "and",
      a: { camliType: "permanode" },
      b: { permanode: { attr: "camliNodeType", value: COLLECTION_NODE_TYPE } },
    },
  };
  const constraint = query
    ? {
        logical: {
          op: "and",
          a: base,
          b: { permanode: { attr: "title", valueMatches: { contains: query, caseInsensitive: true } } },
        },
      }
    : base;
  const result = await search(constraint, { sort: "-created", limit, describe: false });
  return result.blobs || [];
}

export async function getPermanodeWithContent(contentRef) {
  const result = await search({ permanode: { attr: "camliContent", value: contentRef } }, { limit: 1 });
  return result.blobs?.[0]?.blob || null;
}

export async function isCamliMember(child, parent) {
  const result = await search(
    {
      logical: {
        op: "and",
        a: { permanode: { attr: "camliMember", valueInSet: { blobRefPrefix: child } } },
        b: { blobRefPrefix: parent },
      },
    },
    { limit: 1, describe: false },
  );
  return (result.blobs || []).length > 0;
}

async function searchGet(searchRoot, path, params) {
  const url = new URL(joinUrl(searchRoot, path));
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await apiFetch(url.toString());
  return toJsonOrThrow(res, path);
}

export async function getExif(fileRef) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/exif", { blobref: fileRef });
}

export async function getClaims(permanode, attrFilter) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/claims", { permanode, attrFilter });
}

export async function getRecent(n = 50, before) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/recent", { n, before });
}

export async function getPermanodesWithAttr(attr, value, { signer, fuzzy, max } = {}) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/permanodeattr", { attr, value, signer, fuzzy, max });
}

export async function filesForWholeDigests(wholeRefs) {
  const disco = await getDiscovery();
  const url = new URL(joinUrl(disco.searchRoot, "camli/search/files"));
  wholeRefs.forEach((r) => url.searchParams.append("wholedigest", r));
  const res = await apiFetch(url.toString());
  return toJsonOrThrow(res, "files");
}

export async function signerAttrValue(signer, attr, value) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/signerattrvalue", { signer, attr, value });
}

export async function signerPaths(signer, target) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/signerpaths", { signer, target });
}

export async function edgesTo(blobref) {
  const disco = await getDiscovery();
  return searchGet(disco.searchRoot, "camli/search/edgesto", { blobref });
}

// --- URL builders (thumbnail/download/tree/qr/share) -----------------------

const THUMB_HEIGHT_BUCKETS = [64, 128, 256, 375, 500, 750, 1000, 1500, 2000];
export function bucketHeight(h) {
  return THUMB_HEIGHT_BUCKETS.find((b) => h <= b) ?? THUMB_HEIGHT_BUCKETS[THUMB_HEIGHT_BUCKETS.length - 1];
}

export function thumbnailUrl(disco, blobref, filename, { mh, mw, tv } = {}) {
  const u = new URL(joinUrl(disco.uiRoot, `thumbnail/${blobref}/${encodeURIComponent(filename || "f")}`));
  if (mh) u.searchParams.set("mh", String(mh));
  if (mw) u.searchParams.set("mw", String(mw));
  if (tv) u.searchParams.set("tv", String(tv));
  return withAccessToken(u.toString());
}

export function downloadUrl(disco, blobref, filename, { inline } = {}) {
  const u = new URL(joinUrl(disco.downloadHelper, `${blobref}/${encodeURIComponent(filename || "f")}`));
  if (inline) u.searchParams.set("inline", "1");
  return withAccessToken(u.toString());
}

export function treeUrl(disco, blobref) {
  return withAccessToken(joinUrl(disco.directoryHelper, blobref));
}

export async function getFileTree(disco, blobref) {
  const res = await apiFetch(treeUrl(disco, blobref));
  return toJsonOrThrow(res, "tree");
}

export function qrUrl(disco, targetUrl) {
  const u = new URL(joinUrl(disco.uiRoot, "qr/"));
  u.searchParams.set("url", targetUrl);
  return withAccessToken(u.toString());
}

export function detailUrl(disco, blobref) {
  // The SPA's detail route is "detail/:blobref" (see App.jsx) -- not a bare
  // "<uiRoot>/<blobref>", which has no matching route and renders blank.
  return joinUrl(disco.uiRoot, `detail/${blobref}`);
}

// --- import share ------------------------------------------------------

export async function importShare(shareUrl) {
  const disco = await getDiscovery();
  const res = await apiFetch(joinUrl(disco.uiRoot, "importshare"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "shareurl=" + encodeURIComponent(shareUrl),
  });
  return toJsonOrThrow(res, "importshare");
}

export async function importShareStatus() {
  const disco = await getDiscovery();
  const res = await apiFetch(joinUrl(disco.uiRoot, "importshare"));
  return toJsonOrThrow(res, "importshare status");
}

// --- server status (header error badge / About dialog) -------------------

export async function getServerStatus() {
  const disco = await getDiscovery();
  const res = await apiFetch(joinUrl(disco.statusRoot, "status.json"));
  return toJsonOrThrow(res, "status");
}

// --- upload pipeline -------------------------------------------------------
// Mirrors uploadFile/camliUploadFileHelper_ in server_connection.js: hash
// client-side, dedup-check via /search/files + a HEAD verify, and only
// actually POST bytes if no verified existing file blob was found.

function xhrPost(url, form, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status === 401) unauthorizedHandler?.();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
}

export async function uploadFile(file, { onProgress } = {}) {
  const disco = await getDiscovery();
  const wholeRef = await sha1Ref(await file.arrayBuffer());

  const existing = await filesForWholeDigests([wholeRef]);
  for (const candidate of existing.files?.[wholeRef] || []) {
    const verifyUrl = joinUrl(disco.downloadHelper, `${candidate}/?verifycontents=${wholeRef}`);
    try {
      const res = await apiFetch(verifyUrl, { method: "HEAD" });
      if (res.headers.get("X-Camli-Contents") === wholeRef) {
        onProgress?.(1);
        return candidate;
      }
    } catch {
      // fall through to a real upload
    }
  }

  const form = new FormData();
  form.append("modtime", new Date(file.lastModified || Date.now()).toISOString());
  form.append("ui-upload-file-helper-form", file, file.name);
  const data = await xhrPost(disco.uploadHelper, form, authHeader(), onProgress);
  return data.got?.[0]?.fileref || null;
}

// --- account / login -------------------------------------------------------
// Fixed server-root routes (not under uiRoot/searchRoot -- see
// pkg/serverinit's /auth/* registration), independent of discovery.

function authUrl(path) {
  return new URL(path, window.location.origin).toString();
}

// Unauthenticated (see pkg/accounts' handlePasswordPolicy) -- null pattern
// means "no policy configured", not "empty password allowed".
export async function getPasswordPolicy() {
  const res = await fetch(authUrl("/auth/password-policy"));
  return toJsonOrThrow(res, "password policy");
}

export async function login(username, password) {
  const res = await fetch(authUrl("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return toJsonOrThrow(res, "login");
}

// --- self-signup / email verification / forgot-password -------------------
// All unauthenticated (pre-session), like login/getPasswordPolicy above --
// see pkg/accounts' handler.go (Phase 4) for why each needs to be.

export async function getSignupEnabled() {
  const res = await fetch(authUrl("/auth/signup-enabled"));
  return toJsonOrThrow(res, "signup status");
}

export async function signup(username, email, password) {
  const res = await fetch(authUrl("/auth/signup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  return toJsonOrThrow(res, "sign up");
}

export async function verifyEmail(token) {
  const res = await fetch(authUrl("/auth/verify-email"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return toJsonOrThrow(res, "verify email");
}

// Authenticated -- resends to the caller's own stored address (see
// pkg/accounts' ResendVerification).
export async function resendVerification() {
  const res = await apiFetch(authUrl("/auth/resend-verification"), { method: "POST" });
  return toJsonOrThrow(res, "resend verification email");
}

// Always resolves the same way whether or not emailOrUsername matches a
// real account -- see pkg/accounts' RequestPasswordReset on why (account
// enumeration).
export async function forgotPassword(emailOrUsername) {
  const res = await fetch(authUrl("/auth/forgot-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailOrUsername }),
  });
  return toJsonOrThrow(res, "request password reset");
}

export async function resetPasswordWithToken(token, newPassword) {
  const res = await fetch(authUrl("/auth/reset-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  return toJsonOrThrow(res, "reset password");
}

export async function getAccount() {
  const res = await apiFetch(authUrl("/auth/account"));
  return toJsonOrThrow(res, "account");
}

export async function changeUsername(newUsername, currentPassword) {
  const res = await apiFetch(authUrl("/auth/account/username"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newUsername, currentPassword }),
  });
  return toJsonOrThrow(res, "change username");
}

export async function changePassword(currentPassword, newPassword) {
  const res = await apiFetch(authUrl("/auth/account/password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return toJsonOrThrow(res, "change password");
}

export async function createApiToken(label) {
  const res = await apiFetch(authUrl("/auth/account/tokens"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  return toJsonOrThrow(res, "create API token");
}

export async function revokeApiToken(id) {
  const res = await apiFetch(authUrl(`/auth/account/tokens/${encodeURIComponent(id)}`), { method: "DELETE" });
  if (!res.ok) throw new Error(`revoke API token failed: ${res.status}`);
}

// --- admin (Users tab) ------------------------------------------------------
// Server-side enforces every rule here (who's an admin, the last-admin
// invariant, no self-grant) -- these calls just surface whatever it
// decides, including its error, to the Admin page.

export async function getUsers() {
  const res = await apiFetch(authUrl("/auth/admin/users"));
  return toJsonOrThrow(res, "list users");
}

// email is optional -- see pkg/accounts' CreateUser (Phase 4): giving one
// lets this account use forgot-password later, but an admin-created
// account is always immediately verified either way.
export async function createUser(username, password, email = "") {
  const res = await apiFetch(authUrl("/auth/admin/users"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, email }),
  });
  return toJsonOrThrow(res, "create user");
}

export async function deleteUser(username) {
  const res = await apiFetch(authUrl(`/auth/admin/users/${encodeURIComponent(username)}`), { method: "DELETE" });
  if (!res.ok) throw new Error(`delete user failed: ${res.status} ${await res.text().catch(() => "")}`);
}

export async function grantAdmin(username) {
  const res = await apiFetch(authUrl(`/auth/admin/users/${encodeURIComponent(username)}/grant-admin`), {
    method: "POST",
  });
  if (!res.ok) throw new Error(`grant admin failed: ${res.status} ${await res.text().catch(() => "")}`);
}

export async function revokeAdmin(username) {
  const res = await apiFetch(authUrl(`/auth/admin/users/${encodeURIComponent(username)}/revoke-admin`), {
    method: "POST",
  });
  if (!res.ok) throw new Error(`revoke admin failed: ${res.status} ${await res.text().catch(() => "")}`);
}

export async function impersonate(username) {
  const res = await apiFetch(authUrl(`/auth/admin/users/${encodeURIComponent(username)}/impersonate`), {
    method: "POST",
  });
  return toJsonOrThrow(res, "impersonate");
}

// Admin-only, no current password required -- see pkg/accounts'
// ResetPassword (never usable on your own account; the Admin page hides
// the button for that row too).
export async function resetPassword(username, newPassword) {
  const res = await apiFetch(authUrl(`/auth/admin/users/${encodeURIComponent(username)}/reset-password`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword }),
  });
  if (!res.ok) throw new Error(`reset password failed: ${res.status} ${await res.text().catch(() => "")}`);
}

// --- admin (Notifications tab) ----------------------------------------------
// The server never sends the real SMTP password back (see
// pkg/accounts/notifications.go) -- getSMTPConfig's result has
// hasPassword instead. setSMTPConfig's password field can be left "" to
// keep whatever's already stored.

export async function getSMTPConfig() {
  const res = await apiFetch(authUrl("/auth/admin/notifications/smtp-config"));
  return toJsonOrThrow(res, "get SMTP config");
}

export async function setSMTPConfig(config) {
  const res = await apiFetch(authUrl("/auth/admin/notifications/smtp-config"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`save SMTP config failed: ${res.status} ${await res.text().catch(() => "")}`);
}

export async function sendTestEmail(to) {
  const res = await apiFetch(authUrl("/auth/admin/notifications/test-send"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  if (!res.ok) throw new Error(`test email failed: ${res.status} ${await res.text().catch(() => "")}`);
}

// --- sharing (Phase 5) ------------------------------------------------------
// Creating/listing/revoking a share is entirely client-driven, the same
// primitives as everything else above (createPermanode/setAttribute/
// addAttribute/deletePermanode, createShareClaim) -- see
// docs/multi-tenant-roadmap.md's Phase 5 section for why that's safe now
// that the server enforces ownership on share/delete claims regardless of
// who issues the HTTP call. Only sendShareNotice below needs a server
// route, since only the server can send email.

// Every other account's username, for the "local users" picker --
// authenticated (any logged-in user, not just an admin; see
// pkg/accounts' handleDirectory).
export async function getUserDirectory() {
  const res = await apiFetch(authUrl("/auth/directory"));
  const { usernames } = await toJsonOrThrow(res, "user directory");
  return usernames || [];
}

// Live-validates a typed "@username" handle for "registered users" mode,
// without creating any side effect or ever learning the matched
// account's email (see pkg/accounts' ResolveRecipient).
export async function resolveRecipient(handle) {
  const res = await apiFetch(authUrl("/auth/shares/resolve-recipient"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  return toJsonOrThrow(res, "resolve recipient");
}

// Sends the "someone shared this with you" email for a share the caller
// already created client-side (createPermanode + createShareClaim,
// below). target/shareClaimRef are raw blobrefs, not a pre-built URL --
// the server builds the actual absolute link itself (see pkg/accounts'
// shareURL) rather than trusting a client-supplied string in an outgoing
// email.
export async function sendShareNotice({ target, shareClaimRef, isFile, itemTitle, mode, recipient, expiresIn }) {
  const res = await apiFetch(authUrl("/auth/shares/notify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, shareClaimRef, isFile, itemTitle, mode, recipient, expiresIn }),
  });
  return toJsonOrThrow(res, "send share notice");
}

// Creates the small bookkeeping permanode (camliNodeType=shareRecord)
// that backs the "My Shares" tab -- a share claim alone has no owner-
// queryable link back to "who shared this and why," so this is what
// listMyShares below actually lists. Gets Phase 2's normal ownership
// stamp automatically, the same as any other permanode createPermanode
// makes, so it's already scoped to the caller with no new server code.
export async function createShareRecord({ shareClaimRef, target, mode, recipient = "", itemTitle = "", expires = "" }) {
  const pn = await createPermanode();
  for (const [attr, value] of [
    ["camliNodeType", SHARE_RECORD_NODE_TYPE],
    ["shareClaim", shareClaimRef],
    ["target", target],
    ["mode", mode],
    ["recipient", recipient],
    ["itemTitle", itemTitle],
    ["expires", expires],
    ["createdAt", nowClaimDate()],
  ]) {
    await addAttribute(pn, attr, value);
  }
  return pn;
}

// Lists the caller's own shareRecord permanodes. Deliberately goes through
// the generic search() / camli/search/query, not getPermanodesWithAttr
// (camli/search/permanodeattr) -- that legacy endpoint's SearchPermanodesWithAttr
// 500s on any attribute outside IsIndexedAttribute's hard-coded whitelist
// (pkg/index/index.go: "camliRoot", "camliImportRoot", "tag", "title"), which
// "camliNodeType" isn't in. search()'s generic query path has no such
// whitelist and is already owner-filtered server-side the same way
// (pkg/search/query.go's Query ANDs in an owner constraint for every
// non-admin caller), so this is the same searchSets()/ROOT_BROWSE_CONSTRAINT
// pattern already used elsewhere in this file for camliNodeType lookups.
export async function listMyShares() {
  const result = await search(
    { permanode: { attr: "camliNodeType", value: SHARE_RECORD_NODE_TYPE } },
    { limit: -1 },
  );
  const meta = result.description?.meta || {};
  return (result.blobs || []).map(({ blob }) => {
    const attrs = meta[blob]?.permanode?.attr || {};
    const get = (k) => attrs[k]?.[0] || "";
    return {
      shareRecord: blob,
      shareClaim: get("shareClaim"),
      target: get("target"),
      mode: get("mode"),
      recipient: get("recipient"),
      itemTitle: get("itemTitle"),
      expires: get("expires"),
      createdAt: get("createdAt"),
    };
  });
}

// Revokes a share: a delete claim against the real share claim (now
// correctly authorized -- the caller owns the share claim's Target, see
// pkg/accounts' OwnerOf claim-chain extension) plus one against the
// bookkeeping record itself, so it drops out of listMyShares immediately
// (IsDeleted-aware, like every other deleted permanode -- no separate
// "revoked" flag needed).
export async function revokeShare({ shareRecord, shareClaim }) {
  await deletePermanode(shareClaim);
  await deletePermanode(shareRecord);
}

// After uploadFile resolves a file-schema blobref, wire it up exactly like
// index.js's handleFilesUpload_: find-or-create a permanode with this
// content, and (if uploading into a container) add it as a camliMember.
export async function attachUploadedFile(fileRef, { parentPermanode } = {}) {
  let permanode = await getPermanodeWithContent(fileRef);
  if (!permanode) {
    permanode = await createPermanode();
    await setAttribute(permanode, "camliContent", fileRef);
  }
  if (parentPermanode) {
    const isMember = await isCamliMember(permanode, parentPermanode);
    if (!isMember) await addAttribute(parentPermanode, "camliMember", permanode);
  }
  return permanode;
}
