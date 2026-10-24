import { useEffect, useState } from "react";

import { qrUrl } from "../api/client.js";
import { useAppContext } from "../context/AppContext.jsx";

// Port of mobile_setup.js: a pure client-side form that encodes its values
// into a camli://settings/ deep link as a QR code for Perkeep's Android app
// to scan. No mutating API calls -- all provisioning happens in the app.
export default function MobileSetupPage() {
  const { disco } = useAppContext();
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [autoUpload, setAutoUpload] = useState(false);
  const [maxCacheSize, setMaxCacheSize] = useState(256);

  useEffect(() => {
    if (!disco) return;
    const u = new URL(".", window.location.href);
    u.search = "";
    u.hash = "";
    setServer(u.toString());
    setUsername(disco.userName || "");
  }, [disco]);

  if (!disco) return null;

  const settingsUrl = `camli://settings/?username=${encodeURIComponent(username)}&server=${encodeURIComponent(server)}&autoUpload=${autoUpload}&maxCacheSize=${encodeURIComponent(maxCacheSize)}&certFingerprint=`;

  return (
    <div className="p-3" style={{ maxWidth: 480 }}>
      <h5>Mobile setup</h5>
      <p className="text-muted small">Scan this QR code from Perkeep's Android app to configure it.</p>
      <div className="mb-3">
        <label className="form-label">Perkeep server URL</label>
        <input className="form-control" value={server} onChange={(e) => setServer(e.target.value)} />
      </div>
      <div className="mb-3">
        <label className="form-label">Username</label>
        <input className="form-control" value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="form-check mb-3">
        <input
          type="checkbox"
          className="form-check-input"
          id="auto-upload"
          checked={autoUpload}
          onChange={(e) => setAutoUpload(e.target.checked)}
        />
        <label className="form-check-label" htmlFor="auto-upload">
          Auto-upload
        </label>
      </div>
      <div className="mb-3">
        <label className="form-label">Maximum cache size (MB)</label>
        <input
          type="number"
          className="form-control"
          value={maxCacheSize}
          onChange={(e) => setMaxCacheSize(e.target.value)}
        />
      </div>
      <img src={qrUrl(disco, settingsUrl)} alt="Mobile setup QR code" className="border" />
    </div>
  );
}
