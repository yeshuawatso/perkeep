import { useState } from "react";
import Badge from "react-bootstrap/Badge";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";

import { addAttribute, delAttribute } from "../api/client.js";

// Port of tags_control.js (cam.AddTagsInput + cam.EditTagsControl): bulk
// add/remove the "tag" attribute across every selected permanode.
export default function TagsControl({ selectedRefs, meta, onChanged }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const tagCounts = new Map();
  for (const ref of selectedRefs) {
    const tags = meta[ref]?.permanode?.attr?.tag || [];
    for (const t of new Set(tags)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }

  async function applyToAll(tag) {
    setSaving(true);
    try {
      await Promise.all(
        selectedRefs
          .filter((ref) => !(meta[ref]?.permanode?.attr?.tag || []).includes(tag))
          .map((ref) => addAttribute(ref, "tag", tag)),
      );
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function removeTag(tag) {
    setSaving(true);
    try {
      await Promise.all(
        selectedRefs
          .filter((ref) => (meta[ref]?.permanode?.attr?.tag || []).includes(tag))
          .map((ref) => delAttribute(ref, "tag", tag)),
      );
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function addTags(e) {
    e.preventDefault();
    const tags = draft
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(
        selectedRefs.flatMap((ref) =>
          tags
            .filter((tag) => !(meta[ref]?.permanode?.attr?.tag || []).includes(tag))
            .map((tag) => addAttribute(ref, "tag", tag)),
        ),
      );
      setDraft("");
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-2 d-flex flex-wrap gap-1">
        {[...tagCounts.entries()].map(([tag, count]) => (
          <Badge key={tag} bg="secondary" className="d-flex align-items-center gap-1">
            {tag}
            {count < selectedRefs.length && (
              <Button
                variant="link"
                size="sm"
                className="p-0 text-white-50"
                title="Apply to all selected"
                onClick={() => applyToAll(tag)}
              >
                <i className="bi bi-arrow-repeat" />
              </Button>
            )}
            <Button variant="link" size="sm" className="p-0 text-white-50" onClick={() => removeTag(tag)}>
              <i className="bi bi-x" />
            </Button>
          </Badge>
        ))}
      </div>
      <Form onSubmit={addTags} className="d-flex gap-2">
        <Form.Control
          size="sm"
          placeholder="Add tags (comma separated)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
        />
        <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
          Add
        </Button>
      </Form>
    </div>
  );
}
