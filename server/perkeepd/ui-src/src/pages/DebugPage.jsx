import { useState } from "react";

import { verifySigned } from "../api/client.js";
import { useAppContext } from "../context/AppContext.jsx";

// Low-traffic by design (per the old debug.html/sigdebug.js) -- a reference
// view of discovery plus a manual verify-signed-JSON tool. Not linked from
// any visible nav besides the sidebar; see perkeep-ui-spec.md §5.
export default function DebugPage() {
  const { disco } = useAppContext();
  const [signed, setSigned] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);

  async function doVerify() {
    try {
      setVerifyResult(await verifySigned(signed));
    } catch (e) {
      setVerifyResult({ error: String(e) });
    }
  }

  return (
    <div className="p-3">
      <h5>Debug</h5>
      <h6 className="mt-4">Discovery</h6>
      <pre className="bg-body-tertiary p-2 small" style={{ maxHeight: 300, overflow: "auto" }}>
        {JSON.stringify(disco, null, 2)}
      </pre>
      <h6 className="mt-4">Verify a signed blob</h6>
      <textarea
        className="form-control mb-2"
        rows={6}
        value={signed}
        onChange={(e) => setSigned(e.target.value)}
        placeholder="Paste a signed JSON blob"
      />
      <button type="button" className="btn btn-secondary mb-2" onClick={doVerify} disabled={!signed}>
        Verify
      </button>
      {verifyResult && (
        <pre className="bg-body-tertiary p-2 small">{JSON.stringify(verifyResult, null, 2)}</pre>
      )}
    </div>
  );
}
