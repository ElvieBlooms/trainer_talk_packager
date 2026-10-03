// Builds a self-contained demo project for the README screenshots: a tiny
// stand-in mod zip, two audio zips of synthesized "voice" clips, a recipe,
// and the canned model answers the screenshot run shows. Everything here
// is original placeholder content; no real game audio is involved.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const RATE = 16000;

// [file, line, emotion, syllables]: syllable count shapes each clip.
const BASE = [
  ["demo_01.wav", "Hey! Welcome back, let's keep going.", "happy", 6],
  ["demo_02.wav", "A brand-new adventure starts today!", "happy", 7],
  ["demo_03.wav", "Go! Use your best move!", "happy", 4],
  ["demo_04.wav", "Hit it hard!", "angry", 3],
  ["demo_05.wav", "Whoa, a critical hit!", "surprise", 4],
  ["demo_06.wav", "It missed? Come on...", "sad", 4],
  ["demo_07.wav", "Hang in there, buddy!", "fear", 4],
  ["demo_08.wav", "We did it! Great battle!", "happy", 5],
  ["demo_09.wav", "Gotcha! Welcome to the team.", "happy", 5],
  ["demo_10.wav", "No way... it broke free.", "sad", 4],
  ["demo_11.wav", "Look! It's evolving!", "surprise", 4],
  ["demo_12.wav", "This gym looks tough. Let's do this.", "neutral", 6],
  ["demo_13.wav", "Getting dark. Time to rest soon.", "neutral", 6],
  ["demo_14.wav", "Good morning! Ready to go?", "happy", 5],
  ["demo_15.wav", "Let's go, partner!", "happy", 4],
  ["demo_16.wav", "Too easy!", "happy", 3],
  ["demo_17.wav", "Don't give up now!", "fear", 4],
  ["demo_18.wav", "Huh? What was that?", "surprise", 4],
  ["demo_19.wav", "Phew... that was close.", "neutral", 5],
  ["demo_20.wav", "Rise and shine!", "happy", 3],
];
const ALT = [
  ["alt_01.wav", "Nice, it's paralyzed!", "happy", 4],
  ["alt_02.wav", "Ugh, that poison stings...", "disgust", 4],
  ["alt_03.wav", "We got away, phew.", "neutral", 3],
  ["alt_04.wav", "Can't escape!", "fear", 3],
  ["alt_05.wav", "No... we lost this one.", "sad", 4],
  ["alt_06.wav", "So this is the Elite Four...", "fear", 6],
  ["alt_07.wav", "The Champion. This is it.", "neutral", 5],
  ["alt_08.wav", "[laughs]", "happy", 2],
];

