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

function authHeader(disco) {
  if (!disco.authToken || disco.authToken === "OmitAuthToken") return {};
  return { Authorization: `Token ${disco.authToken}` };
}

async function toJsonOrThrow(res, what) {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

async function fetchDiscovery() {
  // Mirrors index.html's own `<script src="?camli.mode=config">` bootstrap --
  // any GET under the UI prefix with this Accept header hits wantsDiscovery()
  // in pkg/server/ui.go before any other routing, regardless of path.
  const res = await fetch(".", { headers: { Accept: "text/x-camli-configuration" } });
  return toJsonOrThrow(res, "discovery");
}

export function getDiscovery() {
  if (!discoveryPromise) discoveryPromise = fetchDiscovery();
  return discoveryPromise;
}

// --- hashing / blobrefs --------------------------------------------------
// New client-generated blobs (signed permanodes/claims, static-sets) are
// named "sha1-<hex>" here. SHA-1 is natively available via SubtleCrypto in
// every browser (SHA-224, Perkeep's newer default for *indexing*, is not --
// there's no native WebCrypto SHA-224), and blob storage is scheme-agnostic
// per blob, so an sha1- blob is accepted alongside sha224- ones from other
// sources without issue.
async function sha1Ref(bytes) {
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha1-${hex}`;
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
  const res = await fetch(disco.signing.signHandler, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...authHeader(disco) },
    body: "json=" + encodeURIComponent(clearText),
  });
  if (!res.ok) throw new Error(`sign failed: ${res.status}`);
  return res.text();
}

export async function verifySigned(signedText) {
  const disco = await getDiscovery();
  const res = await fetch(disco.signing.verifyHandler, {
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
  const res = await fetch(joinUrl(disco.blobRoot, "camli/upload"), {
    method: "POST",
    headers: authHeader(disco),
    body: form,
  });
  if (!res.ok) throw new Error(`blob upload failed: ${res.status}`);
  return ref;
}

export async function getBlobContents(blobref) {
  const disco = await getDiscovery();
  const res = await fetch(joinUrl(disco.blobRoot, `camli/${blobref}`));
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

export async function createShareClaim(target, { transitive = false, authType = "haveref" } = {}) {
  const signed = await signObject({
    camliType: "claim",
    claimType: "share",
    authType,
    transitive,
    target,
    claimDate: nowClaimDate(),
  });
  return uploadBlobText(signed);
}

export async function createStaticSet(members, mergeSets = []) {
  const signed = await signObject({ camliType: "static-set", members, mergeSets });
  return uploadBlobText(signed);
}

// --- search / describe ----------------------------------------------------

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
  const res = await fetch(joinUrl(disco.searchRoot, "camli/search/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return toJsonOrThrow(res, "search");
}

export async function describe(blobrefs, extra = {}) {
  const disco = await getDiscovery();
  const res = await fetch(joinUrl(disco.searchRoot, "camli/search/describe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blobrefs, ...DEFAULT_DESCRIBE_RULES, ...extra }),
  });
  return toJsonOrThrow(res, "describe");
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
  const res = await fetch(url.toString());
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
  const res = await fetch(url.toString());
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
  return u.toString();
}

export function downloadUrl(disco, blobref, filename, { inline } = {}) {
  const u = new URL(joinUrl(disco.downloadHelper, `${blobref}/${encodeURIComponent(filename || "f")}`));
  if (inline) u.searchParams.set("inline", "1");
  return u.toString();
}

export function treeUrl(disco, blobref) {
  return joinUrl(disco.directoryHelper, blobref);
}

export async function getFileTree(disco, blobref) {
  const res = await fetch(treeUrl(disco, blobref));
  return toJsonOrThrow(res, "tree");
}

export function qrUrl(disco, targetUrl) {
  const u = new URL(joinUrl(disco.uiRoot, "qr/"));
  u.searchParams.set("url", targetUrl);
  return u.toString();
}

export function detailUrl(disco, blobref) {
  return joinUrl(disco.uiRoot, blobref);
}

// --- import share ------------------------------------------------------

export async function importShare(shareUrl) {
  const disco = await getDiscovery();
  const res = await fetch(joinUrl(disco.uiRoot, "importshare"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "shareurl=" + encodeURIComponent(shareUrl),
  });
  return toJsonOrThrow(res, "importshare");
}

export async function importShareStatus() {
  const disco = await getDiscovery();
  const res = await fetch(joinUrl(disco.uiRoot, "importshare"));
  return toJsonOrThrow(res, "importshare status");
}

// --- server status (header error badge / About dialog) -------------------

export async function getServerStatus() {
  const disco = await getDiscovery();
  const res = await fetch(joinUrl(disco.statusRoot, "status.json"));
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
      const res = await fetch(verifyUrl, { method: "HEAD" });
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
  const data = await xhrPost(disco.uploadHelper, form, authHeader(disco), onProgress);
  return data.got?.[0]?.fileref || null;
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
