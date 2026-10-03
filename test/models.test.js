const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { classify, ALL, DEFAULTS } = require("../src/models/catalog");
const { downloadModel, isDownloaded } = require("../src/models/download");
const { filterSuggestions, splitSuggestions, normalizeClipId, assignFromSuggestions } = require("../src/core/assign");
const features = require("../src/renderer/features");

test("Whisper output is cleaned and flagged", () => {
  assert.deepStrictEqual(classify("  I choose  you! "), { text: "I choose you!", flag: "" });
  assert.deepStrictEqual(classify("[BLANK_AUDIO]"), { text: "", flag: "no_words" });
  assert.deepStrictEqual(classify(" (laughs)"), { text: "(laughs)", flag: "non_speech" });
  assert.strictEqual(classify("(laughs) Our training's paying off!").flag, "");
});

test("catalog defaults exist", () => {
  for (const id of Object.values(DEFAULTS)) assert.ok(ALL[id], id);
});

// A fake Hub: serves files with Range support, drops the connection
// halfway through the big file on the first request, and 404s optional files.
function fakeHub() {
  const big = Buffer.alloc(300000, 7);
  let dropped = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/models/")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify([{ path: "onnx/model.onnx", size: 0, lfs: { size: big.length } }, { path: "config.json", size: 2 }]));
    }
    const file = decodeURIComponent(req.url.split("/resolve/main/")[1] || "");
    const body = file === "onnx/model.onnx" ? big : file === "config.json" ? Buffer.from("{}") : null;
    if (!body) { res.statusCode = 404; return res.end(); }
    const m = /bytes=(\d+)-/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0;
    if (m) { res.statusCode = 206; res.setHeader("content-range", `bytes ${start}-${body.length - 1}/${body.length}`); }
    res.setHeader("content-length", body.length - start);
    if (file === "onnx/model.onnx" && !dropped) {
      dropped = true;
      res.write(body.subarray(start, start + 100000));
      return setTimeout(() => res.destroy(), 20);
    }
    res.end(body.subarray(start));
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

test("downloader resumes after a dropped connection and marks completion", async () => {
  const server = await fakeHub();
  const port = server.address().port;
  const fetchImpl = (url, opts) => fetch(url.replace("https://huggingface.co", `http://127.0.0.1:${port}`), opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-dl-"));
  const spec = { repo: "test/model", files: ["onnx/model.onnx", "config.json"], optional: ["vocab.json"] };
  const seen = [];
  await downloadModel(dir, spec, { fetchImpl, onProgress: (p) => seen.push(p.loaded) });
  server.close();
  assert.ok(isDownloaded(dir, spec));
  assert.strictEqual(fs.statSync(path.join(dir, "test/model/onnx/model.onnx")).size, 300000);
  assert.ok(!fs.existsSync(path.join(dir, "test/model/onnx/model.onnx.part")));
  assert.ok(seen.length > 1);
  // A file truncated after the fact means the model is no longer "downloaded".
  fs.truncateSync(path.join(dir, "test/model/onnx/model.onnx"), 10);
  assert.ok(!isDownloaded(dir, spec));
});

test("suggestions: wrong-direction picks dropped, scarce slots choose first", () => {
  const valid = new Set(["C1", "C2", "C3"]);
  const hit = { id: "hit_crit", direction: "by_you", intensity: 3 };
  const kept = filterSuggestions(hit, [
    { clip: "C1", direction: "to_you" }, { clip: "C2", direction: "by_you" }, { clip: "C9", direction: "by_you" },
  ], valid);
  assert.deepStrictEqual(kept.map((c) => c.clip), ["C2"]);
  const picks = assignFromSuggestions(
    [{ id: "easy", intensity: 1 }, { id: "hard", intensity: 5 }],
    { easy: [{ clip: "C1" }, { clip: "C2" }], hard: [{ clip: "C1" }] });
  assert.strictEqual(picks.hard.clip, "C1");
  assert.strictEqual(picks.easy.clip, "C2");
});

test("features: pitch and loudness of a synthetic tone", () => {
  const n = 16000;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / 16000);
  const f = features.measure(tone);
  assert.strictEqual(f.seconds, 1);
  assert.ok(Math.abs(f.pitch - 200) < 5, `pitch ${f.pitch}`);
  assert.ok(f.loudness > -10 && f.loudness < -5, `loudness ${f.loudness}`);
  const quiet = { loudness: -40, pitch: 150, pitchRange: 1 };
  const loud = { loudness: -8, pitch: 400, pitchRange: 9 };
  const mid = { loudness: -20, pitch: 250, pitchRange: 4 };
  const r = features.intensities({ a: quiet, b: mid, c: loud, d: mid, e: quiet });
  assert.ok(r.c > r.b && r.b > r.a);
});

