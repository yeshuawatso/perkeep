import { useEffect, useState } from "react";

import { detailUrl, downloadUrl } from "../api/client.js";

// Full-bleed image view -- port of image_detail.js (minus the cross-fade
// animation, a cosmetic detail; prev/next and preloading are preserved).
export default function ImageAspect({ disco, file, prevRef, nextRef }) {
  const [loaded, setLoaded] = useState(false);
  const src = downloadUrl(disco, file.blobRef, file.file?.fileName, { inline: true });

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  return (
    <div className="d-flex align-items-center justify-content-center bg-dark" style={{ minHeight: "60vh" }}>
      {!loaded && <div className="spinner-border text-light" role="status" />}
      <img
        src={src}
        alt={file.file?.fileName}
        className="img-fluid"
        style={{ maxHeight: "80vh", display: loaded ? "block" : "none" }}
        onLoad={() => setLoaded(true)}
      />
      {prevRef && <link rel="prefetch" href={detailUrl(disco, prevRef)} />}
      {nextRef && <link rel="prefetch" href={detailUrl(disco, nextRef)} />}
    </div>
  );
}
