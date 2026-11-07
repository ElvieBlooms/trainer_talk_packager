// Pikachu cries screen: listen to the Yellow original beside every Let's Go
// and Sword/Shield clip, sort them by how close they are in length and
// waveform, pick one per slot, and export trimmed cry_NN.ogg files.
(() => {
"use strict";
const { h, toast } = window.ui;
const api = window.packager;
const RATE = 48000;
const unwrap = (r) => { if (r && r.error) throw new Error(r.error); return r; };

const C = {
  data: null, clips: [], byId: new Map(), original: new Map(),
  pcm: new Map(), info: new Map(), // key -> trimmed { channels, mono16 } / { f, seconds }
  picks: {}, shortlist: {}, slot: null,
  sort: "match", source: "all", playedOnly: true, search: "", limit: 40,
  trimmedPreview: true, analyzing: 0, total: 0,
};
let ctx = null, node = null;
const root = () => document.getElementById("cries-view");

// ---- audio ----
async function decode(clip) {
  if (C.pcm.has(clip.key)) return C.pcm.get(clip.key);
  const bytes = unwrap(await api.criesBytes(clip.key));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const buf = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(ab);
  const chans = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c).slice(0));
  const pcm = { channels: chans, rate: buf.sampleRate };
  C.pcm.set(clip.key, pcm);
  return pcm;
}
async function analyze(clip) {
  if (C.info.has(clip.key)) return C.info.get(clip.key);
  const pcm = await decode(clip);
  const trimmed = window.cries.trim(pcm.channels, pcm.rate);
  const n = Math.floor(trimmed[0].length / 3);
  const mono = new Float32Array(n); // 48 kHz to 16 kHz by averaging threes
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < trimmed.length; c++) s += trimmed[c][3 * i] + trimmed[c][3 * i + 1] + trimmed[c][3 * i + 2];
    mono[i] = s / (3 * trimmed.length);
  }
  const f = window.features.measure(mono);
  const info = { trimmed, rate: pcm.rate, seconds: trimmed[0].length / pcm.rate, f, wave: mono };
  C.info.set(clip.key, info);
  return info;
}
function stop() { if (node) { try { node.stop(); } catch (_) {} node = null; } }
async function play(clip, { trimmed = C.trimmedPreview } = {}) {
  stop();
  if (!ctx) ctx = new AudioContext();
  const pcm = trimmed ? { channels: (await analyze(clip)).trimmed, rate: (await analyze(clip)).rate } : await decode(clip);
  const buf = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.rate);
  pcm.channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination);
  const done = new Promise((r) => { src.onended = r; });
  src.start(); node = src;
  await done;
}
async function playBoth(slotClip, clip) { await play(slotClip); await new Promise((r) => setTimeout(r, 350)); await play(clip); }

// ---- ranking ----
function candidates(slot) {
  const y = C.original.get(slot.id);
  const yi = y && C.info.get(y.key);
  const rows = C.clips.filter((c) => c.set !== "original").map((c) => {
    const ci = C.info.get(c.key);
    let score = null, delta = null;
    if (yi && ci) {
      const sim = window.features.soundSimilarity(yi.f, ci.f);
      score = sim ? sim.score : 0;
      delta = ci.seconds - yi.seconds;
    }
    return { c, ci, score, delta, short: (C.shortlist[slot.id] || []).indexOf(c.id) };
  });
  const q = C.search.trim().toLowerCase();
  const kept = rows.filter((r) => (C.source === "all" || r.c.set === C.source) && (!q || r.c.id.includes(q)));
  const by = {
    match: (a, b) => (b.score ?? -1) - (a.score ?? -1),
    length: (a, b) => Math.abs(a.delta ?? 99) - Math.abs(b.delta ?? 99),
    shortlist: (a, b) => (a.short < 0 ? 99 : a.short) - (b.short < 0 ? 99 : b.short) || (b.score ?? -1) - (a.score ?? -1),
  };
  return kept.sort(by[C.sort] || by.match);
}

