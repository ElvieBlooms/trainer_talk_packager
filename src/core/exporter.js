// Plans and writes the output. Every output name comes from the schema's
// slot ids; every export is rebuilt from the original zips, so running it
// twice is always safe.
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { slotsFor } = require("./schema");
const { isWav, wavToOgg } = require("./audio");

const FOLDER_RE = /^[a-z0-9_]{1,40}$/;

function planExport({ schema, packType, folder, label, assignments, empty, clipsByKey, sources }) {
  const errors = [];
  const typeDef = schema.pack_types[packType];
  if (!typeDef) errors.push(`Unknown pack type "${packType}".`);
  if (!FOLDER_RE.test(folder || "")) errors.push("Folder name must be 1–40 lowercase letters, numbers, or underscores.");
  if (!label || !label.trim()) errors.push("Pack label is empty.");

  const slots = typeDef ? slotsFor(schema, packType) : [];
  const files = [];
  const confirmedEmpty = [];
  const unreviewed = [];
  for (const s of slots) {
    const a = assignments[s.id];
    const clip = a && clipsByKey[a.clipKey];
    if (clip) {
      const src = sources.find((x) => x.id === clip.sourceId);
      files.push({
        slot: s.id,
        outName: s.id + ".ogg", // from the schema, never from a clip or recipe
        clipKey: clip.key,
        sourceLabel: src ? src.label : clip.sourceId,
        sourceName: clip.name,
        crc: clip.crc,
        state: a.state,
      });
    } else if (empty.includes(s.id)) {
      confirmedEmpty.push(s.id);
    } else {
      unreviewed.push(s.id);
    }
  }
  const byClip = {};
  for (const f of files) (byClip[f.clipKey] = byClip[f.clipKey] || []).push(f.slot);
  const shared = Object.values(byClip).filter((list) => list.length > 1);
  const outNames = new Set(files.map((f) => f.outName));
  const converted = files.filter((f) => isWav(f.sourceName)).length;
  if (outNames.size !== files.length) errors.push("Two slots produced the same output name.");
  if (files.length === 0) errors.push("No slots are filled yet.");
  return {
    ok: errors.length === 0,
    errors,
    packType,
    folder,
    label: (label || "").trim(),
    packRoot: typeDef ? typeDef.root : "",
    files,
    confirmedEmpty,
    unreviewed,
    shared,
    converted, // WAV clips that are converted to Ogg Vorbis on export
    totalSlots: slots.length,
  };
}

function pairingsJson(plan, sources) {
  return JSON.stringify({
    generator: "Trainer Talk Packager",
    created: new Date().toISOString(),
    pack_type: plan.packType,
    label: plan.label,
    sources: sources.map((s) => ({ label: s.label, zip_md5: s.md5 })),
    slots: Object.fromEntries(plan.files.map((f) => [f.slot,
      { source: f.sourceLabel, file: f.sourceName, crc32: f.crc, state: f.state }])),
    confirmed_empty: plan.confirmedEmpty,
  }, null, 2) + "\n";
}

function uniquePath(dir, base) {
  let p = path.join(dir, base);
  let n = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, base.replace(/\.zip$/, `-${n}.zip`));
    n++;
  }
  return p;
}

// readClip(clipKey) -> Buffer. formats: { modZip: bool, packZip: bool }.
// WAV clips are converted to Ogg Vorbis, since the mod loads .ogg files;
// Ogg clips are copied byte for byte. A clip shared by several slots is
// converted once.
async function writeExport({ plan, sources, readClip, mod, outDir, formats, onProgress = () => {} }) {
  if (!plan.ok) throw new Error(plan.errors.join(" "));
  const converted = new Map();
  const packFiles = [];
  for (const f of plan.files) {
    let data = readClip(f.clipKey);
    if (isWav(f.sourceName)) {
      if (!converted.has(f.clipKey)) {
        onProgress(`converting ${f.sourceName} to Ogg Vorbis for ${f.outName}`);
        try { converted.set(f.clipKey, await wavToOgg(data)); } catch (e) { throw new Error(`Couldn't convert ${f.sourceName}: ${e.message}`); }
      }
      data = converted.get(f.clipKey);
    }
    packFiles.push({ name: f.outName, data });
  }
  packFiles.push({ name: "meta.json", data: Buffer.from(JSON.stringify({ label: plan.label }) + "\n") });
  packFiles.push({ name: "pairings.json", data: Buffer.from(pairingsJson(plan, sources)) });

  const written = [];
  if (formats.packZip) {
    const z = new AdmZip();
    for (const f of packFiles) z.addFile(`${plan.folder}/${f.name}`, f.data);
    z.addFile("INSTALL.txt", Buffer.from(
      `Copy the "${plan.folder}" folder into mods/${mod.manifest.id}/${plan.packRoot}/ in your gen1recomp save folder.\n` +
      `If a folder with that name is already there, replace it.\n`));
    const out = uniquePath(outDir, `${plan.folder}_${plan.packType}_pack.zip`);
    z.writeZip(out);
    written.push(out);
  }
  if (formats.modZip) {
    const src = new AdmZip(mod.path);
    const z = new AdmZip();
    const packPrefix = `${mod.root}${plan.packRoot}/${plan.folder}/`;
    for (const e of src.getEntries()) {
      if (e.entryName.startsWith(packPrefix)) continue; // replaced below
      if (e.isDirectory) continue;
      z.addFile(e.entryName, e.getData());
    }
    for (const f of packFiles) z.addFile(packPrefix + f.name, f.data);
    const ver = (mod.manifest.version || "").replace(/[^0-9a-z._-]/gi, "");
    const out = uniquePath(outDir, `${mod.manifest.id}${ver ? "_" + ver : ""}_with_${plan.folder}.zip`);
    z.writeZip(out);
    written.push(out);
  }
  return written;
}

module.exports = { planExport, writeExport, FOLDER_RE };
