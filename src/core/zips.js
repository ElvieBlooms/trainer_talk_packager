// Reads the two kinds of zip the app works with: the Trainer Talk mod zip
// and the user's audio zips. Nothing is extracted to disk; clip bytes are
// read from the zip on demand.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const AdmZip = require("adm-zip");
const { validateSchema, loadBundledSchema } = require("./schema");

const AUDIO_EXT = /\.(ogg|wav)$/i;

function isJunk(name) {
  return name.startsWith("__MACOSX/") || name.split("/").some((p) => p.startsWith("."));
}

function crcHex(entry) {
  return ((entry.header.crc >>> 0).toString(16)).padStart(8, "0");
}

function md5File(file) {
  return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

// ---- mod zip ----------------------------------------------------------

// Finds the mod root (the folder holding manifest.json), its manifest, its
// schema (the mod's own schema.json, or the bundled one for that mod id),
// and the voice packs it already contains.
function readModZip(file) {
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  const manifests = entries.filter((e) => !e.isDirectory && !isJunk(e.entryName)
    && path.posix.basename(e.entryName) === "manifest.json");
  if (manifests.length === 0) {
    throw new Error("This zip has no manifest.json. Choose the Trainer Talk mod zip.");
  }
  let chosen = null;
  for (const m of manifests.sort((a, b) => a.entryName.length - b.entryName.length)) {
    try {
      const manifest = JSON.parse(zip.readAsText(m));
      if (manifest && typeof manifest.id === "string") {
        chosen = { entry: m, manifest };
        if (manifest.id === "trainer_talk") break;
      }
    } catch (_) { /* not a mod manifest */ }
  }
  if (!chosen) throw new Error("No readable mod manifest.json was found in this zip.");

  const dir = path.posix.dirname(chosen.entry.entryName);
  const root = dir === "." ? "" : dir + "/";
  const manifest = chosen.manifest;

  let schema = null;
  let schemaSource = "mod";
  const schemaEntry = zip.getEntry(root + "schema.json");
  if (schemaEntry) {
    schema = validateSchema(JSON.parse(zip.readAsText(schemaEntry)));
    if (schema.mod_id !== manifest.id) {
      throw new Error(`schema.json is for "${schema.mod_id}" but the mod is "${manifest.id}".`);
    }
  } else {
    schema = loadBundledSchema(manifest.id);
    schemaSource = "bundled";
    if (!schema) {
      throw new Error(`"${manifest.name || manifest.id}" has no schema.json, and this app has no built-in slot list for it.`);
    }
  }

  const existingPacks = {};
  for (const [type, def] of Object.entries(schema.pack_types)) {
    const prefix = root + def.root + "/";
    const names = new Set();
    for (const e of entries) {
      if (e.entryName.startsWith(prefix)) {
        const rest = e.entryName.slice(prefix.length);
        const folder = rest.split("/")[0];
        if (folder && rest.includes("/")) names.add(folder);
      }
    }
    existingPacks[type] = [...names].sort();
  }

  return {
    path: file,
    root,
    manifest: { id: manifest.id, name: manifest.name || manifest.id, version: manifest.version || "" },
    schema,
    schemaSource,
    existingPacks,
  };
}

// ---- audio zips --------------------------------------------------------

// Lists the .ogg and .wav clips in an audio zip. A clip's identity is
// source + entry name, and its CRC32 (from the zip directory) is what
// recipes match on, since it survives re-zipping unchanged audio.
function readAudioZip(file, sourceId) {
  const zip = new AdmZip(file);
  const clips = [];
  let skipped = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory || isJunk(e.entryName)) continue;
    if (!AUDIO_EXT.test(e.entryName)) { skipped++; continue; }
    clips.push({
      key: `${sourceId}::${e.entryName}`,
      sourceId,
      entryName: e.entryName,
      name: path.posix.basename(e.entryName),
      crc: crcHex(e),
      size: e.header.size,
    });
  }
  clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { zip, clips, skipped, md5: md5File(file) };
}

module.exports = { readModZip, readAudioZip, crcHex, isJunk };