// ---- drawing ----
function wave(info, secondsScale, w = 220, ht = 34) {
  const cv = h("canvas", { width: w * 2, height: ht * 2, class: "wave", "aria-hidden": "true" });
  const g = cv.getContext("2d");
  g.scale(2, 2);
  const px = (info.wave.length / 16000 / secondsScale) * w;
  const step = info.wave.length / Math.max(1, px);
  g.fillStyle = getComputedStyle(document.body).color;
  let peak = 0;
  for (let i = 0; i < info.wave.length; i++) peak = Math.max(peak, Math.abs(info.wave[i]));
  for (let x = 0; x < px; x++) {
    let mx = 0;
    for (let i = Math.floor(x * step); i < Math.min(info.wave.length, Math.floor((x + 1) * step)); i++) mx = Math.max(mx, Math.abs(info.wave[i]));
    const hh = Math.max(1, (mx / (peak || 1)) * (ht / 2));
    g.fillRect(x, ht / 2 - hh, 1, hh * 2);
  }
  return cv;
}

// ---- picks ----
const saveSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => api.criesSaveState({ picks: C.picks, shortlist: C.shortlist }), 300); }; })();
function choose(slotId, pick) { C.picks[slotId] = pick; saveSoon(); render(); }
function recipe() {
  return { recipe_format: 1, kind: "anime_pikachu_cries", picks: C.picks, ...(Object.keys(C.shortlist).length ? { shortlist: C.shortlist } : {}) };
}
function applyRecipe(r) {
  C.picks = {};
  for (const [slot, p] of Object.entries(r.picks || {})) {
    if (!/^cry_\d\d$/.test(slot) || !p) continue;
    if (p.keep) C.picks[slot] = { keep: true };
    else if (typeof p.clip === "string" && (!C.clips.length || C.byId.has(p.clip))) C.picks[slot] = { clip: p.clip };
  }
  C.shortlist = {};
  for (const [slot, ids] of Object.entries(r.shortlist || {})) if (Array.isArray(ids)) C.shortlist[slot] = ids.filter((x) => typeof x === "string");
  if (Object.keys(C.shortlist).length && C.sort === "match") C.sort = "shortlist";
  saveSoon();
}
async function doExport(intoMod) {
  const files = [], picks = {};
  for (const s of C.data.slots) {
    const p = C.picks[s.id];
    if (!p || p.keep) { picks[s.id] = p || null; continue; }
    const clip = C.byId.get(p.clip);
    if (!clip) { toast(`${s.id}: ${p.clip} isn't loaded. Add its zip first.`, "error"); return; }
    const info = await analyze(clip);
    files.push({ slot: s.id, channels: info.trimmed, rate: info.rate });
    picks[s.id] = { clip: p.clip, seconds: info.seconds };
  }
  if (!files.length) { toast("No clips chosen yet.", "error"); return; }
  const r = unwrap(await api.criesExport({ files, picks, intoMod }));
  if (r) toast(`Wrote ${r.count} cries: ${r.path}`);
}

