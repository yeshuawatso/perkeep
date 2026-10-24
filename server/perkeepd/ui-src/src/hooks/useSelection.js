import { useCallback, useState } from "react";

// Click = toggle, shift-click = range-select from the last-touched index to
// this one (matching the old grid's selection model).
export function useSelection(refs) {
  const [selected, setSelected] = useState(new Set());
  const [lastIndex, setLastIndex] = useState(null);

  const toggle = useCallback(
    (ref, index, e) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (e?.shiftKey && lastIndex != null) {
          const start = Math.min(lastIndex, index);
          const end = Math.max(lastIndex, index);
          const shouldSelect = !next.has(ref);
          for (let i = start; i <= end; i++) {
            const r = refs[i];
            if (!r) continue;
            if (shouldSelect) next.add(r);
            else next.delete(r);
          }
        } else if (next.has(ref)) {
          next.delete(ref);
        } else {
          next.add(ref);
        }
        return next;
      });
      setLastIndex(index);
    },
    [refs, lastIndex],
  );

  const clear = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback((allRefs) => setSelected(new Set(allRefs)), []);

  return { selected, toggle, clear, selectAll, setSelected };
}
