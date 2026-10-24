import { useEffect, useState } from "react";

import { getDiscovery } from "../api/client.js";

export function useDiscovery() {
  const [disco, setDisco] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getDiscovery()
      .then(setDisco)
      .catch((e) => setError(String(e)));
  }, []);

  return { disco, error };
}
