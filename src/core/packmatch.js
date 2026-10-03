// Matches the files of an existing pack (named by slot) to clips in
// freshly downloaded zips, so a recipe can be rebuilt from a pack.
//
// 1. Exact: same CRC32 and size. Packs exported by copying clips
//    untouched match this way, with certainty and no analysis.
// 2. Similar: for files that were re-encoded or trimmed, compare
//    transcripts and lengths. These come back as stretches to review.

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function textSimilarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x && !y) return 0; // two non-speech clips tell us nothing
  const longest = Math.max(x.length, y.length) || 1;
  return 1 - levenshtein(x, y) / longest;
}

function lengthSimilarity(a, b) {
  if (!a || !b) return 0.5; // unknown: neutral
  return Math.max(0, 1 - Math.abs(a - b) / Math.max(a, b));
}

// ref: [{ key, slot, crc, size }] from the pack.
// clips: [{ key, crc, size }] from the loaded zips.
// transcripts / seconds: { key: value } for both sets (optional).
// allowed (optional): { slot: [clipKey, ...] } limits which clips a slot
// may match by transcript, e.g. a leader's own zip in a milestone pack.
function matchPack(ref, clips, { transcripts = {}, seconds = {}, threshold = 0.6, allowed = null } = {}) {
  const byCrc = new Map();
  for (const c of clips) {
    const k = `${c.crc}|${c.size}`;
    if (!byCrc.has(k)) byCrc.set(k, c);
  }
  const exact = {};
  const rest = [];
  for (const r of ref) {
    const hit = byCrc.get(`${r.crc}|${r.size}`);
    if (hit) exact[r.slot] = { clipKey: hit.key };
    else rest.push(r);
  }

  // Similar: score every pair, then assign best-first so each clip is
  // used once among the similar matches.
  const exactKeys = new Set(Object.values(exact).map((x) => x.clipKey));
  const pairs = [];
  for (const r of rest) {
    if (transcripts[r.key] === undefined) continue;
    const ok = allowed && allowed[r.slot] ? new Set(allowed[r.slot]) : null;
    for (const c of clips) {
      if (exactKeys.has(c.key) || transcripts[c.key] === undefined) continue;
      if (ok && !ok.has(c.key)) continue;
      const t = textSimilarity(transcripts[r.key], transcripts[c.key]);
      if (t <= 0) continue;
      const score = 0.75 * t + 0.25 * lengthSimilarity(seconds[r.key], seconds[c.key]);
      if (score >= threshold) pairs.push({ slot: r.slot, clipKey: c.key, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const similar = {};
  const takenClips = new Set();
  for (const p of pairs) {
    if (similar[p.slot] || takenClips.has(p.clipKey)) continue;
    similar[p.slot] = { clipKey: p.clipKey, score: Math.round(p.score * 100) / 100 };
    takenClips.add(p.clipKey);
  }
  const unmatched = rest.filter((r) => !similar[r.slot]).map((r) => r.slot);
  const needsTranscripts = rest.filter((r) => transcripts[r.key] === undefined).map((r) => r.key);
  return { exact, similar, unmatched, needsTranscripts };
}

module.exports = { matchPack, textSimilarity, normalize };
