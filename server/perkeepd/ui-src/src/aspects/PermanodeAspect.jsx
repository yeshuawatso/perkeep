import { useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Table from "react-bootstrap/Table";

import { addAttribute, delAttribute } from "../api/client.js";

// "Current attributes" editable spreadsheet -- port of permanode_detail.js.
// One row per (name, value) pair (multi-valued attrs repeat the name), a
// pinned empty "add row" at top, sortable columns, per-row delete.
//
// Perkeep attributes are claims, not mutable cells -- there's no "rename
// this value" claim type, only add/del. So editing an existing row is
// really a combined delete-old + add-new, exposed as a single inline-edit
// action rather than making the user do those as two separate manual steps.
export default function PermanodeAspect({ permanode, attrs, onChanged }) {
  const [sort, setSort] = useState({ col: null, dir: 1 });
  const [newRow, setNewRow] = useState({ name: "", value: "" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // { key, name, value, origName, origValue }
  // Touch-primary devices get single-tap-to-edit (per-row double-click is an
  // awkward gesture on touch, and tends to fight the browser's own
  // double-tap-to-zoom); mouse/trackpad stays double-click so a single tap
  // doesn't open editing while just selecting/scrolling.
  const [isTouch] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches,
  );

  const rows = useMemo(() => {
    const out = [];
    for (const [name, values] of Object.entries(attrs || {})) {
      for (const value of values) out.push({ name, value });
    }
    if (sort.col) {
      const allNumeric = out.every((r) => r[sort.col] !== "" && !Number.isNaN(Number(r[sort.col])));
      out.sort((a, b) => {
        const av = allNumeric ? Number(a[sort.col]) : a[sort.col];
        const bv = allNumeric ? Number(b[sort.col]) : b[sort.col];
        return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir;
      });
    }
    return out;
  }, [attrs, sort]);

  function toggleSort(col) {
    setSort((s) => (s.col === col ? { col, dir: -s.dir } : { col, dir: 1 }));
  }

  async function commitNewRow() {
    if (!newRow.name.trim() || !newRow.value.trim()) return;
    setSaving(true);
    try {
      await addAttribute(permanode, newRow.name.trim(), newRow.value.trim());
      setNewRow({ name: "", value: "" });
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(row) {
    setSaving(true);
    try {
      await delAttribute(permanode, row.name, row.value);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  function rowKey(row) {
    return `${row.name}:${row.value}`;
  }

  function startEdit(row) {
    setEditing({ key: rowKey(row), name: row.name, value: row.value, origName: row.name, origValue: row.value });
  }

  function cancelEdit() {
    setEditing(null);
  }

  async function confirmEdit() {
    if (!editing) return;
    const name = editing.name.trim();
    const value = editing.value.trim();
    if (!name || !value) return;
    if (name === editing.origName && value === editing.origValue) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await delAttribute(permanode, editing.origName, editing.origValue);
      await addAttribute(permanode, name, value);
      setEditing(null);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  function onEditKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }

  return (
    <div>
      {saving && <div className="text-muted small mb-2">{"Saving…"}</div>}
      <Table size="sm" bordered responsive>
        <thead>
          <tr>
            <th role="button" onClick={() => toggleSort("name")}>
              Name
            </th>
            <th role="button" onClick={() => toggleSort("value")}>
              Value
            </th>
            <th style={{ width: 32 }} />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <input
                className="form-control form-control-sm"
                value={newRow.name}
                onChange={(e) => setNewRow((r) => ({ ...r, name: e.target.value }))}
                onBlur={commitNewRow}
                placeholder="attribute"
              />
            </td>
            <td>
              <input
                className="form-control form-control-sm"
                value={newRow.value}
                onChange={(e) => setNewRow((r) => ({ ...r, value: e.target.value }))}
                onBlur={commitNewRow}
                placeholder="value"
              />
            </td>
            <td />
          </tr>
          {rows.map((row, i) => {
            const isEditing = editing?.key === rowKey(row);
            if (isEditing) {
              return (
                <tr key={`${rowKey(row)}:${i}`}>
                  <td>
                    <input
                      autoFocus
                      className="form-control form-control-sm"
                      value={editing.name}
                      onChange={(e) => setEditing((s) => ({ ...s, name: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      disabled={saving}
                    />
                  </td>
                  <td>
                    <input
                      className="form-control form-control-sm"
                      value={editing.value}
                      onChange={(e) => setEditing((s) => ({ ...s, value: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      disabled={saving}
                    />
                  </td>
                  <td className="text-nowrap">
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 text-success me-2"
                      title="Save"
                      disabled={saving || !editing.name.trim() || !editing.value.trim()}
                      onClick={confirmEdit}
                    >
                      <i className="bi bi-check-lg" />
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 text-secondary"
                      title="Cancel"
                      disabled={saving}
                      onClick={cancelEdit}
                    >
                      <i className="bi bi-x-lg" />
                    </Button>
                  </td>
                </tr>
              );
            }
            const editTrigger = isTouch ? { onClick: () => startEdit(row) } : { onDoubleClick: () => startEdit(row) };
            return (
              <tr key={`${rowKey(row)}:${i}`}>
                <td role="button" {...editTrigger}>
                  {row.name}
                </td>
                <td className="text-break" role="button" {...editTrigger}>
                  {row.value}
                </td>
                <td>
                  <Button variant="link" size="sm" className="p-0 text-danger" onClick={() => deleteRow(row)}>
                    <i className="bi bi-x-lg" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
