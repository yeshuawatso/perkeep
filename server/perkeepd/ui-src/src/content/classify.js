// Content-type classification for a search result item. Mirrors
// BLOB_ITEM_HANDLERS_'s match order in the old index.js:
// Fitness -> Demo -> Foursquare -> Twitter -> Mastodon -> Instapaper ->
// Image -> Audio -> Video -> Generic (first match wins).

const AUDIO_EXT = ["webm", "ogg", "mp3", "wav", "flac"];
const VIDEO_EXT = [
  "3gp", "aav", "asf", "avi", "dat", "m1v", "m2v", "m4v",
  "mov", "mp4", "mpe", "mpeg", "mpg", "ogg", "wmv",
];

function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

// Resolves a permanode's "actual content" the same way every content-type
// card does: camliContent (if it's a file/dir) else camliContentImage.
export function resolvedFile(meta, blob) {
  if (!blob) return null;
  if (blob.file || blob.dir) return blob;
  const attrs = blob.permanode?.attr;
  if (!attrs) return null;
  const contentRef = attrs.camliContent?.[0];
  if (contentRef && (meta[contentRef]?.file || meta[contentRef]?.dir)) return meta[contentRef];
  const imageRef = attrs.camliContentImage?.[0];
  if (imageRef && meta[imageRef]?.file) return meta[imageRef];
  return null;
}

export function classify(meta, ref) {
  const blob = meta[ref];
  if (!blob) return { type: "generic", ref, blob: null, file: null };

  const attrs = blob.permanode?.attr;
  const nodeType = attrs?.camliNodeType?.[0];

  if (nodeType === "fitnessActivity") return { type: "fitness", ref, blob, file: null };
  if (nodeType === "camlistore.org:demo") return { type: "demo", ref, blob, file: null };
  if (nodeType === "foursquare.com:checkin" && attrs?.startDate?.[0] && attrs?.foursquareVenuePermanode?.[0]) {
    return { type: "foursquare", ref, blob, file: null };
  }
  if ((nodeType === "twitter.com:tweet" || nodeType === "twitter.com:like") && attrs?.startDate?.[0] && attrs?.url?.[0]) {
    return { type: "twitter", ref, blob, file: null };
  }
  if (nodeType === "mastodon:status" && attrs?.startDate?.[0] && attrs?.content?.[0]) {
    return { type: "mastodon", ref, blob, file: null };
  }
  if (nodeType === "instapaper.com:highlight" && attrs?.dateCreated?.[0] && attrs?.content?.[0]) {
    return { type: "instapaper", ref, blob, file: null };
  }

  const file = resolvedFile(meta, blob);
  if (file?.image) return { type: "image", ref, blob, file };
  if (file?.file) {
    const e = ext(file.file.fileName);
    if (AUDIO_EXT.includes(e)) return { type: "audio", ref, blob, file };
    if (VIDEO_EXT.includes(e)) return { type: "video", ref, blob, file };
  }
  return { type: "generic", ref, blob, file };
}

export function titleOf(meta, ref) {
  const blob = meta[ref];
  const attrs = blob?.permanode?.attr;
  if (attrs?.title?.[0]) return attrs.title[0];
  const file = resolvedFile(meta, blob);
  if (file?.file?.fileName) return file.file.fileName;
  if (file?.dir?.fileName) return file.dir.fileName;
  return ref;
}
