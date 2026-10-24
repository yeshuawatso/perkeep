import { downloadUrl } from "../api/client.js";

// Port of browser_view_detail.js: PDF/plain-text files embedded in an iframe.
export default function DocumentAspect({ disco, file }) {
  const src = downloadUrl(disco, file.blobRef, file.file?.fileName, { inline: true });
  return (
    <iframe
      title={file.file?.fileName || "document"}
      src={src}
      className="w-100 border-0"
      style={{ height: "80vh" }}
    />
  );
}
