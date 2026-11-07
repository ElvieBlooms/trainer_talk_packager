const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const cries = require("../src/core/cries");
const { parseWav } = require("../src/core/audio");

test("renderer copy of cries.js matches the core one", () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, "../src/renderer/cries.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "../src/core/cries.js"), "utf8"));
});

test("trim drops silence, keeps 30 ms padding and fades the end", () => {
  const rate = 48000;
  const x = new Float32Array(rate * 2);
  for (let i = rate * 0.5; i < rate * 1.0; i++) x[i] = 0.8 * Math.sin(i / 7);
  for (let i = 0; i < x.length; i++) if (!x[i]) x[i] = 1e-5 * Math.sin(i); // -98 dB hiss
  const [t] = cries.trim([x], rate);
  const pad = Math.round(0.03 * rate);
  assert.ok(Math.abs(t.length - (rate * 0.5 + 2 * pad)) < 400, `length ${t.length}`);
  assert.ok(Math.abs(t[t.length - 1]) < 0.01);
  assert.ok(Math.abs(x[rate * 1.0 - 1]) > 0.1); // original untouched (not faded)
});

test("trim of pure silence returns the clip unchanged", () => {
  const [t] = cries.trim([new Float32Array(100)], 48000);
  assert.strictEqual(t.length, 100);
});

test("toWav round-trips through parseWav", () => {
  const a = Float32Array.from([0, 0.5, -0.5, 0.25]);
  const w = parseWav(cries.toWav([a, a], 48000));
  assert.strictEqual(w.sampleRate, 48000);
  assert.deepStrictEqual([...w.channels[0]], [...a]);
});

test("classify names the three clip sets and ignores filtered variants", () => {
  assert.deepStrictEqual(cries.classify("played/cry_04.wav").id, "cry_04");
  assert.strictEqual(cries.classify("clips/764148048.ogg").id, "lgpe_764148048");
  assert.strictEqual(cries.classify("Play_PV_025_00_00 [PM025VC=PM025_42].ogg").id, "swsh_PM025_42");
  assert.strictEqual(cries.classify("Play_PV_025_00_01 [PM025VC=PM025_32].ogg"), null);
  assert.strictEqual(cries.classify("decoder/x.ogg"), null);
});

test("bundled slot data has 42 slots, 26 played, and no clip picks", () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas/anime_pikachu.cries.json"), "utf8"));
  assert.strictEqual(d.slots.length, 42);
  assert.strictEqual(d.slots.filter((s) => s.played).length, 26);
  assert.ok(!JSON.stringify(d).includes("lgpe_"));
});

test("PICKS.md marks kept slots as having no file", () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../schemas/anime_pikachu.cries.json"), "utf8"));
  const md = cries.picksMarkdown(d.slots, { cry_01: { keep: true }, cry_02: { clip: "lgpe_1", seconds: 0.5 } });
  assert.match(md, /\| 01 \| yes \| 0\.84s \| Yellow original \(no file\) \|/);
  assert.match(md, /\| 02 \| yes \| 0\.63s \| lgpe_1 \(0\.50s\) \|/);
});
