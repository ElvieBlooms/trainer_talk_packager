const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { readModZip, readAudioZip } = require("../src/core/zips");
const { slotsFor, loadBundledSchema } = require("../src/core/schema");
const { validateRecipe, matchRecipe, buildRecipe, neededZips, neededZipsText } = require("../src/core/recipe");
const { planExport, writeExport } = require("../src/core/exporter");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-"));
const schema = loadBundledSchema("trainer_talk");

function makeModZip(file, { withSchema = false } = {}) {
  const z = new AdmZip();
  const root = "Trainer_Talk-main/";
  z.addFile(root + "manifest.json", Buffer.from(JSON.stringify({ id: "trainer_talk", name: "Trainer Talk", version: "0.5.3" })));
  z.addFile(root + "voice.lua", Buffer.from("-- code"));
  z.addFile(root + "assets/characters/ash/meta.json", Buffer.from('{"label":"ASH"}'));
  z.addFile(root + "assets/characters/ash/old_file.ogg", Buffer.from("OLD"));
  z.addFile(root + "assets/characters/kris/new_game.ogg", Buffer.from("KRIS"));
  z.addFile(root + "assets/milestones/leaders/brock_intro.ogg", Buffer.from("B"));
  if (withSchema) z.addFile(root + "schema.json", Buffer.from(JSON.stringify(schema)));
  z.writeZip(file);
}

function makeAudioZip(file, names, prefix = "") {
  const z = new AdmZip();
  for (const n of names) z.addFile(prefix + n, Buffer.from("audio:" + n));
  z.addFile(prefix + "readme.txt", Buffer.from("not audio"));
  z.addFile("__MACOSX/._junk.ogg", Buffer.from("junk"));
  z.writeZip(file);
}

const modPath = path.join(tmp, "mod.zip");
makeModZip(modPath);
const audioPath = path.join(tmp, "ash.zip");
makeAudioZip(audioPath, ["clip_0000_en.ogg", "clip_0001_en.ogg", "clip_0002_en.ogg"], "Ash/");

test("bundled schema has 48 trainer slots and milestone slots", () => {
  assert.strictEqual(slotsFor(schema, "trainer").length, 48);
  const m = slotsFor(schema, "milestone");
  assert.ok(m.find((s) => s.id === "brock_intro"));
  assert.ok(m.every((s) => s.file === s.id + ".ogg"));
});

test("mod zip: finds nested root, falls back to bundled schema, lists packs", () => {
  const mod = readModZip(modPath);
  assert.strictEqual(mod.root, "Trainer_Talk-main/");
  assert.strictEqual(mod.schemaSource, "bundled");
  assert.deepStrictEqual(mod.existingPacks.trainer, ["ash", "kris"]);
  assert.deepStrictEqual(mod.existingPacks.milestone, ["leaders"]);
  const withSchema = path.join(tmp, "mod2.zip");
  makeModZip(withSchema, { withSchema: true });
  assert.strictEqual(readModZip(withSchema).schemaSource, "mod");
});

test("audio zip: only .ogg clips, junk skipped, CRCs present", () => {
  const { clips, skipped } = readAudioZip(audioPath, "s1");
  assert.strictEqual(clips.length, 3);
  assert.strictEqual(skipped, 1);
  assert.ok(clips.every((c) => /^[0-9a-f]{8}$/.test(c.crc)));
  assert.strictEqual(clips[0].key, "s1::Ash/clip_0000_en.ogg");
  assert.strictEqual(clips[0].name, "clip_0000_en.ogg");
});

test("recipe validation drops unknown slots and unsafe filenames", () => {
  const { recipe, warnings } = validateRecipe({
    recipe_format: 1, mod_id: "trainer_talk", pack_type: "trainer",
    slots: {
      new_game: { file: "clip_0000_en.ogg", state: "confident" },
      "../../evil": { file: "clip_0001_en.ogg" },
      hit1: { file: "../../etc/passwd.ogg" },
      hit2: { file: "sub/clip.ogg" },
    },
    confirmed_empty: ["night2", "not_a_slot"],
  }, schema);
  assert.deepStrictEqual(Object.keys(recipe.slots), ["new_game"]);
  assert.deepStrictEqual(recipe.confirmed_empty, ["night2"]);
  assert.strictEqual(warnings.length, 3);
  assert.throws(() => validateRecipe({ recipe_format: 1, mod_id: "other", pack_type: "trainer" }, schema));
});

