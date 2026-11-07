// Pikachu cry picking: the 42 slots of the anime_pikachu mod, trimming a
// chosen clip the way the mod expects, and the PICKS.md the mod ships.
// Pure functions on PCM so they can be tested without Electron; the
// renderer decodes audio and calls trim(), the main process encodes.
(function (root) {
  const TRIM_DB = 40;     // silence = more than this far below the peak
  const PAD_MS = 30;      // silence kept before and after the sound
  const FADE_MS = 10;     // fade-out on the last samples

  // channels: Float32Array[]. Returns trimmed copies (never the originals).
  function trim(channels, rate, opts = {}) {
    const db = opts.db || TRIM_DB;
    const pad = Math.round(((opts.padMs ?? PAD_MS) / 1000) * rate);
    const fade = Math.round(((opts.fadeMs ?? FADE_MS) / 1000) * rate);
    const n = channels[0].length;
    let peak = 0;
    for (const c of channels) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    if (peak === 0) return channels.map((c) => c.slice(0));
    const floor = peak * Math.pow(10, -db / 20);
    let first = -1, last = -1;
    for (let i = 0; i < n && first < 0; i++) for (const c of channels) if (Math.abs(c[i]) > floor) { first = i; break; }
    for (let i = n - 1; i >= 0 && last < 0; i--) for (const c of channels) if (Math.abs(c[i]) > floor) { last = i; break; }
    const from = Math.max(0, first - pad);
    const to = Math.min(n, last + 1 + pad);
    const out = channels.map((c) => c.slice(from, to));
    const len = to - from;
    const f = Math.min(fade, len);
    for (const c of out) for (let i = 0; i < f; i++) c[len - f + i] *= 1 - (i + 1) / f;
    return out;
  }

  // 32-bit float WAV, which audio.js's parseWav reads back losslessly.
  function toWav(channels, rate) {
    const ch = channels.length, n = channels[0].length;
    const buf = Buffer.alloc(44 + n * ch * 4);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * ch * 4, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(ch, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * ch * 4, 28); buf.writeUInt16LE(ch * 4, 32); buf.writeUInt16LE(32, 34);
    buf.write("data", 36); buf.writeUInt32LE(n * ch * 4, 40);
    let p = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { buf.writeFloatLE(channels[c][i], p); p += 4; }
    return buf;
  }

  // Which of the three audio sets a clip belongs to, and its public name.
  // original: cry_NN.wav from Yellow; lgpe: <id>.ogg; swsh: the plain
  // Play_PV_025_00_00 lines (the _01_..._04_ variants are filtered copies).
  function classify(entryName) {
    const base = entryName.split("/").pop();
    let m = /^cry_(\d\d)\.wav$/i.exec(base);
    if (m) return { set: "original", id: "cry_" + m[1], slot: "cry_" + m[1], label: "Yellow " + m[1] };
    m = /^Play_PV_025_00_00 \[PM025VC=(PM025_\d+)\]\.ogg$/i.exec(base);
    if (m) return { set: "swsh", id: "swsh_" + m[1], label: "Sword/Shield " + m[1].slice(6) };
    m = /^(\d+)\.ogg$/i.exec(base);
    if (m && /(^|\/)clips\//.test(entryName)) return { set: "lgpe", id: "lgpe_" + m[1], label: "Let's Go " + m[1] };
    return null;
  }

  function picksMarkdown(slots, picks, info = {}) {
    const rows = slots.map((s) => {
      const p = picks[s.id];
      const pick = !p ? "(not chosen)" : p.keep ? "Yellow original (no file)" : p.clip;
      const secs = p && p.seconds ? ` (${p.seconds.toFixed(2)}s)` : "";
      return `| ${s.id.slice(4)} | ${s.played ? "yes" : "no"} | ${s.yellow_seconds.toFixed(2)}s | ${pick}${p && !p.keep ? secs : ""} |`;
    });
    return [
      "# Picks", "",
      `Written by Trainer Talk Packager${info.version ? " " + info.version : ""}. Clips are trimmed at ${TRIM_DB} dB below peak, ${PAD_MS} ms padding kept, ${FADE_MS} ms fade-out.`,
      "A slot marked \"Yellow original\" has no file, so the game's own clip plays.", "",
      "| Slot | Plays in game | Yellow length | Pick |", "|---|---|---|---|", ...rows, "",
    ].join("\n");
  }

  const api = { trim, toWav, classify, picksMarkdown, TRIM_DB, PAD_MS, FADE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.cries = api;
})(typeof window !== "undefined" ? window : this);
