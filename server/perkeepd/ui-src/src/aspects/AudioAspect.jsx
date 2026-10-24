import { downloadUrl } from "../api/client.js";

// Port of audio_detail.js: title/artist from indexed media tags + a native player.
export default function AudioAspect({ disco, file, blob }) {
  const tags = blob.mediaTags || {};
  const filename = file.file?.fileName || "audio";
  return (
    <div className="p-3">
      <h5>{tags.title || filename}</h5>
      {tags.artist && <div className="text-muted mb-3">{tags.artist}</div>}
      <audio controls className="w-100" src={downloadUrl(disco, file.blobRef, filename, { inline: true })} />
    </div>
  );
}