test("recipe matching: CRC-verified, filename-only, and mismatched", () => {
  const { clips } = readAudioZip(audioPath, "s1");
  const crc0 = clips[0].crc;
  const { recipe } = validateRecipe({
    recipe_format: 1, mod_id: "trainer_talk", pack_type: "trainer",
    slots: {
      new_game: { file: "clip_0000_en.ogg", crc32: crc0, state: "confident", transcript: "Hi!" },
      hit1: { file: "clip_0001_en.ogg", state: "stretch" },
      hit2: { file: "clip_0002_en.ogg", crc32: "deadbeef" },
      hit3: { file: "missing.ogg" },
    },
  }, schema);
  const m = matchRecipe(recipe, clips);
  assert.strictEqual(m.matched, 2);
  assert.strictEqual(m.assignments.new_game.verified, true);
  assert.strictEqual(m.assignments.hit1.verified, false);
  assert.strictEqual(m.transcripts[clips[0].key], "Hi!");
  assert.deepStrictEqual(m.missing.map((x) => [x.slot, x.reason]), [["hit2", "different audio"], ["hit3", "not loaded"]]);
});

test("bundled Ash recipe validates and covers all 48 slots", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "recipes", "trainer", "ash", "elvieblooms.json"), "utf8"));
  const { recipe, warnings } = validateRecipe(raw, schema);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(Object.keys(recipe.slots).length + recipe.confirmed_empty.length, 48);
});

test("export: names from schema, pack zip and mod zip with pack replaced", async () => {
  const mod = readModZip(modPath);
  const { zip, clips } = readAudioZip(audioPath, "s1");
  const sources = [{ id: "s1", label: "Base Ash", md5: "x" }];
  const byKey = Object.fromEntries(clips.map((c) => [c.key, c]));
  const assignments = {
    new_game: { clipKey: clips[0].key, state: "confident" },
    hit1: { clipKey: clips[1].key, state: "stretch" },
  };
  const plan = planExport({ schema, packType: "trainer", folder: "ash", label: "ASH", assignments,
    empty: ["night2"], clipsByKey: byKey, sources });
  assert.ok(plan.ok, plan.errors.join());
  assert.deepStrictEqual(plan.files.map((f) => f.outName), ["new_game.ogg", "hit1.ogg"]);
  assert.deepStrictEqual(plan.confirmedEmpty, ["night2"]);
  assert.strictEqual(plan.unreviewed.length, 45);

  const outDir = fs.mkdtempSync(path.join(tmp, "out-"));
  const readClip = (key) => zip.getEntry(key.split("::")[1]).getData();
  const written = await writeExport({ plan, sources, readClip, mod, outDir, formats: { packZip: true, modZip: true } });
  assert.strictEqual(written.length, 2);

  const pack = new AdmZip(written[0]);
  const packNames = pack.getEntries().map((e) => e.entryName).sort();
  assert.deepStrictEqual(packNames, ["INSTALL.txt", "ash/hit1.ogg", "ash/meta.json", "ash/new_game.ogg", "ash/pairings.json"]);
  assert.strictEqual(pack.readAsText("ash/new_game.ogg"), "audio:clip_0000_en.ogg");

  const full = new AdmZip(written[1]);
  const fullNames = full.getEntries().map((e) => e.entryName);
  assert.ok(!fullNames.includes("Trainer_Talk-main/assets/characters/ash/old_file.ogg"), "old pack files removed");
  assert.ok(fullNames.includes("Trainer_Talk-main/assets/characters/ash/hit1.ogg"));
  assert.ok(fullNames.includes("Trainer_Talk-main/assets/characters/kris/new_game.ogg"), "other packs kept");
  assert.ok(fullNames.includes("Trainer_Talk-main/voice.lua"));

  // Exporting again never overwrites: it writes a numbered copy.
  const again = await writeExport({ plan, sources, readClip, mod, outDir, formats: { packZip: true, modZip: false } });
  assert.notStrictEqual(again[0], written[0]);
});

test("export refuses bad folder names", () => {
  const plan = planExport({ schema, packType: "trainer", folder: "../ash", label: "ASH",
    assignments: {}, empty: [], clipsByKey: {}, sources: [] });
  assert.strictEqual(plan.ok, false);
});

test("built recipe round-trips through validation and matching", () => {
  const { clips } = readAudioZip(audioPath, "s1");
  const byKey = Object.fromEntries(clips.map((c) => [c.key, c]));
  const built = buildRecipe({
    schema, packType: "trainer", label: "ASH", folder: "ash", author: "tester",
    sources: [{ id: "s1", recipeId: "source1", label: "Base", md5: "m", clipCount: 3 }],
    clipsByKey: byKey,
    assignments: { new_game: { clipKey: clips[0].key, state: "confident", note: "intro" } },
    empty: ["night2"], transcripts: { [clips[0].key]: "Hello" }, includeTranscripts: false,
  });
  assert.strictEqual(built.slots.new_game.transcript, undefined);
  const { recipe } = validateRecipe(JSON.parse(JSON.stringify(built)), schema);
  const m = matchRecipe(recipe, clips);
  assert.strictEqual(m.assignments.new_game.verified, true);
  assert.deepStrictEqual(m.confirmedEmpty, ["night2"]);
});

