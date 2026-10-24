import { useCallback, useState } from "react";

import { attachUploadedFile, uploadFile } from "../api/client.js";

// Drives the upload/progress dialog's state. Mirrors index.js's
// handleFilesUpload_: hash+dedup+upload the raw file (client.js:uploadFile),
// then find-or-create a permanode for it and (if uploading into a
// container) wire it up as a camliMember -- see client.js:attachUploadedFile.
export function useUploadQueue() {
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");

  const uploadFiles = useCallback(async (files, { parentPermanode, onDone } = {}) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setActive(true);
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setStatus(`Uploaded ${file.name} (0%)`);
        setProgress(0);
        const fileRef = await uploadFile(file, {
          onProgress: (p) => {
            setProgress(p);
            setStatus(`Uploaded ${file.name} (${Math.round(p * 100)}%)`);
          },
        });
        if (fileRef) {
          const permanode = await attachUploadedFile(fileRef, { parentPermanode });
          onDone?.(permanode, file);
        }
      }
    } finally {
      setActive(false);
      setStatus("");
      setProgress(0);
    }
  }, []);

  return { active, progress, status, uploadFiles };
}