// ---- view ----
function slotOrder() {
  const first = new Set(C.data.start_here || []);
  const list = C.data.slots.filter((s) => !C.playedOnly || s.played);
  return [...list.filter((s) => first.has(s.n)), ...list.filter((s) => !first.has(s.n))];
}
function status(s) {
  const p = C.picks[s.id];
  return !p ? ["open", "not chosen"] : p.keep ? ["keep", "Yellow original"] : ["done", p.clip];
}
function render() {
  const el = root();
  if (!C.data) return;
  const played = C.data.slots.filter((s) => s.played);
  const done = played.filter((s) => C.picks[s.id]).length;
  const slot = C.data.slots.find((s) => s.id === C.slot) || slotOrder()[0];
  C.slot = slot.id;
  el.replaceChildren(
    h("div", { class: "cries-bar" },
      h("button", { class: "btn primary", onclick: () => run(addZips) }, "Add audio zips"),
      h("span", { class: "muted small" }, C.clips.length ? `${C.clips.length} clips loaded` + (C.analyzing < C.total ? `, measuring ${C.analyzing} of ${C.total}…` : ", all measured") : "Add the Yellow originals, Let's Go and Sword/Shield zips."),
      h("span", { class: "spacer" }),
      h("span", { class: "small" }, `${done} of ${played.length} played slots chosen`),
      h("button", { class: "btn small", onclick: () => run(async () => { const r = unwrap(await api.criesLoadRecipe()); if (r) { applyRecipe(r); render(); toast("Picks loaded."); } }) }, "Load picks"),
      h("button", { class: "btn small", onclick: () => run(async () => { const p = unwrap(await api.criesSaveRecipe(recipe())); if (p) toast("Saved " + p); }) }, "Save picks"),
      h("button", { class: "btn small", onclick: () => run(() => doExport(false)) }, "Export folder"),
      h("button", { class: "btn small primary", onclick: () => run(() => doExport(true)) }, "Export into mod zip")),
    h("div", { class: "cries-body" },
      h("nav", { class: "cries-slots", "aria-label": "Slots" },
        h("label", { class: "check small" }, h("input", { type: "checkbox", checked: C.playedOnly, onchange: (e) => { C.playedOnly = e.target.checked; render(); } }), " Played slots only"),
        slotOrder().map((s) => {
          const [k, text] = status(s);
          const first = (C.data.start_here || []).includes(s.n);
          return h("button", { class: `cries-slot ${k}${s.id === slot.id ? " sel" : ""}`, onclick: () => { C.slot = s.id; C.limit = 40; render(); } },
            h("b", {}, s.id.slice(4)), h("span", { class: "small muted" }, `${s.yellow_seconds.toFixed(2)}s ${s.tier}${first ? " · start here" : ""}`), h("span", { class: "small" }, text));
        })),
      slotPane(slot)));
}
function slotPane(slot) {
  const y = C.original.get(slot.id);
  const yi = y && C.info.get(y.key);
  const p = C.picks[slot.id];
  const pane = h("section", { class: "cries-pane" },
    h("h2", {}, `Slot ${slot.id.slice(4)}`),
    h("p", {}, slot.played ? slot.where : "Not played in engine 0.4.0."),
    h("p", { class: "muted small" }, `Yellow original ${slot.yellow_seconds.toFixed(2)}s. Match tier from the first pass: ${slot.tier}.`),
    h("div", { class: "cries-row yellow" },
      h("button", { class: "btn", disabled: !y, onclick: () => run(() => play(y)) }, "▶ Yellow original"),
      yi ? wave(yi, Math.max(3, yi.seconds * 1.2)) : h("span", { class: "muted small" }, y ? "measuring…" : "Add the Yellow originals zip"),
      h("button", { class: p && p.keep ? "btn primary" : "btn", onclick: () => choose(slot.id, { keep: true }) }, "Keep original (no file)"),
      p && h("button", { class: "btn subtle", onclick: () => { delete C.picks[slot.id]; saveSoon(); render(); } }, "Clear")),
    h("div", { class: "cries-filters small" },
      h("label", {}, "Sort ", h("select", { onchange: (e) => { C.sort = e.target.value; render(); } },
        [["match", "Closest waveform"], ["length", "Closest length"], ...(Object.keys(C.shortlist).length ? [["shortlist", "First-pass shortlist"]] : [])]
          .map(([v, t]) => h("option", { value: v, selected: v === C.sort }, t)))),
      h("label", {}, "From ", h("select", { onchange: (e) => { C.source = e.target.value; render(); } },
        [["all", "Everything"], ["lgpe", "Let's Go"], ["swsh", "Sword/Shield"]].map(([v, t]) => h("option", { value: v, selected: v === C.source }, t)))),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: C.trimmedPreview, onchange: (e) => { C.trimmedPreview = e.target.checked; } }), " Play as exported (trimmed)"),
      h("input", { type: "search", placeholder: "Find a clip id", value: C.search, oninput: (e) => { C.search = e.target.value; C.limit = 40; clearTimeout(C.st); C.st = setTimeout(render, 250); } })));
  if (!y || !yi) return pane;
  const rows = candidates(slot);
  pane.append(h("div", { class: "cries-list" }, rows.slice(0, C.limit).map((r) => {
    const chosen = p && p.clip === r.c.id;
    return h("div", { class: `cries-row${chosen ? " chosen" : ""}` },
      h("button", { class: "btn small", onclick: () => run(() => play(r.c)) }, "▶"),
      h("button", { class: "btn small", title: "Yellow, then this clip", onclick: () => run(() => playBoth(y, r.c)) }, "A/B"),
      h("span", { class: "cries-name" }, r.c.label, r.short >= 0 ? h("span", { class: "tag" }, `shortlist ${r.short + 1}`) : null),
      r.ci ? wave(r.ci, Math.max(3, yi.seconds * 1.2)) : h("span", { class: "muted small" }, "…"),
      h("span", { class: "small mono" }, r.ci ? `${r.ci.seconds.toFixed(2)}s (${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)})` : ""),
      h("span", { class: "small mono" }, r.score === null ? "" : `${Math.round(r.score * 100)}%`),
      h("button", { class: chosen ? "btn small primary" : "btn small", onclick: () => choose(slot.id, { clip: r.c.id }) }, chosen ? "Chosen" : "Use"));
  })));
  if (rows.length > C.limit) pane.append(h("button", { class: "btn", onclick: () => { C.limit += 60; render(); } }, `Show more (${rows.length - C.limit} left)`));
  return pane;
}

