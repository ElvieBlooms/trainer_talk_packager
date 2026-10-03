// Recipes: small JSON files mapping clips to slots, with no audio.
// Shared recipes are untrusted input. Every slot name is checked against
// the schema, and nothing in a recipe is ever used to build a file path.
const { slotsFor } = require("./schema");

const RECIPE_FORMAT = 1;
const MAX_RECIPE_BYTES = 512 * 1024;
const MAX_TEXT = 600;
const FILE_RE = /^[^/\\:*?"<>|\x00-\x1f]{1,200}\.(ogg|wav)$/i;
const CRC_RE = /^[0-9a-f]{8}$/;
const STATES = ["confident", "stretch"];

// A zip's file name, as the person downloaded it: never a path or a link.
function safeFileName(v) {
  if (typeof v !== "string") return undefined;
  const base = v.split(/[\\/]/).pop().slice(0, 120);
  return base && !/:\/\//.test(v) && /\.zip$/i.test(base) ? base : undefined;
}

function str(v, max = MAX_TEXT) {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

// Returns { recipe, warnings } or throws with a readable message.
function validateRecipe(raw, schema, bytes) {
  if (bytes !== undefined && bytes > MAX_RECIPE_BYTES) {
    throw new Error(`Recipe is too large (${Math.round(bytes / 1024)} KB; limit is 512 KB).`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Recipe is not a JSON object.");
  if (raw.recipe_format !== RECIPE_FORMAT) {
    throw new Error(`Recipe format ${raw.recipe_format} isn't supported (this app reads format ${RECIPE_FORMAT}).`);
  }
  if (raw.mod_id !== schema.mod_id) throw new Error(`Recipe is for "${raw.mod_id}", not "${schema.mod_id}".`);
  if (!schema.pack_types[raw.pack_type]) throw new Error(`Recipe pack type "${raw.pack_type}" isn't in this mod's schema.`);

  const warnings = [];
  const known = new Set(slotsFor(schema, raw.pack_type).map((s) => s.id));
  const slots = {};
  const rawSlots = raw.slots && typeof raw.slots === "object" ? raw.slots : {};
  for (const [slot, e] of Object.entries(rawSlots)) {
    if (!known.has(slot)) { warnings.push(`Skipped unknown slot "${String(slot).slice(0, 40)}".`); continue; }
    if (!e || typeof e !== "object") { warnings.push(`Skipped malformed entry for ${slot}.`); continue; }
    if (typeof e.file !== "string" || !FILE_RE.test(e.file)) {
      warnings.push(`Skipped ${slot}: file must be a plain .ogg or .wav filename.`); continue;
    }
    const crc = typeof e.crc32 === "string" ? e.crc32.toLowerCase() : undefined;
    if (crc !== undefined && !CRC_RE.test(crc)) { warnings.push(`Skipped ${slot}: crc32 is malformed.`); continue; }
    slots[slot] = {
      file: e.file,
      crc32: crc,
      source: str(e.source, 60),
      state: STATES.includes(e.state) ? e.state : "stretch",
      note: str(e.note),
      transcript: str(e.transcript),
    };
  }
  const confirmedEmpty = (Array.isArray(raw.confirmed_empty) ? raw.confirmed_empty : [])
    .filter((s) => known.has(s) && !slots[s]);
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 50).map((s) => ({
    id: str(s && s.id, 60) || "",
    label: str(s && s.label, 80) || "",
    file_name: safeFileName(s && s.file_name),
    zip_md5: typeof (s && s.zip_md5) === "string" && /^[0-9a-f]{32}$/.test(s.zip_md5) ? s.zip_md5 : undefined,
    clip_count: Number(s && s.clip_count) || undefined,
  }));
  const missingSlots = [...known].filter((s) => !slots[s] && !confirmedEmpty.includes(s));
  if (missingSlots.length && raw.schema_version !== undefined && raw.schema_version < schema.schema_version) {
    warnings.push(`Recipe predates this schema; ${missingSlots.length} slot(s) will start open.`);
  }

  return {
    recipe: {
      recipe_format: RECIPE_FORMAT,
      mod_id: raw.mod_id,
      schema_version: Number(raw.schema_version) || undefined,
      pack_type: raw.pack_type,
      label: str(raw.label, 40) || "",
      folder: str(raw.folder, 40) || "",
      author: str(raw.author, 60) || "unknown",
      created: str(raw.created, 30) || "",
      sources,
      slots,
      confirmed_empty: confirmedEmpty,
    },
    warnings,
  };
}

// Matches a validated recipe against loaded clips. A recipe entry with a
// crc32 needs filename + CRC to match (verified). An entry without one
// matches on filename alone (unverified), and only if exactly one loaded
// clip has that name.
function matchRecipe(recipe, clips) {
  const byNameCrc = new Map();
  const byName = new Map();
  for (const c of clips) {
    byNameCrc.set(c.name + "|" + c.crc, c);
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const assignments = {};
  const transcripts = {};
  const missing = [];
  let matched = 0;
  for (const [slot, e] of Object.entries(recipe.slots)) {
    let clip = null;
    let verified = false;
    if (e.crc32) {
      clip = byNameCrc.get(e.file + "|" + e.crc32) || null;
      verified = !!clip;
    } else {
      const list = byName.get(e.file) || [];
      if (list.length === 1) clip = list[0];
    }
    if (!clip) {
      missing.push({ slot, file: e.file, source: e.source || "", reason: (byName.get(e.file) || []).length ? "different audio" : "not loaded" });
      continue;
    }
    matched++;
    assignments[slot] = { clipKey: clip.key, state: e.state, note: e.note || "", via: "recipe", verified };
    if (e.transcript) transcripts[clip.key] = e.transcript;
  }
  const total = Object.keys(recipe.slots).length;
  return { assignments, transcripts, missing, matched, total, confirmedEmpty: [...recipe.confirmed_empty] };
}

// Builds a shareable recipe from the current review state.
function buildRecipe({ schema, packType, label, folder, author, sources, clipsByKey, assignments, empty, transcripts, includeTranscripts }) {
  const slots = {};
  for (const s of slotsFor(schema, packType)) {
    const a = assignments[s.id];
    if (!a) continue;
    const clip = clipsByKey[a.clipKey];
    if (!clip) continue;
    const src = sources.find((x) => x.id === clip.sourceId);
    const entry = { source: src ? src.recipeId : clip.sourceId, file: clip.name, crc32: clip.crc, state: a.state };
    if (a.note) entry.note = a.note.slice(0, MAX_TEXT);
    if (includeTranscripts && transcripts[a.clipKey]) entry.transcript = transcripts[a.clipKey].slice(0, MAX_TEXT);
    slots[s.id] = entry;
  }
  return {
    recipe_format: RECIPE_FORMAT,
    mod_id: schema.mod_id,
    schema_version: schema.schema_version,
    pack_type: packType,
    label,
    folder,
    author: author || "unknown",
    created: new Date().toISOString().slice(0, 10),
    sources: sources.map((s) => ({
      id: s.recipeId, label: s.label, file_name: safeFileName(s.fileName), zip_md5: s.md5, clip_count: s.clipCount,
      picks: Object.values(slots).filter((e) => e.source === s.recipeId).length,
    })).filter((s) => s.picks > 0),
    slots,
    confirmed_empty: slotsFor(schema, packType).map((s) => s.id).filter((id) => empty.includes(id) && !slots[id]),
  };
}

// Which zips a recipe's picks come from, most-used first.
function neededZips(recipe) {
  const bySource = new Map();
  for (const s of recipe.sources || []) bySource.set(s.id, { ...s, slots: [] });
  for (const [slot, e] of Object.entries(recipe.slots || {})) {
    const id = e.source || "";
    if (!bySource.has(id)) bySource.set(id, { id, label: id || "Unnamed zip", slots: [] });
    bySource.get(id).slots.push(slot);
  }
  return [...bySource.values()].filter((s) => s.slots.length)
    .map((s) => ({ id: s.id, label: s.label, file_name: s.file_name, zip_md5: s.zip_md5, clip_count: s.clip_count, picks: s.slots.length, slots: s.slots }))
    .sort((a, b) => b.picks - a.picks);
}

function neededZipsText(recipe) {
  const zips = neededZips(recipe);
  const name = recipe.label || recipe.folder || "this pack";
  const lines = [
    `# Zips needed for ${name}`,
    "",
    `Recipe by ${recipe.author || "unknown"}${recipe.created ? `, ${recipe.created}` : ""}. Pack type: ${recipe.pack_type}.`,
    `${Object.keys(recipe.slots || {}).length} slots filled from ${zips.length} ${zips.length === 1 ? "zip" : "zips"}${(recipe.confirmed_empty || []).length ? `; ${recipe.confirmed_empty.length} left silent` : ""}.`,
    "",
  ];
  for (const z of zips) {
    lines.push(`## ${z.label}`);
    if (z.file_name) lines.push(`- File: ${z.file_name}`);
    if (z.clip_count) lines.push(`- Clips in the zip: ${z.clip_count}`);
    lines.push(`- Used for ${z.picks} ${z.picks === 1 ? "slot" : "slots"}: ${z.slots.join(", ")}`);
    if (z.zip_md5) lines.push(`- MD5: ${z.zip_md5} (a repackaged copy still works; clips are matched one by one)`);
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = { validateRecipe, matchRecipe, buildRecipe, neededZips, neededZipsText, MAX_RECIPE_BYTES };