// Speech-like audio: syllables with gliding pitch and short gaps. Each
// clip gets a unique length so the demo models can tell them apart.
function synth(index, syllables, emotion) {
  const base = { happy: 240, surprise: 280, angry: 200, sad: 160, fear: 220, neutral: 190, disgust: 170 }[emotion] || 200;
  const loud = { angry: 0.7, surprise: 0.6, happy: 0.5, fear: 0.45, neutral: 0.35, sad: 0.25, disgust: 0.3 }[emotion] || 0.4;
  const syl = 0.18 + (index % 5) * 0.01;
  const gap = 0.07;
  const n = Math.round((syllables * (syl + gap) + 0.15) * RATE) + index; // +index keeps lengths unique
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const k = Math.floor(t / (syl + gap));
    const local = t - k * (syl + gap);
    if (k < syllables && local < syl) {
      const f = base * (1 + 0.15 * Math.sin(k * 1.7 + index)) * (1 + 0.1 * (local / syl));
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.sin(Math.PI * local / syl);
      out[i] = loud * env * (0.7 * Math.sin(phase) + 0.2 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
    }
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Same CRC-32 the zip format stores, so the recipe can name each clip.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function build(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const demo = { byLength: {}, matches: {} };
  const crcs = {};
  const zips = [];
  for (const [zipName, set, offset] of [["Demo Trainer.zip", BASE, 0], ["Demo Trainer (alt outfit).zip", ALT, 100]]) {
    const z = new AdmZip();
    set.forEach(([file, line, emotion, syl], i) => {
      const s = synth(offset + i, syl, emotion);
      const b = wav(s);
      z.addFile(file, b);
      crcs[file] = crc32(b);
      demo.byLength[s.length] = { text: line, emotion };
    });
    const p = path.join(dir, zipName);
    z.writeZip(p);
    zips.push(p);
  }

  // A stand-in mod: just enough for the packager (it uses its built-in
  // slot list), plus a small existing pack for the "from a pack" panel.
  const mod = new AdmZip();
  mod.addFile("Trainer_Talk/manifest.json", Buffer.from(JSON.stringify({ id: "trainer_talk", name: "Trainer Talk", version: "0.6.0" })));
  mod.addFile("Trainer_Talk/schema.json", fs.readFileSync(path.join(__dirname, "..", "schemas", "trainer_talk.schema.json")));
  mod.addFile("Trainer_Talk/assets/characters/demo_rival/meta.json", Buffer.from('{"label":"DEMO RIVAL"}'));
  mod.addFile("Trainer_Talk/assets/characters/demo_rival/new_game.ogg", Buffer.from("placeholder"));
  const modPath = path.join(dir, "Trainer_Talk.zip");
  mod.writeZip(modPath);

  // A recipe that fills most slots and leaves a few open for the matcher.
  const pick = (file, state = "confident", note) => ({ source: file.startsWith("alt") ? "alt" : "base", file, crc32: crcs[file], state, ...(note ? { note } : {}) });
  const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
  const recipe = {
    recipe_format: 1, mod_id: "trainer_talk", schema_version: 1, pack_type: "trainer",
    label: "DEMO TRAINER", folder: "demo_trainer", author: "Trainer Talk", created: "2026-10-01",
    sources: [
      { id: "base", label: "Demo Trainer", file_name: "Demo Trainer.zip", zip_md5: md5(zips[0]), clip_count: BASE.length },
      { id: "alt", label: "Demo Trainer, alt outfit", file_name: "Demo Trainer (alt outfit).zip", zip_md5: md5(zips[1]), clip_count: ALT.length },
    ],
    slots: {
      new_game: pick("demo_02.wav"), continue1: pick("demo_01.wav"),
      hit1: pick("demo_03.wav"), hit2: pick("demo_04.wav"),
      status_enemy: pick("alt_01.wav"), status_player: pick("alt_02.wav"),
      hit_crit: pick("demo_05.wav"), move_miss: pick("demo_06.wav"),
      catch_fail: pick("demo_10.wav"), run_success: pick("alt_03.wav"), run_fail: pick("alt_04.wav"),
      faint_player: pick("demo_07.wav", "stretch", "Encouraging rather than upset; check the delivery."),
      evolved: pick("demo_11.wav"), new_catch: pick("demo_09.wav"),
      battle_win: pick("demo_08.wav"), battle_loss: pick("alt_05.wav"),
      gym_enter: pick("demo_12.wav"), e4_enter: pick("alt_06.wav"), champion_enter: pick("alt_07.wav"),
      night1: pick("demo_13.wav"), morning1: pick("demo_14.wav"),
    },
    confirmed_empty: [],
  };
  // A nearly finished project: a few slots left open for the matcher,
  // the rest marked as having no match.
  const keepOpen = new Set(["faint_enemy", "blackout", "hit3", "continue2"]);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", "trainer_talk.schema.json"), "utf8"));
  recipe.confirmed_empty = schema.pack_types.trainer.slots.map((x) => x.id).filter((id) => !recipe.slots[id] && !keepOpen.has(id));
  for (const [slot, e] of Object.entries(recipe.slots)) {
    const line = [...BASE, ...ALT].find(([f]) => f === e.file);
    if (line) e.transcript = line[1];
  }
  const recipePath = path.join(dir, "demo_trainer.json");
  fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2));

  // What the demo matcher answers, by the line it picks.
  demo.matches = {
    blackout: [
      { text: "No... we lost this one.", fit: "stretch", direction: "to_you", intensity: 4, reason: "Defeated tone fits waking up after a blackout, though it's said about a battle." },
      { text: "Hang in there, buddy!", fit: "stretch", direction: "to_you", intensity: 3, reason: "Worried and caring, but sounds mid-battle rather than after it." },
    ],
    faint_enemy: [
      { text: "[laughs]", fit: "confident", direction: "by_you", intensity: 3, reason: "A pleased laugh suits the opponent's Pokémon fainting." },
      { text: "We did it! Great battle!", fit: "stretch", direction: "by_you", intensity: 3, reason: "Celebrates a win; slightly early for a single faint." },
    ],
  };
  const demoPath = path.join(dir, "demo-models.json");
  fs.writeFileSync(demoPath, JSON.stringify(demo));
  return { modPath, zips, recipePath, demoPath };
}

module.exports = { build };
if (require.main === module) console.log(build(process.argv[2] || path.join(require("os").tmpdir(), "ttp-demo")));
