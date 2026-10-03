// Loads and validates a mod's slot schema, and turns it into a flat slot
// list for either pack type. Output filenames are ALWAYS built from these
// slot ids, never from user or recipe strings.
const fs = require("fs");
const path = require("path");

const SUPPORTED_SCHEMA_VERSIONS = [1];
const ID = /^[a-z0-9_]+$/;
const DIRECTIONS = ["by_you", "to_you", "none"];
const TONES = ["positive", "negative", "neutral"];

function fail(msg) {
  throw new Error("schema.json: " + msg);
}

function validateSchema(raw) {
  if (!raw || typeof raw !== "object") fail("not a JSON object");
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw.schema_version)) {
    fail(`schema_version ${raw.schema_version} is not supported (this app reads ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`);
  }
  if (typeof raw.mod_id !== "string" || !ID.test(raw.mod_id)) fail("mod_id is missing or invalid");
  const types = raw.pack_types || {};
  const trainer = types.trainer;
  if (trainer) {
    if (!Array.isArray(trainer.slots) || trainer.slots.length === 0) fail("trainer.slots must be a non-empty list");
    const seen = new Set();
    for (const s of trainer.slots) {
      if (!s || !ID.test(s.id || "")) fail(`trainer slot id "${s && s.id}" is invalid`);
      if (seen.has(s.id)) fail(`duplicate trainer slot "${s.id}"`);
      seen.add(s.id);
      if (s.direction && !DIRECTIONS.includes(s.direction)) fail(`slot ${s.id}: unknown direction ${s.direction}`);
      if (s.tone && !TONES.includes(s.tone)) fail(`slot ${s.id}: unknown tone ${s.tone}`);
    }
  }
  const milestone = types.milestone;
  if (milestone) {
    if (!Array.isArray(milestone.speakers) || milestone.speakers.some((x) => !ID.test(x))) {
      fail("milestone.speakers must be a list of lowercase ids");
    }
    if (!Array.isArray(milestone.parts) || milestone.parts.some((p) => !p || !ID.test(p.id || ""))) {
      fail("milestone.parts must be a list of { id } objects");
    }
  }
  if (!trainer && !milestone) fail("no pack_types defined");
  for (const t of [trainer, milestone]) {
    if (t && (typeof t.root !== "string" || !/^[a-z0-9_]+(\/[a-z0-9_]+)*$/.test(t.root))) {
      fail("pack type root must be a relative path like assets/characters");
    }
  }
  return raw;
}

// Flat slot list for a pack type. Milestone slots are <speaker>_<part>.
function slotsFor(schema, packType) {
  const t = schema.pack_types[packType];
  if (!t) return [];
  if (packType === "trainer") {
    return t.slots.map((s) => ({ ...s, file: s.id + ".ogg" }));
  }
  const out = [];
  for (const speaker of t.speakers) {
    for (const part of t.parts) {
      const id = `${speaker}_${part.id}`;
      out.push({
        id, file: id + ".ogg", group: speaker, speaker, part: part.id,
        moment: part.moment, direction: part.direction || "none",
        tone: part.tone || "neutral", intensity: part.intensity || 1,
      });
    }
  }
  return out;
}

function bundledSchemaPath(modId) {
  if (!ID.test(modId || "")) return null;
  const p = path.join(__dirname, "..", "..", "schemas", `${modId}.schema.json`);
  return fs.existsSync(p) ? p : null;
}

function loadBundledSchema(modId) {
  const p = bundledSchemaPath(modId);
  if (!p) return null;
  return validateSchema(JSON.parse(fs.readFileSync(p, "utf8")));
}

module.exports = { validateSchema, slotsFor, loadBundledSchema, ID };
