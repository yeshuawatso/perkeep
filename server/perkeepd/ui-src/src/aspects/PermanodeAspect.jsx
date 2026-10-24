import { useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Table from "react-bootstrap/Table";

import { addAttribute, delAttribute } from "../api/client.js";

// "Current attributes" editable spreadsheet -- port of permanode_detail.js.
// One row per (name, value) pair (multi-valued attrs repeat the name), a
// pinned empty "add row" at top, sortable columns, per-row delete.
export default function PermanodeAspect({ permanode, attrs, onChanged }) {
  const [sort, setSort] = useState({ col: null, dir: 1 });
  const [newRow, setNewRow] = useState({ name: "", value: "" });
  const [saving, setSaving] = useState(false);

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
          {rows.map((row, i) => (
            <tr key={`${row.name}:${row.value}:${i}`}>
              <td>{row.name}</td>
              <td className="text-break">{row.value}</td>
              <td>
                <Button variant="link" size="sm" className="p-0 text-danger" onClick={() => deleteRow(row)}>
                  <i className="bi bi-x-lg" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