async function run(fn) { try { await fn(); } catch (e) { toast(e.message, "error"); } }

async function addZips() {
  const r = unwrap(await api.criesAddZips());
  for (const e of r.errors) toast(e, "error");
  C.clips = r.clips;
  C.byId = new Map(C.clips.filter((c) => c.set !== "original").map((c) => [c.id, c]));
  C.original = new Map(C.clips.filter((c) => c.set === "original").map((c) => [c.id, c]));
  C.total = C.clips.length; C.analyzing = C.clips.filter((c) => C.info.has(c.key)).length;
  render();
  measureAll();
}
let measuring = false;
async function measureAll() {
  if (measuring) return;
  measuring = true;
  const order = [...C.original.values(), ...C.clips.filter((c) => c.set !== "original")];
  C.total = order.length; C.analyzing = order.filter((c) => C.info.has(c.key)).length;
  for (const c of order) {
    if (C.info.has(c.key)) continue;
    try { await analyze(c); } catch (e) { /* undecodable clip: left out of ranking */ C.info.set(c.key, null); }
    C.analyzing++;
    if (C.analyzing % 25 === 0) { render(); await new Promise((r) => setTimeout(r)); }
  }
  C.analyzing = C.total;
  measuring = false;
  render();
}

async function open() {
  document.getElementById("view").hidden = true;
  document.querySelector(".steps").hidden = true;
  root().hidden = false;
  if (!C.data) {
    C.data = unwrap(await api.criesInfo());
    const saved = await api.criesLoadState();
    if (saved && !saved.error && saved.picks) { C.picks = saved.picks; C.shortlist = saved.shortlist || {}; if (Object.keys(C.shortlist).length) C.sort = "shortlist"; }
  }
  render();
}
function close() {
  stop();
  root().hidden = true;
  document.getElementById("view").hidden = false;
  document.querySelector(".steps").hidden = false;
}
document.getElementById("cries-open").addEventListener("click", () => (root().hidden ? run(open) : close()));
document.getElementById("cries-open").setAttribute("aria-expanded", "false");
})();
