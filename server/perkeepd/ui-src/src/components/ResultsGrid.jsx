import { useEffect, useRef } from "react";

import ItemCard from "../content/ItemCard.jsx";

// The grid of result cards. Real virtualization (only mounting on-screen
// items, as blob_item_container_react.js did) is skipped here -- modern
// browsers handle a few hundred DOM nodes of lazy-loaded <img>s fine -- but
// the user-facing behaviors (selection incl. shift-click range select,
// infinite scroll near the bottom) are preserved.
export default function ResultsGrid({
  disco,
  refs,
  meta,
  selected,
  onToggleSelect,
  onOpen,
  onDroppedMembers,
  loading,
  done,
  onLoadMore,
  emptyMessage,
}) {
  const sentinelRef = useRef(null);

  useEffect(() => {
    if (!sentinelRef.current || done) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) onLoadMore();
      },
      { rootMargin: "400px" },
    );
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [done, onLoadMore]);

  if (!loading && refs.length === 0) {
    // A caller-supplied node (its own icon/text/action) is rendered as-is;
    // a plain string (or nothing) keeps the generic sad-face fallback.
    if (emptyMessage && typeof emptyMessage !== "string") return emptyMessage;
    return (
      <div className="text-center text-muted py-5">
        <i className="bi bi-emoji-frown fs-1 d-block mb-2" />
        {emptyMessage || "No results found."}
      </div>
    );
  }

  // The full current selection travels with a dragged card so dropping any
  // one of several selected cards onto a set adds all of them, not just the
  // one the drag happened to start on (see ItemCard's onDragStart).
  const selectedRefs = selected ? [...selected] : [];

  return (
    <div>
      <div className="item-grid">
        {refs.map((ref, i) => (
          <ItemCard
            key={ref}
            disco={disco}
            meta={meta}
            blobRef={ref}
            selected={!!selected?.has(ref)}
            selectable={!!onToggleSelect}
            onToggleSelect={(r, e) => onToggleSelect(r, i, e)}
            onOpen={onOpen}
            selectedRefs={selectedRefs}
            onDroppedMembers={onDroppedMembers}
          />
        ))}
      </div>
      {!done && <div ref={sentinelRef} className="text-center text-muted py-3">{loading ? "Loading…" : ""}</div>}
    </div>
  );
}
