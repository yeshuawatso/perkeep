import { createContext, useContext } from "react";

// Shared handles every page needs: the discovery doc, and the global upload
// queue (so drag-and-drop/file-picker uploads work the same whether they
// happen on the home grid or inside a container's "Contents" view) --
// both are actually owned by AppLayout, which renders the one shared
// progress dialog, exactly like the old single-page app had exactly one
// upload dialog no matter where you triggered it from.
export const AppContext = createContext(null);

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext used outside AppContext.Provider");
  return ctx;
}