test("matcher answers: loose clip ids accepted, wrong direction flagged not lost", () => {
  assert.strictEqual(normalizeClipId("c12"), "C12");
  assert.strictEqual(normalizeClipId("C 7: \"Awesome!\""), "C7");
  assert.strictEqual(normalizeClipId("clip twelve"), "");
  const r = splitSuggestions({ id: "faint_enemy", direction: "by_you" }, [
    { clip: "c1", direction: "by_you" }, { clip: "C2", direction: "to_you" }, { clip: "C99" }, { clip: "C1", direction: "by_you" },
  ], new Set(["C1", "C2"]));
  assert.deepStrictEqual(r.kept.map((c) => c.clip), ["C1"]);
  assert.deepStrictEqual(r.flagged.map((c) => c.clip), ["C2"]);
  assert.strictEqual(r.unknown, 1);
});

const { matchPack, textSimilarity } = require("../src/core/packmatch");
test("pack files match clips exactly by checksum, then by transcript", () => {
  const ref = [
    { key: "ref::a", slot: "hit1", crc: "aaaa0001", size: 10 },
    { key: "ref::b", slot: "hit2", crc: "aaaa0001", size: 10 },
    { key: "ref::c", slot: "evolved", crc: "ffff0000", size: 12 },
    { key: "ref::d", slot: "night1", crc: "eeee0000", size: 9 },
  ];
  const clips = [
    { key: "s1::x", crc: "aaaa0001", size: 10 },
    { key: "s1::y", crc: "11112222", size: 30 },
    { key: "s1::z", crc: "33334444", size: 30 },
  ];
  const transcripts = { "ref::c": "Whoa! You evolved! Awesome!", "s1::y": "Whoa, you evolved, awesome!", "s1::z": "Let's go!", "ref::d": "Good night, Pikachu." };
  const r = matchPack(ref, clips, { transcripts, seconds: { "ref::c": 2.0, "s1::y": 2.1 } });
  assert.strictEqual(r.exact.hit1.clipKey, "s1::x");
  assert.strictEqual(r.exact.hit2.clipKey, "s1::x"); // a shared line, as in the pack
  assert.strictEqual(r.similar.evolved.clipKey, "s1::y");
  assert.deepStrictEqual(r.unmatched, ["night1"]);
  assert.ok(textSimilarity("Pikachu!", "pikachu") > 0.99);
  assert.strictEqual(textSimilarity("(laughs)", "[sighs]"), 0);
});

test("sound similarity: a trimmed, quieter copy beats a different line", () => {
  const RATE = 16000;
  // A "line": a few syllables with gliding pitch and gaps.
  const line = (scale, trimStart) => {
    const syl = [[0.0, 0.25, 220, 260], [0.35, 0.6, 300, 240], [0.75, 1.1, 200, 180], [1.2, 1.5, 260, 320]];
    const n = Math.round(1.6 * RATE);
    const out = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const s = syl.find(([a, b]) => t >= a && t < b);
      if (s) { const f = s[2] + (s[3] - s[2]) * ((t - s[0]) / (s[1] - s[0])); phase += (2 * Math.PI * f) / RATE; out[i] = scale * Math.sin(phase) * Math.sin(Math.PI * (t - s[0]) / (s[1] - s[0])); }
    }
    return out.subarray(Math.round(trimStart * RATE));
  };
  const other = () => {
    const n = Math.round(1.4 * RATE); const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / RATE; out[i] = (t < 0.9 ? 0.4 : 0.05) * Math.sin(2 * Math.PI * 150 * t); }
    return out;
  };
  const original = features.measure(line(0.6, 0));
  const reencoded = features.measure(line(0.25, 0.2)); // quieter, start trimmed
  const different = features.measure(other());
  const same = features.soundSimilarity(original, reencoded);
  const diff = features.soundSimilarity(original, different);
  assert.ok(same.score > 0.75, `same ${JSON.stringify(same)}`);
  assert.ok(same.score - diff.score > 0.25, `same ${same.score} vs different ${diff.score}`);
});

test("milestone packs: transcript matches stay within the allowed speaker's clips", () => {
  const ref = [{ key: "ref::b", slot: "brock_intro", crc: "x1", size: 1 }];
  const clips = [{ key: "misty::m", crc: "y1", size: 2 }, { key: "brock::b", crc: "y2", size: 3 }];
  const transcripts = { "ref::b": "I'm Brock, I believe in rock hard defense", "misty::m": "I'm Brock, I believe in rock hard defense", "brock::b": "I am Brock. I believe in rock-hard defense!" };
  const open = matchPack(ref, clips, { transcripts });
  assert.strictEqual(open.similar.brock_intro.clipKey, "misty::m"); // identical text wins without limits
  const limited = matchPack(ref, clips, { transcripts, allowed: { brock_intro: ["brock::b"] } });
  assert.strictEqual(limited.similar.brock_intro.clipKey, "brock::b");
});
