// Turns the matcher's per-slot suggestions into picks. Rules from the
// manual process: a suggestion whose direction contradicts the slot is
// dropped; slots with the fewest usable candidates choose first, so an
// easy slot can't take the only clip a hard slot could use; a clip is
// used once.
// Normalizes the matcher's answers and sorts them into usable,
// wrong-direction, and unknown. Wrong-direction suggestions are kept for
// the person to see (flagged) but are never filled in automatically.
function normalizeClipId(raw) {
  const m = /c\s*-?\s*(\d+)/i.exec(String(raw || ""));
  return m ? `C${Number(m[1])}` : "";
}

function splitSuggestions(slot, cands, validClipIds) {
  const kept = [];
  const flagged = [];
  let unknown = 0;
  const seen = new Set();
  for (const raw of cands || []) {
    const clip = normalizeClipId(raw && raw.clip);
    if (!validClipIds.has(clip)) { unknown++; continue; }
    if (seen.has(clip)) continue;
    seen.add(clip);
    const c = { ...raw, clip };
    const ok = slot.direction === "none" || !c.direction || c.direction === slot.direction || c.direction === "none";
    if (ok) kept.push(c); else flagged.push({ ...c, flag: "direction" });
  }
  return { kept, flagged, unknown };
}

function filterSuggestions(slot, cands, validClipIds) {
  return splitSuggestions(slot, cands, validClipIds).kept;
}

function assignFromSuggestions(slots, suggestions, takenClipIds = new Set()) {
  const taken = new Set(takenClipIds);
  const order = [...slots].sort((a, b) =>
    (suggestions[a.id] || []).length - (suggestions[b.id] || []).length || (b.intensity || 0) - (a.intensity || 0));
  const picks = {};
  for (const slot of order) {
    const c = (suggestions[slot.id] || []).find((x) => !taken.has(x.clip));
    if (!c) continue;
    taken.add(c.clip);
    picks[slot.id] = c;
  }
  return picks;
}

module.exports = { filterSuggestions, splitSuggestions, normalizeClipId, assignFromSuggestions };