test("export reports clips used in more than one slot without blocking", () => {
  const { clips } = readAudioZip(audioPath, "s1");
  const byKey = Object.fromEntries(clips.map((c) => [c.key, c]));
  const plan = planExport({ schema, packType: "trainer", folder: "ash", label: "ASH",
    assignments: { hit1: { clipKey: clips[0].key, state: "confident" }, hit2: { clipKey: clips[0].key, state: "confident" } },
    empty: [], clipsByKey: byKey, sources: [{ id: "s1", label: "Base" }] });
  assert.ok(plan.ok);
  assert.deepStrictEqual(plan.shared, [["hit1", "hit2"]]);
});

test("needed zips: picks counted per zip, file names kept, paths and links refused", () => {
  const { recipe } = validateRecipe({
    recipe_format: 1, mod_id: "trainer_talk", pack_type: "trainer", label: "BLUE",
    sources: [
      { id: "a", label: "Base", file_name: "C:\\Downloads\\blue_base.zip" },
      { id: "b", label: "Costume 2", file_name: "https://example.com/x.zip" },
    ],
    slots: {
      new_game: { source: "a", file: "x1.ogg" }, hit1: { source: "a", file: "x2.ogg" }, hit2: { source: "b", file: "y1.ogg" },
    },
  }, schema);
  const z = neededZips(recipe);
  assert.deepStrictEqual(z.map((x) => [x.label, x.file_name, x.picks]), [["Base", "blue_base.zip", 2], ["Costume 2", undefined, 1]]);
  const text = neededZipsText(recipe);
  assert.ok(text.includes("# Zips needed for BLUE") && text.includes("blue_base.zip") && !text.includes("https"));
});

const { parseWav, wavToOgg } = require("../src/core/audio");
function makeWav({ rate = 22050, channels = 1, bits = 16, seconds = 0.5, float = false }) {
  const frames = Math.round(rate * seconds);
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
      const p = (i * channels + c) * bytes;
      if (float) data.writeFloatLE(v, p);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), p);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), p, 3);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(float ? 3 : 1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bytes, 28); h.writeUInt16LE(channels * bytes, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("WAV: 16-bit, 24-bit, and float files read correctly", () => {
  for (const opts of [{ bits: 16 }, { bits: 24, channels: 2 }, { bits: 32, float: true, rate: 44100 }]) {
    const w = parseWav(makeWav(opts));
    assert.strictEqual(w.channels.length, opts.channels || 1);
    const peak = Math.max(...w.channels[0].subarray(0, 2000).map(Math.abs));
    assert.ok(peak > 0.45 && peak <= 0.51, `peak ${peak} for ${JSON.stringify(opts)}`);
  }
  assert.throws(() => parseWav(Buffer.from("not a wav file at all")));
});

test("WAV clips are converted to Ogg Vorbis on export", async () => {
  const ogg = await wavToOgg(makeWav({ channels: 2, bits: 16, seconds: 1 }));
  assert.strictEqual(ogg.subarray(0, 4).toString("ascii"), "OggS");
  assert.ok(ogg.includes(Buffer.from("vorbis")));
  // Through the exporter: the output keeps the slot's .ogg name.
  const dir = fs.mkdtempSync(path.join(tmp, "wav-"));
  const z = new AdmZip(); z.addFile("Voice/line_01.wav", makeWav({})); z.writeZip(path.join(dir, "src.zip"));
  const { zip, clips } = readAudioZip(path.join(dir, "src.zip"), "s1");
  assert.strictEqual(clips[0].name, "line_01.wav");
  const byKey = Object.fromEntries(clips.map((c) => [c.key, c]));
  const plan = planExport({ schema, packType: "trainer", folder: "test", label: "TEST",
    assignments: { hit1: { clipKey: clips[0].key, state: "confident" }, hit2: { clipKey: clips[0].key, state: "confident" } },
    empty: [], clipsByKey: byKey, sources: [{ id: "s1", label: "WAV set" }] });
  assert.strictEqual(plan.converted, 2);
  const written = await writeExport({ plan, sources: [{ id: "s1", label: "WAV set" }], readClip: (k) => zip.getEntry(k.split("::")[1]).getData(),
    mod: readModZip(modPath), outDir: dir, formats: { packZip: true, modZip: false } });
  const out = new AdmZip(written[0]);
  assert.strictEqual(out.readFile("test/hit1.ogg").subarray(0, 4).toString("ascii"), "OggS");
});
