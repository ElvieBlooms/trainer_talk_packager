(() => {
"use strict";
const { h, toast, choose } = window.ui;
const api = window.packager;

// ---------------------------------------------------------------------
// State. Review state (assignments, empty, transcripts) is what sessions
// save and what export reads; everything else is derived or UI-only.
// ---------------------------------------------------------------------
const S = {
  view: "setup",
  mod: null,            // { manifest, schema, schemaSource, existingPacks, slots, fileName }
  packType: "trainer",
  label: "",
  folder: "",
  folderEdited: false,
  sources: [],          // public source objects from main
  recipes: [],          // summaries for the current pack type
  recipeErrors: [],
  appliedRecipe: null,  // { label, matched, total, missing, warnings }
  assignments: {},      // slot -> { clipKey, state, note, via, verified }
  empty: [],            // confirmed-empty slot ids
  transcripts: {},      // clipKey -> text (from recipes or Whisper)
  transcriptFlags: {},  // clipKey -> "no_words" | "non_speech"
  emotions: {},         // clipKey -> [{ label, score }] best first
  features: {},         // clipKey -> { seconds, loudness, pitch, ... }
  intensity: {},        // clipKey -> 1..5, ranked within the pack
  suggestions: {},      // slot -> matcher candidates with reasons
  matchNotes: {},       // slot -> why the matcher came back empty
  modelTranscripts: {}, // clipKey -> what Whisper said (kept when edited)
  edited: {},           // clipKey -> true when the transcript was corrected by hand
  emotionOverride: {},  // clipKey -> emotion chosen by hand
  refPack: null,        // an existing pack read from the mod, for rebuilding a recipe
  refFolder: "",
  job: null,            // running analysis or matching job
  analysisPrompted: false,
  selected: null,
  filter: "all",        // all | attention
  poolQuery: "",
  poolShowUsed: false,
  poolAllSources: false,
  history: [],
  plan: null,
  exportFormats: { packZip: true, modZip: true },
  exportResult: null,
  author: "",
  includeTranscripts: false,
};

const SPEAKER_ANNOUNCER = "announcer";

// ---- derived helpers ----

function slots() {
  return S.mod ? S.mod.slots[S.packType] || [] : [];
}
function slotById(id) {
  return slots().find((s) => s.id === id);
}
function allClips() {
  return S.sources.flatMap((s) => s.clips);
}
function clipByKey(key) {
  for (const s of S.sources) {
    const c = s.clips.find((x) => x.key === key);
    if (c) return c;
  }
  if (S.refPack) return S.refPack.clips.find((x) => x.key === key) || null;
  return null;
}
function sourceOf(clip) {
  return S.sources.find((s) => s.id === clip.sourceId);
}
function slotsUsing(clipKey) {
  return Object.entries(S.assignments).filter(([, a]) => a.clipKey === clipKey).map(([slot]) => slot);
}
function slotStatus(id) {
  if (S.assignments[id]) return S.assignments[id].state;
  if (S.empty.includes(id)) return "empty";
  return "open";
}
function counts() {
  const c = { confident: 0, stretch: 0, empty: 0, open: 0 };
  for (const s of slots()) c[slotStatus(s.id)]++;
  return c;
}
function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}
function reviewState() {
  return {
    packType: S.packType, label: S.label, folder: S.folder,
    assignments: S.assignments, empty: S.empty, transcripts: S.transcripts, transcriptFlags: S.transcriptFlags,
    emotions: S.emotions, features: S.features, suggestions: S.suggestions, matchNotes: S.matchNotes,
    edited: S.edited, emotionOverride: S.emotionOverride, modelTranscripts: S.modelTranscripts,
  };
}
function snapshot() {
  S.history.push(JSON.stringify({ a: S.assignments, e: S.empty }));
  if (S.history.length > 200) S.history.shift();
}
function undo() {
  const last = S.history.pop();
  if (!last) { toast("Nothing to undo."); return; }
  const { a, e } = JSON.parse(last);
  S.assignments = a;
  S.empty = e;
  render();
}
// Drops assignments whose clip is no longer loaded (a source was removed).
function pruneAssignments() {
  const keys = new Set(allClips().map((c) => c.key));
  for (const [slot, a] of Object.entries(S.assignments)) {
    if (!keys.has(a.clipKey)) delete S.assignments[slot];
  }
}
function setupComplete() {
  return S.mod && S.sources.length > 0 && /^[a-z0-9_]{1,40}$/.test(S.folder) && S.label.trim();
}
function unwrap(result) {
  if (result && result.error) throw new Error(result.error);
  return result;
}
async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message, "error"); }
}

// ---- audio ----

const player = new Audio();
const blobUrls = new Map();
let playingKey = null;
player.addEventListener("ended", () => { playingKey = null; markPlaying(); });

async function play(key) {
  if (playingKey === key && !player.paused) {
    player.pause();
    playingKey = null;
    markPlaying();
    return;
  }
  try {
    let url = blobUrls.get(key);
    if (!url) {
      const bytes = unwrap(await api.clipBytes(key));
      const c = clipByKey(key);
      url = URL.createObjectURL(new Blob([bytes], { type: c && /\.wav$/i.test(c.name) ? "audio/wav" : "audio/ogg" }));
      blobUrls.set(key, url);
    }
    player.src = url;
    playingKey = key;
    markPlaying();
    await player.play();
  } catch (e) {
    playingKey = null;
    markPlaying();
    toast("Couldn't play that clip: " + e.message, "error");
  }
}
function markPlaying() {
  document.querySelectorAll("[data-play]").forEach((b) => {
    const on = b.dataset.play === playingKey;
    b.classList.toggle("playing", on);
    b.setAttribute("aria-label", on ? "Stop" : "Play");
    b.textContent = on ? "■" : "▶";
  });
}
function playButton(key) {
  return h("button", {
    class: "play", "aria-label": "Play", dataset: { play: key },
    onclick: (ev) => { ev.stopPropagation(); play(key); },
  }, "▶");
}

// ---- assignment actions ----

// A clip can fill several slots. It's allowed, with a warning, since a
// line often fits more than one moment.
async function assign(clipKey, slotId) {
  const usedIn = slotsUsing(clipKey).filter((s) => s !== slotId);
  const current = S.assignments[slotId];
  let mode = "both";
  if (usedIn.length) {
    const buttons = [{ label: "Use it in both", value: "both", primary: true }, { label: "Move it here", value: "move" }];
    if (current && usedIn.length === 1) buttons.push({ label: "Swap the two", value: "swap" });
    buttons.push({ label: "Cancel", value: "cancel" });
    mode = await choose("This clip is already used",
      `It's the pick for ${usedIn.join(", ")}. You can use it in both places; players will hear the same line for each.`, buttons);
    if (!mode || mode === "cancel") return;
  }
  snapshot();
  if (usedIn.length) {
    if (mode === "swap") S.assignments[usedIn[0]] = { ...current, via: "manual" };
    else if (mode === "move") for (const s of usedIn) delete S.assignments[s];
  }
  S.assignments[slotId] = { clipKey, state: "confident", note: current ? current.note : "", via: "manual", verified: true };
  S.empty = S.empty.filter((s) => s !== slotId);
  render();
}

function clearPick(slotId) {
  snapshot();
  delete S.assignments[slotId];
  render();
}
function markEmpty(slotId) {
  snapshot();
  delete S.assignments[slotId];
  if (!S.empty.includes(slotId)) S.empty.push(slotId);
  render();
}
function reopen(slotId) {
  snapshot();
  S.empty = S.empty.filter((s) => s !== slotId);
  render();
}
function setPickState(slotId, state) {
  const a = S.assignments[slotId];
  if (!a || a.state === state) return;
  snapshot();
  a.state = state;
  a.via = "manual";
  render();
}
// Milestone only: one shared clip for every slot of the same part, such as
// an announcer's "Congratulations" for every outro.
async function shareToPart(slotId) {
  const slot = slotById(slotId);
  const a = S.assignments[slotId];
  if (!slot || !a) return;
  const targets = slots().filter((s) => s.part === slot.part && s.id !== slotId);
  const filled = targets.filter((s) => S.assignments[s.id]);
  const choice = await choose(`Use this clip for every ${slot.part}?`,
    filled.length
      ? `${filled.length} ${slot.part} slot(s) already have a pick. Replace them too, or fill only the open ones?`
      : `It will fill all ${targets.length} ${slot.part} slots.`,
    filled.length
      ? [{ label: "Fill open slots", value: "open", primary: true }, { label: "Replace all", value: "all" }, { label: "Cancel", value: "cancel" }]
      : [{ label: "Fill them", value: "all", primary: true }, { label: "Cancel", value: "cancel" }]);
  if (!choice || choice === "cancel") return;
  snapshot();
  for (const t of targets) {
    if (choice === "open" && S.assignments[t.id]) continue;
    S.assignments[t.id] = { clipKey: a.clipKey, state: a.state, note: "Shared line", via: "manual", verified: true, shared: true };
    S.empty = S.empty.filter((x) => x !== t.id);
  }
  render();
}

// ---------------------------------------------------------------------
// Analysis: transcripts (Whisper), emotion (wav2vec2), and delivery
// features measured from the audio. Clips are decoded here (Chromium
// reads Ogg Vorbis natively) and resampled to 16 kHz mono once each.
// Matching (Qwen3 4B) is a separate step the person starts themselves.
// ---------------------------------------------------------------------

function needs(kind) {
  const map = { speech: S.transcripts, emotion: S.emotions, features: S.features };
  return allClips().filter((c) => map[kind][c.key] === undefined);
}

async function decode16k(clipKey) {
  const bytes = unwrap(await api.clipBytes(clipKey));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const probe = new OfflineAudioContext(1, 1, 16000);
  const buf = await probe.decodeAudioData(ab);
  const frames = Math.max(1, Math.ceil(buf.duration * 16000));
  const off = new OfflineAudioContext(1, frames, 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

function logFeatures(k) {
  const f = S.features[k];
  const c = clipByKey(k);
  if (!f || !c) return;
  api.postActivity(`measured ${c.name}: ${f.seconds} s, loudness ${f.loudness} dB, pitch ${f.pitch || "none"}${f.pitch ? " Hz" : ""}, pitch range ${f.pitchRange} semitones`);
}

function recomputeIntensity() {
  S.intensity = window.features.intensities(S.features);
}

async function fillFromCache() {
  const keys = [...allClips(), ...(S.refPack ? S.refPack.clips : [])].map((c) => c.key);
  if (!keys.length) return;
  const hits = unwrap(await api.cachedAnalysis(keys));
  for (const [k, v] of Object.entries(hits)) {
    if (v.speech) S.modelTranscripts[k] = v.speech.text;
    if (v.speech && S.transcripts[k] === undefined) {
      S.transcripts[k] = v.speech.text;
      if (v.speech.flag) S.transcriptFlags[k] = v.speech.flag;
    }
    if (v.manual && typeof v.manual.text === "string") {
      S.transcripts[k] = v.manual.text;
      S.edited[k] = true;
      delete S.transcriptFlags[k];
    }
    if (v.manual && v.manual.emotion) S.emotionOverride[k] = v.manual.emotion;
    if (v.emotion) S.emotions[k] = v.emotion;
    if (v.features) S.features[k] = v.features;
  }
  recomputeIntensity();
}

function formatMB(bytes) {
  if (!bytes) return "size unknown";
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `about ${(mb / 1024).toFixed(1)} GB` : `about ${Math.round(mb)} MB`;
}
function gb(mb) { return `${(mb / 1024).toFixed(1)} GB`; }
function memText(model, memory) {
  if (!model.ramMB || !memory) return "";
  return memory.freeMB < model.ramMB
    ? ` Needs about ${gb(model.ramMB)} of memory, but only ${gb(memory.freeMB)} is free right now.`
    : ` Needs about ${gb(model.ramMB)} of memory.`;
}
function tight(model, memory) { return model.ramMB && memory && memory.freeMB < model.ramMB; }

function sizeText(probe) {
  if (probe.downloaded) return "Already downloaded.";
  return probe.sizeBytes ? `Download: ${formatMB(probe.sizeBytes)}.` : "Download size unknown.";
}
async function probeAll(ids) {
  const out = {};
  for (const id of ids) {
    try { out[id] = unwrap(await api.probeModel(id)); } catch (_) { out[id] = { downloaded: false, sizeBytes: null }; }
  }
  return out;
}

function openModal(children) {
  const dlg = document.getElementById("modal");
  dlg.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// Asks before anything downloads. Resolves to { speech, emotion } model
// ids (null for skipped), or null if dismissed.
// Asks before anything downloads. `scopes` are the clip sets on offer,
// e.g. [{ id, label, keys }]. Resolves to { scope keys, speech, emotion,
// replace } or null if dismissed.
async function askToAnalyze(scopes) {
  const m = unwrap(await api.listModels());
  const probes = await probeAll([...m.speech.map((x) => x.id), ...m.emotion.map((x) => x.id)]);
  const pick = { scope: scopes[0], speech: m.selected.speech, doSpeech: true, doEmotion: true, replace: false };
  const counts = h("p", { class: "muted small" });
  const update = () => {
    const keys = pick.scope.keys;
    const nS = pick.replace ? keys.length : keys.filter((k) => S.transcripts[k] === undefined).length;
    const nE = pick.replace ? keys.length : keys.filter((k) => S.emotions[k] === undefined).length;
    counts.textContent = `This will transcribe ${pick.doSpeech ? nS : 0} and label ${pick.doEmotion ? nE : 0} ${keys.length === 1 ? "clip" : "clips"}. Loudness and pitch are measured from the audio, with nothing to download.`;
  };
  const answer = await openModal([
    h("h2", {}, "Analyze clips"),
    h("p", {}, "Models run on this computer, one at a time to save memory. Each downloads once from Hugging Face and is kept for next time."),
    scopes.length > 1 ? h("div", { class: "model-choices", role: "radiogroup", "aria-label": "Which clips" },
      scopes.map((sc, i) => h("label", { class: "model-choice" },
        h("input", { type: "radio", name: "scope", checked: i === 0, onchange: () => { pick.scope = sc; update(); } }),
        h("span", { class: "model-text" }, h("b", {}, sc.label), h("span", { class: "muted" }, `${sc.keys.length} ${sc.keys.length === 1 ? "clip" : "clips"}`))))) : null,
    h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => { pick.replace = e.target.checked; update(); } }),
      "Redo clips that already have results (to try a different model)"),
    h("label", { class: "check strong-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { pick.doSpeech = e.target.checked; update(); } }), "Transcribe"),
    h("div", { class: "model-choices indent", role: "radiogroup" },
      m.speech.map((x) => h("label", { class: "model-choice" },
        h("input", { type: "radio", name: "speech-model", checked: x.id === pick.speech, onchange: () => { pick.speech = x.id; } }),
        h("span", { class: "model-text" }, h("b", {}, x.label),
          h("span", { class: tight(x, m.memory) ? "warn" : "muted" }, `${x.blurb} ${sizeText(probes[x.id])}${memText(x, m.memory)}`))))),
    h("label", { class: "check strong-check" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { pick.doEmotion = e.target.checked; update(); } }), "Detect emotion"),
    h("p", { class: (tight(m.emotion[0], m.memory) ? "warn" : "muted") + " small indent" },
      `${m.emotion[0].blurb} ${sizeText(probes[m.emotion[0].id])}${memText(m.emotion[0], m.memory)}`),
    (update(), counts),
    h("div", { class: "modal-actions" },
      h("button", { class: "btn", onclick: () => document.getElementById("modal").close("no") }, "Not now"),
      h("button", { class: "btn primary", onclick: () => document.getElementById("modal").close("yes") }, "Start")),
  ]);
  if (answer !== "yes") return null;
  return {
    keys: pick.scope.keys,
    speech: pick.doSpeech ? pick.speech : null,
    emotion: pick.doEmotion ? m.selected.emotion : null,
    replace: pick.replace,
  };
}

let renderTimer = null;
function renderSoon() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    // Don't rebuild the page under someone typing a note; try again shortly.
    if (document.activeElement && document.activeElement.tagName === "TEXTAREA") { renderSoon(); return; }
    render();
  }, 250);
}

function friendlyError(e) {
  const m = e.message || String(e);
  if (/fetch failed|ENOTFOUND|ECONNRE|EAI_AGAIN|getaddrinfo/i.test(m)) {
    return "Couldn't reach Hugging Face to download the model. Check your internet connection and try again.";
  }
  return m;
}

async function prepareWithProgress(kind, id, label) {
  S.job.phase = "download";
  S.job.label = label;
  S.job.loaded = 0;
  S.job.bytes = 0;
  S.job.modelId = id;
  render();
  unwrap(await api.selectModel(kind, id));
  return unwrap(await api.prepareModel(id));
}

function analysisScopes(clipKeys) {
  const scopes = [];
  if (clipKeys && clipKeys.length) {
    const c = clipByKey(clipKeys[0]);
    scopes.push({ id: "given", label: clipKeys.length === 1 ? `Just this clip (${c ? c.name : ""})` : "The chosen clips", keys: clipKeys });
  }
  const missing = allClips().filter((c) => S.transcripts[c.key] === undefined || S.emotions[c.key] === undefined).map((c) => c.key);
  if (missing.length) scopes.push({ id: "missing", label: "Clips without results", keys: missing });
  const shown = poolClips(slotById(S.selected)).map((c) => c.key);
  if (shown.length && shown.length !== allClips().length) scopes.push({ id: "shown", label: "Clips shown in the clip list", keys: shown });
  if (missing.length !== allClips().length) scopes.push({ id: "all", label: "Every clip", keys: allClips().map((c) => c.key) });
  return scopes;
}

// One model at a time: every chosen clip gets transcribed, then the
// speech model is unloaded before the emotion model loads. On an 8 GB
// laptop that's the difference between fitting and crashing.
async function startAnalysis({ auto = false, clipKeys = null } = {}) {
  if (S.job) return;
  S.analysisPrompted = true;
  await fillFromCache();
  const pending = allClips().filter((c) => S.transcripts[c.key] === undefined || S.emotions[c.key] === undefined);
  if (auto && !pending.length) { await measureOnly(allClips().map((c) => c.key)); return; }
  const choice = await askToAnalyze(analysisScopes(clipKeys));
  if (!choice) { await measureOnly(allClips().map((c) => c.key)); return; }
  const problems = [];
  let done = 0;
  let failed = 0;
  let lastError = "";
  S.job = { kind: "analyze", phase: "prepare", done: 0, total: 0, cancel: false };
  render();
  try {
    const passes = [
      choice.speech && { kind: "speech", id: choice.speech, label: "speech model",
        need: (k) => !S.edited[k] && (choice.replace || S.transcripts[k] === undefined),
        run: async (k, samples) => {
          const r = unwrap(await api.transcribe(k, samples));
          S.modelTranscripts[k] = r.text;
          S.transcripts[k] = r.text;
          if (r.flag) S.transcriptFlags[k] = r.flag; else delete S.transcriptFlags[k];
        } },
      choice.emotion && { kind: "emotion", id: choice.emotion, label: "emotion model",
        need: (k) => choice.replace || S.emotions[k] === undefined,
        run: async (k, samples) => { S.emotions[k] = unwrap(await api.emotion(k, samples)); } },
    ].filter(Boolean);
    for (const pass of passes) {
      if (S.job.cancel) break;
      const keys = choice.keys.filter(pass.need);
      if (!keys.length) continue;
      try {
        await prepareWithProgress(pass.kind, pass.id, pass.label);
      } catch (e) {
        problems.push(`The ${pass.label} couldn't load: ${friendlyError(e)}`);
        continue;
      }
      S.job.phase = "analyze";
      S.job.what = pass.kind === "speech" ? "Transcribing" : "Detecting emotion in";
      api.postActivity(`${pass.kind === "speech" ? "transcribing" : "detecting emotion in"} ${keys.length} ${keys.length === 1 ? "clip" : "clips"}`);
      S.job.done = 0;
      S.job.total = keys.length;
      render();
      for (const k of keys) {
        if (S.job.cancel) break;
        try {
          const samples = await decode16k(k);
          if (S.features[k] === undefined) {
            S.features[k] = window.features.measure(samples);
            api.saveFeatures(k, S.features[k]);
            logFeatures(k);
          }
          await pass.run(k, samples);
          done++;
        } catch (e) {
          failed++;
          lastError = friendlyError(e);
          console.error("analysis failed", k, e);
          // A crashed model process fails every clip after it; stop the pass.
          if (/crashed/.test(lastError)) break;
        }
        S.job.done++;
        renderSoon();
      }
      try { await api.unloadModel(pass.kind); } catch (_) { /* already gone */ }
    }
    if (!S.job.cancel) await measureOnly(choice.keys, true);
    recomputeIntensity();
    const summary = S.job.cancel ? "Stopped." : failed ? `Finished with ${failed} failed (${lastError}).` : "Analysis finished.";
    toast(problems.length ? `${problems.join(" ")} ${summary}` : summary, failed || problems.length ? "error" : "info");
  } catch (e) {
    toast(friendlyError(e), "error");
  } finally {
    S.job = null;
    render();
  }
}

// Loudness and pitch need no download, so they're measured even when the
// person declines the models.
async function measureOnly(keys, quiet = false) {
  const todo = keys.filter((k) => !S.features[k] || !S.features[k].print);
  if (!todo.length) { recomputeIntensity(); if (!quiet) render(); return; }
  const owned = !S.job;
  if (owned) S.job = { kind: "analyze", phase: "analyze", done: 0, total: 0, cancel: false };
  S.job.phase = "analyze";
  S.job.what = "Measuring";
  S.job.done = 0;
  S.job.total = todo.length;
  render();
  for (const k of todo) {
    if (S.job.cancel) break;
    try {
      S.features[k] = window.features.measure(await decode16k(k));
      api.saveFeatures(k, S.features[k]);
      logFeatures(k);
    } catch (_) { /* unreadable clip */ }
    S.job.done++;
    renderSoon();
  }
  recomputeIntensity();
  if (owned) { S.job = null; render(); }
}

// ---- matching ----

function openSlots() {
  return slots().filter((s) => slotStatus(s.id) === "open");
}

// The clip table doesn't change as picks are made (used clips are named
// in each question instead), so its saved reading stays valid across runs.
function clipTableFor(slot) {
  let clips = allClips();
  if (S.packType === "milestone" && slot.speaker) {
    clips = clips.filter((c) => {
      const sp = (sourceOf(c) || {}).speaker || "";
      return sp === slot.speaker || sp === SPEAKER_ANNOUNCER || sp === "";
    });
  }
  return clips;
}

function usedElsewhere(slotId) {
  return new Set(Object.entries(S.assignments).filter(([s]) => s !== slotId).map(([, a]) => a.clipKey));
}

function matchScopes(slotIds) {
  const scopes = [];
  const sel = slotById(S.selected);
  if (slotIds && slotIds.length) {
    scopes.push({ label: slotIds.length === 1 ? `Just ${slotIds[0]}` : "The chosen slots", ids: slotIds });
  } else if (sel) {
    scopes.push({ label: `Just ${sel.id}`, ids: [sel.id] });
  }
  if (sel) {
    const group = slots().filter((s) => s.group === sel.group && slotStatus(s.id) === "open").map((s) => s.id);
    if (group.length > 1) scopes.push({ label: `Open slots in ${sel.group}`, ids: group });
  }
  const open = openSlots().map((s) => s.id);
  if (open.length) scopes.push({ label: "Every open slot", ids: open });
  return scopes;
}

async function askToMatch(scopes) {
  const m = unwrap(await api.listModels());
  const probes = await probeAll(m.matcher.map((x) => x.id));
  // On a low-memory computer, start on the smallest model that fits.
  let pick = m.selected.matcher;
  const sel = m.matcher.find((x) => x.id === pick);
  if (sel && tight(sel, m.memory)) {
    const fits = m.matcher.filter((x) => !tight(x, m.memory)).sort((a, b) => b.ramMB - a.ramMB)[0];
    if (fits) pick = fits.id;
  }
  let scope = scopes[0];
  let gpu = m.matcherGpu;
  let fresh = false;
  const missing = allClips().filter((c) => S.transcripts[c.key] === undefined).length;
  const answer = await openModal([
    h("h2", {}, "Suggest picks"),
    h("p", {}, "The matcher reads each clip's transcript, emotion, and intensity, then suggests clips with a reason. Open slots get the best suggestion; slots you've already filled only get a list to choose from."),
    h("div", { class: "model-choices", role: "radiogroup", "aria-label": "Which slots" },
      scopes.map((sc, i) => h("label", { class: "model-choice" },
        h("input", { type: "radio", name: "match-scope", checked: i === 0, onchange: () => { scope = sc; } }),
        h("span", { class: "model-text" }, h("b", {}, sc.label),
          h("span", { class: "muted" }, `${sc.ids.length} ${sc.ids.length === 1 ? "slot" : "slots"}`))))),
    h("div", { class: "model-choices", role: "radiogroup", "aria-label": "Model" },
      m.matcher.map((x) => h("label", { class: "model-choice" },
        h("input", { type: "radio", name: "matcher-model", value: x.id, checked: x.id === pick, onchange: () => { pick = x.id; } }),
        h("span", { class: "model-text" }, h("b", {}, x.label),
          h("span", { class: tight(x, m.memory) ? "warn" : "muted" }, `${x.blurb} ${sizeText(probes[x.id])}${memText(x, m.memory)}`))))),
    h("label", { class: "check" },
      h("input", { type: "checkbox", onchange: (e) => { fresh = e.target.checked; } }),
      "Ask again for slots it has already answered"),
    h("p", { class: "muted small indent" }, "Answers and the matcher's reading of the clip list are saved as it goes, so a stopped or interrupted run picks up where it left off. Editing a transcript or emotion makes it read the list again."),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: m.matcherGpu, onchange: (e) => { gpu = e.target.checked; } }),
      "Use the graphics card"),
    h("p", { class: "muted small indent" }, "Faster on a dedicated graphics card. Integrated graphics can crash the driver; if that happens, the app switches back to the CPU on its own."),
    missing ? h("p", { class: "warn" }, `${missing} ${missing === 1 ? "clip has" : "clips have"} no transcript, so the matcher can only judge them by emotion and intensity.`) : null,
    h("div", { class: "modal-actions" },
      h("button", { class: "btn", onclick: () => document.getElementById("modal").close("no") }, "Not now"),
      h("button", { class: "btn primary", onclick: () => document.getElementById("modal").close("yes") }, "Suggest picks")),
  ]);
  if (answer === "yes" && gpu !== m.matcherGpu) unwrap(await api.setMatcherGpu(gpu));
  return answer === "yes" ? { modelId: pick, ids: scope.ids, fresh } : null;
}

function topEmotion(key) {
  if (S.emotionOverride[key]) return S.emotionOverride[key];
  const e = S.emotions[key];
  return e && e.length ? e[0].label : "";
}

async function startMatching({ slotIds = null } = {}) {
  if (S.job) return;
  const scopes = matchScopes(slotIds);
  if (!scopes.length) { toast("Select a slot first."); return; }
  const choice = await askToMatch(scopes);
  if (!choice) return;
  const id = choice.modelId;
  const targets = choice.ids.map(slotById).filter(Boolean);
  S.job = { kind: "match", phase: "prepare", done: 0, total: targets.length, cancel: false, failed: 0 };
  try {
    await prepareWithProgress("matcher", id, "matching model");
    S.job.phase = "match";
    render();
    const suggestions = {};
    const idsByKey = new Map();
    const keysById = new Map();
    allClips().forEach((c, i) => { idsByKey.set(c.key, `C${i + 1}`); keysById.set(`C${i + 1}`, c.key); });
    for (const slot of targets) {
      if (S.job.cancel) break;
      const clips = clipTableFor(slot).map((c) => ({
        id: idsByKey.get(c.key),
        text: S.transcripts[c.key] || "",
        emotion: topEmotion(c.key),
        intensity: S.intensity[c.key] || 0,
        seconds: (S.features[c.key] || {}).seconds || 0,
      }));
      try {
        const used = usedElsewhere(slot.id);
        const res = unwrap(await api.matchSlot({
          character: S.label,
          slot: { id: slot.id, moment: slot.moment, direction: slot.direction, tone: slot.tone, intensity: slot.intensity },
          clips,
          exclude: clips.filter((c) => used.has(keysById.get(c.id))).map((c) => c.id),
          fresh: choice.fresh,
        }));
        suggestions[slot.id] = res.kept;
        S.suggestions[slot.id] = [...res.kept, ...res.flagged].map((c) => ({ ...c, clipKey: keysById.get(c.clip) }));
        S.matchNotes[slot.id] = !res.returned ? "The matcher found no clip for this slot."
          : !res.kept.length && res.flagged.length ? "The matcher's only ideas react to the wrong side of the moment; they're listed below, flagged."
          : res.unknown && !res.kept.length ? "The matcher's answer didn't name clips from the list. Try again, or try the other model."
          : "";
        if (!res.kept.length) S.job.empty = (S.job.empty || 0) + 1;
      } catch (e) {
        if (/crashed/.test(e.message) && !S.job.reloaded) {
          // The process is gone; reload (on the CPU after a GPU crash) and retry this slot.
          S.job.reloaded = true;
          toast(e.message + " Retrying…", "error");
          try {
            await prepareWithProgress("matcher", id, "matching model");
            S.job.phase = "match";
            targets.splice(targets.indexOf(slot) + 1, 0, slot);
            S.job.total++;
            continue;
          } catch (e2) {
            S.job.failed++;
            S.job.lastError = friendlyError(e2);
            S.job.gaveUp = true;
            break;
          }
        }
        S.job.failed++;
        S.job.lastError = e.message;
        // Three failures in a row with nothing working means the next 45
        // will fail the same way; stop and say so.
        if (S.job.failed >= 3 && S.job.failed === S.job.done + 1) {
          S.job.done++;
          S.job.gaveUp = true;
          break;
        }
      }
      S.job.done++;
      renderSoon();
    }
    if (S.job.gaveUp) {
      toast(`The matcher failed on the first ${S.job.failed} slots, so it stopped: ${S.job.lastError}. Details are in packager.log.`, "error");
      return;
    }
    const openTargets = [...new Set(targets)].filter((s) => slotStatus(s.id) === "open");
    const takenIds = [...usedElsewhere(null)].map((k) => idsByKey.get(k)).filter(Boolean);
    const picks = unwrap(await api.matchAssign(openTargets.map((s) => ({ id: s.id, intensity: s.intensity })), suggestions, takenIds));
    snapshot();
    let filled = 0;
    for (const [slotId, c] of Object.entries(picks)) {
      if (slotStatus(slotId) !== "open") continue;
      const clipKey = keysById.get(c.clip);
      if (!clipKey || slotsUsing(clipKey).length) continue;
      S.assignments[slotId] = { clipKey, state: c.fit === "confident" ? "confident" : "stretch", note: c.reason || "", via: "ai", verified: true };
      filled++;
    }
    const { failed, cancel, lastError } = S.job;
    try { await api.unloadModel("matcher"); } catch (_) { /* already gone */ }
    const empty = S.job.empty || 0;
    const parts = [];
    if (cancel) parts.push("Stopped.");
    if (S.job.reloaded) parts.push("Recovered from a crash.");
    if (openTargets.length) parts.push(`Filled ${filled} of ${openTargets.length} open ${openTargets.length === 1 ? "slot" : "slots"}.`);
    if (new Set(targets).size > openTargets.length) parts.push(openTargets.length ? "Suggestions for filled slots are listed under each one." : "The suggestions are listed under the slot.");
    if (empty) parts.push(`No usable suggestion for ${empty} ${empty === 1 ? "slot" : "slots"}; each says why.`);
    if (failed) parts.push(`${failed} failed (${lastError}).`);
    if (filled) parts.push("Review each one.");
    toast(parts.join(" "), failed ? "error" : "info");
  } catch (e) {
    toast(friendlyError(e), "error");
  } finally {
    S.job = null;
    render();
  }
}

if (api.onModelProgress) {
  api.onModelProgress((p) => {
    if (!S.job || S.job.phase !== "download" || p.modelId !== S.job.modelId) return;
    S.job.loaded = p.loaded;
    S.job.bytes = p.total;
    renderSoon();
  });
}

function jobBar() {
  const a = S.job;
  if (!a) return null;
  let text;
  let pct = 0;
  if (a.phase === "download") {
    pct = a.bytes ? (a.loaded / a.bytes) * 100 : 0;
    text = a.bytes && a.loaded < a.bytes
      ? `Downloading the ${a.label}: ${Math.round(pct)}% of ${formatMB(a.bytes).replace("about ", "")}`
      : `Loading the ${a.label}…`;
  } else if (a.phase === "analyze") {
    pct = a.total ? (a.done / a.total) * 100 : 0;
    text = `${a.what || "Analyzing"} clip ${Math.min(a.done + 1, a.total)} of ${a.total}`;
  } else if (a.phase === "match") {
    pct = a.total ? (a.done / a.total) * 100 : 0;
    text = `Suggesting picks: slot ${Math.min(a.done + 1, a.total)} of ${a.total}`;
  } else {
    text = "Getting ready…";
  }
  return h("div", { class: "asr-bar", role: "status" },
    h("span", {}, text),
    h("progress", { max: 100, value: pct }),
    h("button", { class: "btn subtle small", disabled: a.cancel, onclick: () => { a.cancel = true; render(); } }, a.cancel ? "Stopping…" : "Stop"));
}

function clipMeta(key) {
  const f = S.features[key];
  const bits = [];
  if (f) bits.push(`${f.seconds}s`);
  if (S.intensity[key]) bits.push(`intensity ${S.intensity[key]}`);
  const e = S.emotions[key];
  if (S.emotionOverride[key]) bits.push(`${S.emotionOverride[key]} (set by you)`);
  else if (e && e.length) bits.push(`${e[0].label} ${Math.round(e[0].score * 100)}%`);
  if (S.edited[key]) bits.push("transcript edited");
  return bits.join(", ");
}

// ---------------------------------------------------------------------
// Rebuilding a recipe from a pack that's already in the mod. Pack files
// copied untouched from a zip match by checksum; anything re-encoded or
// trimmed can be matched by transcript instead.
// ---------------------------------------------------------------------

function refSeconds() {
  const out = {};
  for (const c of [...allClips(), ...(S.refPack ? S.refPack.clips : [])]) {
    if (S.features[c.key]) out[c.key] = S.features[c.key].seconds;
  }
  return out;
}

async function buildFromPack() {
  const folder = S.refFolder;
  if (!folder) return;
  if (Object.keys(S.assignments).length) {
    const ok = await choose("Replace current picks?", "Matching a pack replaces the picks you have now. You can undo this afterwards.",
      [{ label: "Match the pack", value: "yes", primary: true }, { label: "Cancel", value: "no" }]);
    if (ok !== "yes") return;
  }
  const r = unwrap(await api.loadPack(S.packType, folder));
  S.refPack = r;
  await fillFromCache();
  let res = unwrap(await api.matchPack({ transcripts: S.transcripts, seconds: refSeconds() }));
  if (S.packType === "milestone") {
    const tagged = await tagSpeakersFromMatches(res.exact);
    if (tagged) { toast(tagged); api.postActivity(tagged); render(); }
    // With speakers known, match again so any transcript matches stay
    // within each leader's own clips.
    res = unwrap(await api.matchPack({ transcripts: S.transcripts, seconds: refSeconds(), allowed: allowedClips() }));
  }
  const exactN = Object.keys(res.exact).length;
  if (res.needsTranscripts.length) {
    const answer = await choose(`${exactN} of ${r.clips.length} files matched exactly`,
      `${res.needsTranscripts.length} of the pack's files aren't byte-for-byte copies of any clip in your zips (they may have been re-encoded or trimmed). The app can transcribe them and your clips, then match them by what they say and how long they are. Those matches come back as stretches for you to check.`,
      [{ label: "Transcribe and match", value: "yes", primary: true }, { label: "Use exact matches only", value: "no" }]);
    if (answer === "yes") {
      const keys = [...res.needsTranscripts, ...allClips().filter((c) => S.transcripts[c.key] === undefined).map((c) => c.key)];
      await startAnalysis({ clipKeys: keys });
      res = unwrap(await api.matchPack({ transcripts: S.transcripts, seconds: refSeconds(), allowed: allowedClips() }));
    }
  }
  applyPackMatch(r, res);
  if (res.unmatched.length) {
    const answer = await choose(`${res.unmatched.length} ${res.unmatched.length === 1 ? "file is" : "files are"} still unmatched`,
      "The app can compare them with your clips by sound: the shape of the loudness, how the pitch moves, and the length. It works on re-encoded or trimmed copies and needs no download. Clear winners are filled in as stretches; for the rest, the closest clips are listed under each slot.",
      [{ label: "Compare by sound", value: "yes", primary: true }, { label: "Not now", value: "no" }]);
    if (answer === "yes") {
      snapshot();
      await matchBySound(res.unmatched);
    }
  }
}

// In a milestone pack, each slot may only match clips its speaker could
// have said: that leader's zip, an announcer zip, or an untagged zip.
function allowedClips() {
  if (S.packType !== "milestone" || !S.refPack) return null;
  const out = {};
  for (const ref of S.refPack.clips) {
    const slot = slotById(ref.slot);
    if (slot) out[ref.slot] = clipTableFor(slot).map((c) => c.key);
  }
  return out;
}

// Exact matches show which leader each zip belongs to. Untagged zips are
// tagged: one speaker means that leader's zip; several means an announcer.
async function tagSpeakersFromMatches(exact) {
  const bySource = {};
  for (const [slotId, m] of Object.entries(exact)) {
    const clip = clipByKey(m.clipKey);
    const slot = slotById(slotId);
    if (!clip || !slot || !slot.speaker) continue;
    (bySource[clip.sourceId] = bySource[clip.sourceId] || new Set()).add(slot.speaker);
  }
  const done = [];
  for (const src of S.sources) {
    if (src.speaker || !bySource[src.id]) continue;
    const speakers = [...bySource[src.id]];
    const speaker = speakers.length === 1 ? speakers[0] : SPEAKER_ANNOUNCER;
    await updateSource(src.id, { speaker });
    done.push(`${src.label} as ${speaker === SPEAKER_ANNOUNCER ? "an announcer" : speaker}`);
  }
  return done.length ? `Tagged ${done.length} ${done.length === 1 ? "zip" : "zips"} from the pack: ${done.join(", ")}.` : "";
}

function applyPackMatch(pack, res) {
  snapshot();
  const inPack = new Set(pack.clips.map((c) => c.slot));
  const counts = {};
  for (const m of Object.values(res.exact)) counts[m.clipKey] = (counts[m.clipKey] || 0) + 1;
  S.assignments = {};
  S.matchNotes = {};
  for (const [slot, m] of Object.entries(res.exact)) {
    S.assignments[slot] = { clipKey: m.clipKey, state: "confident", note: `Same audio as the ${pack.label} pack's file.`,
      via: "pack", match: "exact", verified: true, shared: counts[m.clipKey] > 1 };
  }
  for (const [slot, m] of Object.entries(res.similar)) {
    S.assignments[slot] = { clipKey: m.clipKey, state: "stretch",
      note: `Sounds like the ${pack.label} pack's file: ${Math.round(m.score * 100)}% match on words and length. Compare them.`,
      via: "pack", match: "transcript", verified: false };
  }
  for (const slot of res.unmatched) S.matchNotes[slot] = `The ${pack.label} pack has a file here, but no clip in your zips matched it. Play the pack's file to find it by ear.`;
  // Slots the pack left without a file stay silent, as its author chose.
  S.empty = slots().map((s) => s.id).filter((id) => !inPack.has(id));
  if (!S.label) S.label = pack.label;
  if (!S.folderEdited) S.folder = pack.folder;
  const exactN = Object.keys(res.exact).length;
  const simN = Object.keys(res.similar).length;
  S.appliedRecipe = {
    label: `${pack.label} pack`, matched: exactN + simN, total: pack.clips.length,
    missing: res.unmatched.map((slot) => ({ slot, file: `${slot}.ogg`, source: "", reason: "not loaded" })),
    warnings: simN ? [`${simN} matched by transcript; they're marked as stretches to check.`] : [],
  };
  toast(`Matched ${exactN + simN} of the pack's ${pack.clips.length} files (${exactN} exact${simN ? `, ${simN} by transcript` : ""}). Review them, then save a recipe from the Export step.`);
  render();
}

// For pack files that matched neither exactly nor by transcript: rank
// every clip by how alike it sounds (loudness shape, pitch movement,
// length). A clear winner is filled in as a stretch; the rest are listed
// under the slot to audition.
async function matchBySound(slotIds, { quiet = false } = {}) {
  const refs = slotIds.map(refClipFor).filter(Boolean);
  if (!refs.length) return 0;
  const keys = [...refs.map((r) => r.key), ...allClips().map((c) => c.key)];
  await measureOnly(keys, true);
  let filled = 0;
  for (const ref of refs) {
    const rf = S.features[ref.key];
    const scored = [];
    const slotDef = slotById(ref.slot);
    for (const c of slotDef ? clipTableFor(slotDef) : allClips()) {
      const cf = S.features[c.key];
      if (!rf || !cf) continue;
      const sim = window.features.soundSimilarity(rf, cf);
      if (sim) {
        if (sim.score >= 0.45) scored.push({ c, score: sim.score, why: `sounds alike: ${Math.round(sim.score * 100)}% (shape ${Math.round(sim.shape * 100)}%${sim.pitch === null ? "" : `, pitch ${Math.round(sim.pitch * 100)}%`}, length ${cf.seconds} s vs ${rf.seconds} s)` });
      } else if (Math.abs(cf.seconds - rf.seconds) / Math.max(cf.seconds, rf.seconds, 0.01) <= 0.08) {
        scored.push({ c, score: 0.4, why: `same length (${cf.seconds} s vs ${rf.seconds} s); too little sound to compare` });
      }
    }
    scored.sort((x, y) => y.score - x.score);
    const top = scored.slice(0, 5);
    S.suggestions[ref.slot] = top.map((t) => ({ clipKey: t.c.key, fit: "stretch", reason: `Closest to the pack's file by sound; ${t.why}.` }));
    const [best, second] = top;
    const clear = best && best.score >= 0.75 && (!second || best.score - second.score >= 0.08);
    if (clear && slotStatus(ref.slot) === "open") {
      S.assignments[ref.slot] = { clipKey: best.c.key, state: "stretch", note: `Closest to the pack's file by sound: ${best.why}. Compare them.`, via: "pack", match: "sound", verified: false };
      filled++;
      S.matchNotes[ref.slot] = "";
    } else if (slotStatus(ref.slot) === "open") {
      S.matchNotes[ref.slot] = top.length
        ? "No clear match by sound. The closest clips are listed below; play the pack's file and compare."
        : S.packType === "milestone" && slotDef && slotDef.speaker
          ? `Nothing in ${slotDef.speaker}'s zips (or announcer zips) sounds like the pack's file. It may come from a zip you haven't added or tagged.`
          : "Nothing sounds like the pack's file. It may come from a zip you haven't added.";
    }
  }
  if (!quiet) toast(`Compared ${refs.length} pack ${refs.length === 1 ? "file" : "files"} by sound: ${filled} clear ${filled === 1 ? "match" : "matches"} filled as stretches; closest clips listed under the others.`);
  render();
  return filled;
}

function refClipFor(slotId) {
  return S.refPack ? S.refPack.clips.find((c) => c.slot === slotId) : null;
}

// ---------------------------------------------------------------------
// Setup view
// ---------------------------------------------------------------------

async function chooseMod() {
  const r = unwrap(await api.chooseMod());
  if (!r) return;
  S.mod = r;
  if (!r.schema.pack_types[S.packType]) S.packType = Object.keys(r.schema.pack_types)[0];
  S.assignments = {};
  S.empty = [];
  S.appliedRecipe = null;
  await refreshRecipes();
  render();
}

async function addSources() {
  const r = unwrap(await api.addSources());
  S.sources.push(...r.added);
  r.errors.forEach((e) => toast(e, "error"));
  await refreshRecipes();
  render();
}

async function removeSource(id) {
  unwrap(await api.removeSource(id));
  S.sources = S.sources.filter((s) => s.id !== id);
  pruneAssignments();
  await refreshRecipes();
  render();
}

async function updateSource(id, patch) {
  const updated = unwrap(await api.updateSource(id, patch));
  const i = S.sources.findIndex((s) => s.id === id);
  if (i >= 0) S.sources[i] = updated;
}

async function refreshRecipes() {
  if (!S.mod) return;
  const r = unwrap(await api.listRecipes(S.packType));
  S.recipes = r.recipes;
  S.recipeErrors = r.errors;
}

async function importRecipe() {
  const r = unwrap(await api.importRecipe());
  if (!r) return;
  r.warnings.forEach((w) => toast(w));
  await refreshRecipes();
  render();
}

async function applyRecipe(id) {
  const hasWork = Object.keys(S.assignments).length > 0;
  if (hasWork) {
    const ok = await choose("Replace current picks?", "Applying a recipe replaces the picks you have now. You can undo this afterwards.",
      [{ label: "Apply recipe", value: "yes", primary: true }, { label: "Cancel", value: "no" }]);
    if (ok !== "yes") return;
  }
  const m = unwrap(await api.applyRecipe(id, S.packType));
  snapshot();
  S.assignments = m.assignments;
  S.empty = m.confirmedEmpty;
  Object.assign(S.transcripts, m.transcripts);
  if (!S.label) S.label = m.label;
  if (!S.folderEdited && m.folder) S.folder = m.folder;
  S.appliedRecipe = { label: m.label, matched: m.matched, total: m.total, missing: m.missing, warnings: m.warnings };
  toast(`Recipe applied: ${m.matched} of ${m.total} picks matched your clips.`);
  render();
}

// A located zip may have different folders inside than the original.
// Clips are found again by source, name, and checksum, and every saved
// result is moved over to the new keys.
function remapSession(st, meta) {
  const now = new Map();
  for (const c of allClips()) now.set(`${c.sourceId}|${c.name}|${c.crc}`, c.key);
  const byNameCrc = new Map();
  for (const c of allClips()) byNameCrc.set(`${c.name}|${c.crc}`, c.key);
  const known = new Set(allClips().map((c) => c.key));
  const map = {};
  let moved = 0;
  for (const [oldKey, m] of Object.entries(meta)) {
    if (known.has(oldKey)) continue;
    const k = now.get(`${m.sourceId}|${m.name}|${m.crc}`) || byNameCrc.get(`${m.name}|${m.crc}`);
    if (k) { map[oldKey] = k; moved++; }
  }
  const fix = (k) => map[k] || k;
  const remapObj = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [fix(k), v]));
  const out = { ...st };
  out.assignments = Object.fromEntries(Object.entries(st.assignments || {}).map(([slot, a]) => [slot, { ...a, clipKey: fix(a.clipKey) }]));
  for (const f of ["transcripts", "transcriptFlags", "emotions", "features", "edited", "emotionOverride", "modelTranscripts"]) out[f] = remapObj(st[f]);
  out.suggestions = Object.fromEntries(Object.entries(st.suggestions || {}).map(([slot, list]) => [slot, (list || []).map((c) => ({ ...c, clipKey: fix(c.clipKey) }))]));
  const lost = Object.values(out.assignments).filter((a) => !known.has(a.clipKey)).length;
  if (moved) toast(`Found ${moved} clips at new places inside the zips.`);
  if (lost) setTimeout(() => toast(`${lost} picks pointed at clips that aren't in the located zips; those slots are open again.`, "error"), 3600);
  return out;
}

async function openSession() {
  const r = unwrap(await api.openSession());
  if (!r) return;
  S.mod = r.mod;
  S.sources = r.sources;
  const st = remapSession(r.state || {}, r.clipMeta || {});
  S.packType = st.packType || "trainer";
  S.label = st.label || "";
  S.folder = st.folder || "";
  S.folderEdited = true;
  S.assignments = st.assignments || {};
  S.empty = st.empty || [];
  S.transcripts = st.transcripts || {};
  S.transcriptFlags = st.transcriptFlags || {};
  S.emotions = st.emotions || {};
  S.features = st.features || {};
  S.suggestions = st.suggestions || {};
  S.matchNotes = st.matchNotes || {};
  S.edited = st.edited || {};
  S.emotionOverride = st.emotionOverride || {};
  S.modelTranscripts = st.modelTranscripts || {};
  recomputeIntensity();
  S.analysisPrompted = false;
  S.history = [];
  pruneAssignments();
  await refreshRecipes();
  r.problems.forEach((p) => toast(p, "error"));
  S.view = setupComplete() ? "review" : "setup";
  render();
}

function renderSetup() {
  const m = S.mod;
  const existing = m ? m.existingPacks[S.packType] || [] : [];
  const types = m ? Object.keys(m.schema.pack_types) : ["trainer", "milestone"];
  const speakerOptions = m && m.schema.pack_types.milestone ? m.schema.pack_types.milestone.speakers : [];

  const modBlock = h("section", { class: "panel" },
    h("h2", {}, "Mod"),
    m
      ? h("div", { class: "row-between" },
          h("div", {},
            h("p", { class: "strong" }, `${m.manifest.name} ${m.manifest.version}`),
            h("p", { class: "muted" }, m.fileName),
            m.schemaSource === "bundled"
              ? h("p", { class: "note" }, "This mod zip has no schema.json, so the built-in Trainer Talk slot list is used.")
              : null),
          h("button", { class: "btn", onclick: () => run(chooseMod) }, "Choose a different zip"))
      : h("div", {},
          h("p", {}, "Start with the Trainer Talk mod zip. The packager reads its slot list and adds your pack to it."),
          h("button", { class: "btn primary", onclick: () => run(chooseMod) }, "Choose mod zip…")),
  );

  const packBlock = h("section", { class: "panel", "aria-disabled": !m },
    h("h2", {}, "Pack"),
    h("div", { class: "segmented", role: "radiogroup", "aria-label": "Pack type" },
      types.map((t) => h("button", {
        role: "radio", "aria-checked": S.packType === t ? "true" : "false",
        class: S.packType === t ? "on" : "",
        disabled: !m,
        onclick: () => run(async () => {
          if (S.packType === t) return;
          S.packType = t;
          if (S.refPack) { S.refPack = null; S.refFolder = ""; await api.unloadPack(); }
          S.assignments = {};
          S.empty = [];
          S.appliedRecipe = null;
          await refreshRecipes();
          render();
        }),
      }, t === "trainer" ? "Trainer voice" : "Milestone voice"))),
    h("p", { class: "muted" }, S.packType === "trainer"
      ? "One character who reacts to your adventure."
      : "Gym Leader, Elite Four, and Champion lines, before and after each battle."),
    h("div", { class: "fields" },
      h("label", {}, h("span", {}, "Name shown in game"),
        h("input", {
          type: "text", value: S.label, maxlength: 40, placeholder: S.packType === "trainer" ? "ASH" : "STADIUM ANNOUNCER",
          disabled: !m,
          oninput: (e) => {
            S.label = e.target.value;
            if (!S.folderEdited) { S.folder = slugify(S.label); const f = document.getElementById("folder"); if (f) f.value = S.folder; }
            updateSetupFooter();
          },
        })),
      h("label", {}, h("span", {}, "Folder name"),
        h("input", {
          id: "folder", type: "text", value: S.folder, maxlength: 40, placeholder: "ash", disabled: !m,
          list: "existing-folders", spellcheck: "false",
          oninput: (e) => { S.folder = e.target.value.trim(); S.folderEdited = true; updateSetupFooter(); render(); },
        }),
        h("datalist", { id: "existing-folders" }, existing.map((f) => h("option", { value: f })))),
    ),
    S.folder && !/^[a-z0-9_]{1,40}$/.test(S.folder)
      ? h("p", { class: "warn" }, "Use only lowercase letters, numbers, and underscores.")
      : null,
    existing.includes(S.folder)
      ? h("p", { class: "note" }, `The mod already has a "${S.folder}" pack. The full mod zip export will replace it.`)
      : null,
  );

  const sourceRows = S.sources.map((s) => h("li", { class: "source" },
    h("div", { class: "source-main" },
      h("input", {
        type: "text", value: s.label, "aria-label": "Source name", maxlength: 80,
        onchange: (e) => run(() => updateSource(s.id, { label: e.target.value })),
      }),
      h("span", { class: "muted" }, `${s.fileName}, ${s.clips.length} ${s.clips.length === 1 ? "clip" : "clips"}${s.skipped ? `, ${s.skipped} other ${s.skipped === 1 ? "file" : "files"} ignored` : ""}`)),
    S.packType === "milestone"
      ? h("label", { class: "inline" }, h("span", {}, "Speaker"),
          h("select", {
            onchange: (e) => run(async () => { await updateSource(s.id, { speaker: e.target.value }); render(); }),
          },
          h("option", { value: "", selected: !s.speaker }, "Not set"),
          h("option", { value: SPEAKER_ANNOUNCER, selected: s.speaker === SPEAKER_ANNOUNCER }, "Announcer (names in lines)"),
          speakerOptions.map((sp) => h("option", { value: sp, selected: s.speaker === sp }, sp))))
      : null,
    h("button", { class: "btn subtle", onclick: () => run(() => removeSource(s.id)) }, "Remove"),
  ));

  const sourcesBlock = h("section", { class: "panel" },
    h("h2", {}, "Audio zips"),
    h("p", { class: "muted" }, S.packType === "trainer"
      ? "Add every zip for this character. Costume or variant zips all go into one shared pool."
      : "Add each leader's zip and set its speaker, or add an announcer zip whose lines name the leader."),
    S.sources.length ? h("ul", { class: "sources" }, sourceRows) : null,
    h("button", { class: "btn" + (S.sources.length ? "" : " primary"), disabled: !m, onclick: () => run(addSources) }, "Add audio zips…"),
  );

  const usable = S.recipes.filter((r) => r.matched > 0);
  const others = S.recipes.filter((r) => r.matched === 0);
  const recipesBlock = h("section", { class: "panel" },
    h("h2", {}, "Recipes"),
    !m ? h("p", { class: "muted" }, "Recipes appear once the mod zip is chosen.")
      : !S.sources.length ? h("p", { class: "muted" }, "Add audio zips to see which recipes match them.")
      : usable.length === 0 ? h("p", { class: "muted" }, "No recipe matches these clips. You can still review and pick every slot yourself.")
      : h("ul", { class: "recipes" }, usable.map((r) => h("li", {},
          h("div", {},
            h("p", { class: "strong" }, `${r.label || r.folder} by ${r.author}`),
            h("p", { class: "muted" }, `Matches ${r.matched} of ${r.total} picks${r.origin === "imported" ? ", imported" : ""}${r.created ? `, ${r.created}` : ""}`),
            r.needed && r.needed.length ? h("ul", { class: "needed small" }, r.needed.map((z) => h("li", { class: z.loaded ? "" : "warn" },
              z.loaded ? "✓ " : "Missing: ", h("b", {}, z.label), z.file_name ? ` (${z.file_name})` : "", ` — ${z.picks} ${z.picks === 1 ? "slot" : "slots"}`))) : null),
          h("button", { class: "btn", onclick: () => run(() => applyRecipe(r.id)) }, "Apply")))),
    S.appliedRecipe ? appliedRecipeNote() : null,
    m && others.length ? h("details", { class: "other-recipes" },
      h("summary", {}, `${others.length} other ${others.length === 1 ? "recipe" : "recipes"} for ${S.packType === "trainer" ? "trainer" : "milestone"} packs, and the zips they need`),
      h("ul", { class: "recipes" }, others.map((r) => h("li", {},
        h("div", {},
          h("p", { class: "strong" }, `${r.label || r.folder} by ${r.author}`),
          h("ul", { class: "needed small" }, (r.needed || []).map((z) => h("li", {},
            h("b", {}, z.label), z.file_name ? ` (${z.file_name})` : "", ` — ${z.picks} ${z.picks === 1 ? "slot" : "slots"}`)))))))) : null,
    S.recipeErrors.length ? h("p", { class: "warn" }, `${S.recipeErrors.length} bundled recipe(s) couldn't be read.`) : null,
    h("button", { class: "btn subtle", disabled: !m, onclick: () => run(importRecipe) }, "Import recipe file…"),
    m && existing.length ? h("div", { class: "from-pack" },
      h("h3", {}, "From a pack in the mod"),
      h("p", { class: "muted small" }, "Match a pack the mod already has to your zips, then save it as a recipe. Files copied straight from a zip match exactly; others can be matched by transcript."),
      h("div", { class: "row-inline" },
        h("select", { "aria-label": "Pack", onchange: (e) => { S.refFolder = e.target.value; } },
          h("option", { value: "", selected: !S.refFolder }, "Choose a pack…"),
          existing.map((f) => h("option", { value: f, selected: S.refFolder === f }, f))),
        h("button", { class: "btn", disabled: !S.sources.length, onclick: () => run(buildFromPack) }, "Match to my zips")),
      !S.sources.length ? h("p", { class: "muted small" }, "Add the character's audio zips first.") : null)
      : null,
  );

  return h("div", { class: "setup" },
    h("div", { class: "setup-grid" }, modBlock, packBlock, sourcesBlock, recipesBlock),
    h("footer", { class: "setup-footer" },
      h("button", { class: "btn subtle", onclick: () => run(openSession) }, "Open saved session…"),
      h("span", { id: "setup-hint", class: "muted" }),
      h("button", { id: "start-review", class: "btn primary", onclick: () => go("review") }, "Start review")),
  );
}

function appliedRecipeNote() {
  const r = S.appliedRecipe;
  return h("div", { class: "applied" },
    h("p", {}, `Applied ${r.label}: ${r.matched} of ${r.total} picks found.`),
    r.missing.length
      ? h("details", {}, h("summary", {}, `${r.missing.length} pick(s) not found`),
          h("ul", { class: "plain" }, r.missing.map((x) => h("li", {},
            `${x.slot}: ${x.file}`, x.reason === "different audio" ? " (same name, different audio)" : "",
            x.source ? ` from ${x.source}` : ""))))
      : null,
    r.warnings && r.warnings.length ? h("p", { class: "warn" }, r.warnings.join(" ")) : null);
}

function updateSetupFooter() {
  const btn = document.getElementById("start-review");
  const hint = document.getElementById("setup-hint");
  if (!btn) return;
  const missing = !S.mod ? "Choose the mod zip." : !S.label.trim() ? "Name the pack."
    : !/^[a-z0-9_]{1,40}$/.test(S.folder) ? "Give the pack a valid folder name." : !S.sources.length ? "Add at least one audio zip." : "";
  btn.disabled = !!missing;
  hint.textContent = missing;
}

// ---------------------------------------------------------------------
// Review view
// ---------------------------------------------------------------------

function renderReview() {
  const all = slots();
  if (!S.selected || !slotById(S.selected)) S.selected = all[0] && all[0].id;
  const c = counts();

  const header = h("div", { class: "review-head" },
    h("div", { class: "tallies" },
      tally("confident", c.confident, "confident"),
      tally("stretch", c.stretch, "stretch"),
      tally("empty", c.empty, "no match"),
      tally("open", c.open, "open")),
    h("div", { class: "head-actions" },
      h("div", { class: "segmented small" },
        h("button", { class: S.filter === "all" ? "on" : "", onclick: () => { S.filter = "all"; render(); } }, "All slots"),
        h("button", { class: S.filter === "attention" ? "on" : "", onclick: () => { S.filter = "attention"; render(); } }, "Open and stretch")),
      S.job ? null : (() => {
        const n = new Set([...needs("speech"), ...needs("emotion")]).size;
        return h("button", { class: "btn", onclick: () => run(() => startAnalysis()) }, n ? `Analyze ${n} ${n === 1 ? "clip" : "clips"}…` : "Analyze clips…");
      })(),
      S.job ? null : h("button", { class: "btn", onclick: () => run(() => startMatching()) }, "Suggest picks…"),
      h("button", { class: "btn subtle", onclick: undo, disabled: !S.history.length, title: "Ctrl+Z" }, "Undo"),
      h("button", { class: "btn subtle", onclick: () => run(async () => {
        const p = unwrap(await api.saveSession(reviewState()));
        if (p) toast("Session saved.");
      }) }, "Save session…"),
      h("button", { class: "btn primary", onclick: () => go("export") }, "Continue to export")),
  );

  return h("div", { class: "review" + (S.job ? " with-bar" : "") }, header, jobBar(),
    h("div", { class: "panes" }, renderSlotList(all), renderSlotDetail(), renderPool()));
}

function tally(kind, n, label) {
  return h("span", { class: "tally" }, h("span", { class: "dot " + kind }), h("b", {}, String(n)), " ", label);
}

function renderSlotList(all) {
  const visible = all.filter((s) => S.filter === "all" || ["open", "stretch"].includes(slotStatus(s.id)));
  const groups = [];
  for (const s of visible) {
    let g = groups.find((x) => x.name === s.group);
    if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
    g.items.push(s);
  }
  return h("nav", { class: "pane slot-list", "aria-label": "Slots", onkeydown: slotKeys },
    groups.length === 0 ? h("p", { class: "muted pad" }, "Every slot is settled.") : null,
    groups.map((g) => h("section", {},
      h("h3", {}, g.name),
      g.items.map((s) => {
        const st = slotStatus(s.id);
        const a = S.assignments[s.id];
        const clip = a && clipByKey(a.clipKey);
        return h("button", {
          class: "slot" + (S.selected === s.id ? " selected" : ""),
          dataset: { slot: s.id },
          "aria-current": S.selected === s.id ? "true" : null,
          onclick: () => { S.selected = s.id; render(); },
        },
        h("span", { class: "dot " + st, title: st }),
        h("span", { class: "slot-text" },
          h("span", { class: "slot-id" }, s.id,
            a && slotsUsing(a.clipKey).length > 1 ? h("span", { class: "dup", title: `Same clip as ${slotsUsing(a.clipKey).filter((x) => x !== s.id).join(", ")}` }, " ×" + slotsUsing(a.clipKey).length) : null),
          h("span", { class: "slot-sub" },
            clip ? (S.transcripts[clip.key] ? `“${S.transcripts[clip.key]}”` : clip.name)
              : st === "empty" ? "No match" : "Open")));
      }))));
}

function slotKeys(e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const buttons = [...document.querySelectorAll(".slot")];
  const i = buttons.findIndex((b) => b.dataset.slot === S.selected);
  const next = buttons[i + (e.key === "ArrowDown" ? 1 : -1)];
  if (next) {
    e.preventDefault();
    S.selected = next.dataset.slot;
    render();
    const el = document.querySelector(`.slot[data-slot="${CSS.escape(S.selected)}"]`);
    if (el) el.focus();
  }
}

const DIRECTION_TEXT = { by_you: "Caused by your side", to_you: "Happens to your side", none: "No side" };
const TONE_TEXT = { positive: "Positive", negative: "Negative", neutral: "Neutral" };

function renderSlotDetail() {
  const s = slotById(S.selected);
  if (!s) return h("section", { class: "pane detail" });
  const st = slotStatus(s.id);
  const a = S.assignments[s.id];
  const clip = a && clipByKey(a.clipKey);
  const src = clip && sourceOf(clip);

  const pick = clip
    ? h("div", { class: "pick " + a.state },
        h("div", { class: "pick-top" },
          playButton(clip.key),
          h("div", { class: "pick-names" },
            h("span", { class: "file" }, clip.name),
            h("span", { class: "muted" }, src ? src.label : "")),
          h("div", { class: "segmented small", role: "radiogroup", "aria-label": "Match strength" },
            ["confident", "stretch"].map((v) => h("button", {
              role: "radio", "aria-checked": a.state === v ? "true" : "false",
              class: a.state === v ? "on" : "", onclick: () => setPickState(s.id, v),
            }, v === "confident" ? "Confident" : "Stretch")))),
        h("button", { class: "transcript-edit", title: "Edit the transcript or emotion", onclick: () => run(() => editClip(clip.key)) },
          S.transcripts[clip.key] ? `“${S.transcripts[clip.key]}”` : "Add a transcript…"),
        flagNote(clip.key),
        a.via === "recipe"
          ? h("p", { class: "muted small" }, a.verified ? "From recipe, audio verified." : "From recipe, matched by filename only. Give it a listen.")
          : a.via === "pack"
            ? h("p", { class: "muted small" }, a.match === "exact" ? "Same audio as the pack's file."
              : a.match === "sound" ? "Matched to the pack's file by sound. Play both to compare."
              : "Matched to the pack's file by transcript. Play both to compare.")
            : null,
        (() => {
          const others = slotsUsing(clip.key).filter((x) => x !== s.id);
          return others.length ? h("p", { class: "flag" }, `Also the pick for ${others.join(", ")}. Players will hear the same line in each.`) : null;
        })(),
        a.via === "ai" ? h("p", { class: "muted small" }, "Suggested by the matcher. Its reason is in the note; listen before keeping it.") : null,
        clipMeta(clip.key) ? h("p", { class: "muted small" }, clipMeta(clip.key)) : null,
        h("label", { class: "note-field" }, h("span", {}, "Note"),
          h("textarea", {
            rows: 2, maxlength: 600, value: a.note || "", placeholder: "Why this clip fits, or what to double-check",
            onchange: (e) => { snapshot(); a.note = e.target.value; },
          })),
        h("div", { class: "pick-actions" },
          h("button", { class: "btn subtle", onclick: () => clearPick(s.id) }, "Clear pick"),
          h("button", { class: "btn subtle", onclick: () => markEmpty(s.id) }, "Mark as no match"),
          h("button", { class: "btn subtle", disabled: !!S.job, onclick: () => run(() => startAnalysis({ clipKeys: [clip.key] })) }, "Analyze this clip…"),
          h("button", { class: "btn subtle", disabled: !!S.job, onclick: () => run(() => startMatching({ slotIds: [s.id] })) }, "Suggest for this slot…"),
          S.packType === "milestone"
            ? h("button", { class: "btn subtle", onclick: () => run(() => shareToPart(s.id)) }, `Use for every ${s.part}`)
            : null))
    : st === "empty"
      ? h("div", { class: "pick empty-state" },
          h("p", {}, "Marked as no match. Nothing is exported for this slot, and the mod stays quiet here."),
          h("button", { class: "btn", onclick: () => reopen(s.id) }, "Reopen slot"))
      : h("div", { class: "pick empty-state" },
          h("p", {}, "No clip yet. Play clips on the right and choose one, ask the matcher, or mark this slot as having no match."),
          h("div", { class: "pick-actions" },
            h("button", { class: "btn", disabled: !!S.job, onclick: () => run(() => startMatching({ slotIds: [s.id] })) }, "Suggest for this slot…"),
            h("button", { class: "btn subtle", onclick: () => markEmpty(s.id) }, "Mark as no match")));

  const sugg = (S.suggestions[s.id] || []).filter((c) => c.clipKey && clipByKey(c.clipKey) && (!a || c.clipKey !== a.clipKey));
  const note = S.matchNotes[s.id];
  const suggBlock = sugg.length || note ? h("div", { class: "suggestions" },
    h("h3", {}, a ? "Other suggestions" : "Suggestions"),
    note ? h("p", { class: "muted small" }, note) : null,
    sugg.length ? h("ul", { class: "clips" }, sugg.map((c) => {
      const used = slotsUsing(c.clipKey);
      return h("li", { class: "clip" },
        playButton(c.clipKey),
        h("div", { class: "clip-text" },
          h("span", { class: "transcript small" }, S.transcripts[c.clipKey] ? `“${S.transcripts[c.clipKey]}”` : clipByKey(c.clipKey).name),
          c.flag === "direction" ? h("span", { class: "flag" }, `Reacts to the wrong side: the matcher read it as ${c.direction === "by_you" ? "caused by your side" : "happening to your side"}`) : null,
          h("span", { class: "muted small" }, `${c.fit === "confident" ? "Confident" : "Stretch"}: ${c.reason}`),
          used.length ? h("span", { class: "muted small" }, `in ${used.join(", ")}`) : null),
        h("button", { class: "btn small", onclick: () => run(() => assign(c.clipKey, s.id)) }, "Use here"));
    })) : null) : null;
  const ref = refClipFor(s.id);
  const refBlock = ref ? h("div", { class: "ref-file" },
    playButton(ref.key),
    h("span", { class: "muted small" }, `The ${S.refPack.label} pack's ${ref.name}`),
    S.transcripts[ref.key] ? h("span", { class: "transcript small" }, `“${S.transcripts[ref.key]}”`) : null,
    h("span", { class: "spacer" }),
    h("button", { class: "btn subtle small", disabled: !!S.job, title: "Rank every clip by how much it sounds like the pack's file",
      onclick: () => run(async () => { snapshot(); await matchBySound([s.id]); }) }, "Find closest by sound")) : null;
  return h("section", { class: "pane detail", "aria-label": "Selected slot" },
    h("h2", { class: "file" }, s.id + ".ogg"),
    h("p", { class: "moment" }, s.moment || ""),
    h("ul", { class: "facts" },
      h("li", {}, DIRECTION_TEXT[s.direction] || s.direction),
      h("li", {}, TONE_TEXT[s.tone] || s.tone),
      h("li", {}, `Intensity ${s.intensity} of 5`),
      s.speaker ? h("li", {}, `Speaker: ${s.speaker}`) : null),
    refBlock, pick, suggBlock);
}

function poolClips(slot) {
  let clips = allClips();
  if (S.packType === "milestone" && slot && !S.poolAllSources) {
    clips = clips.filter((c) => {
      const sp = (sourceOf(c) || {}).speaker || "";
      return sp === slot.speaker || sp === SPEAKER_ANNOUNCER || sp === "";
    });
  }
  if (!S.poolShowUsed) clips = clips.filter((c) => slotsUsing(c.key).length === 0);
  const q = S.poolQuery.trim().toLowerCase();
  if (q) {
    clips = clips.filter((c) => c.name.toLowerCase().includes(q)
      || (S.transcripts[c.key] || "").toLowerCase().includes(q)
      || topEmotion(c.key).includes(q)
      || ((sourceOf(c) || {}).label || "").toLowerCase().includes(q));
  }
  // Announcer lines that name this slot's speaker float to the top.
  if (slot && slot.speaker) {
    const named = (c) => (S.transcripts[c.key] || "").toLowerCase().includes(slot.speaker) ? 0 : 1;
    clips = [...clips].sort((x, y) => named(x) - named(y));
  }
  return clips;
}

function renderPool() {
  const slot = slotById(S.selected);
  const clips = poolClips(slot);
  const unusedTotal = allClips().filter((c) => slotsUsing(c.key).length === 0).length;
  return h("section", { class: "pane pool", "aria-label": "Clips" },
    h("div", { class: "pool-head" },
      h("h2", {}, `Unused clips: ${unusedTotal}`),
      h("input", {
        type: "search", placeholder: "Filter by name or words", value: S.poolQuery, id: "pool-search",
        oninput: (e) => { S.poolQuery = e.target.value; renderPoolOnly(); },
      }),
      h("label", { class: "check" }, h("input", {
        type: "checkbox", checked: S.poolShowUsed, onchange: (e) => { S.poolShowUsed = e.target.checked; render(); },
      }), "Show clips already used"),
      S.packType === "milestone"
        ? h("label", { class: "check" }, h("input", {
            type: "checkbox", checked: S.poolAllSources, onchange: (e) => { S.poolAllSources = e.target.checked; render(); },
          }), "Show every speaker's clips")
        : null),
    h("ul", { class: "clips", id: "clip-list" }, clipRows(clips, slot)));
}

function clipRows(clips, slot) {
  if (!clips.length) return [h("li", { class: "muted pad" }, "No clips match.")];
  return clips.map((c) => {
    const used = slotsUsing(c.key);
    const src = sourceOf(c);
    return h("li", { class: "clip" + (used.length ? " used" : "") },
      playButton(c.key),
      h("div", { class: "clip-text" },
        h("span", { class: "file" }, c.name),
        S.transcripts[c.key] ? h("span", { class: "transcript small" }, `“${S.transcripts[c.key]}”`) : null,
        flagNote(c.key),
        h("span", { class: "muted small" }, [clipMeta(c.key), src && S.sources.length > 1 ? src.label : null, used.length ? `in ${used.join(", ")}` : null].filter(Boolean).join(", "))),
      h("button", { class: "btn subtle small", title: "Correct the transcript or set the emotion", onclick: () => run(() => editClip(c.key)) }, "Edit"),
      h("button", { class: "btn subtle small", title: "Transcribe or detect emotion for this clip", disabled: !!S.job,
        onclick: () => run(() => startAnalysis({ clipKeys: [c.key] })) }, "Analyze"),
      slot ? h("button", { class: "btn small", onclick: () => run(() => assign(c.key, slot.id)) }, "Use here") : null);
  });
}

const EMOTIONS = ["angry", "disgust", "fear", "happy", "neutral", "sad", "surprise"];

// Correct a transcript (Pokémon names trip up Whisper) or set the emotion
// by ear. Edits are saved and always win over model results.
async function editClip(key) {
  const clip = clipByKey(key);
  if (!clip) return;
  const modelText = S.modelTranscripts[key];
  const e = S.emotions[key];
  const textArea = h("textarea", { rows: 3, maxlength: 600, value: S.transcripts[key] || "", placeholder: "What the clip says" });
  const select = h("select", {},
    h("option", { value: "", selected: !S.emotionOverride[key] },
      e && e.length ? `Model's label: ${e[0].label} ${Math.round(e[0].score * 100)}%` : "Model's label (not analyzed yet)"),
    EMOTIONS.map((x) => h("option", { value: x, selected: S.emotionOverride[key] === x }, x)));
  const answer = await openModal([
    h("h2", { class: "file" }, clip.name),
    h("div", { class: "pick-top" }, playButton(key), h("span", { class: "muted" }, clipMeta(key))),
    h("label", { class: "note-field" }, h("span", {}, "Transcript"), textArea),
    S.edited[key] && modelText !== undefined ? h("p", { class: "muted small" }, `Whisper heard: “${modelText}”`) : null,
    h("label", { class: "note-field" }, h("span", {}, "Emotion"), select),
    h("p", { class: "muted small" }, "Your edits are kept, even if you analyze this clip again."),
    h("div", { class: "modal-actions" },
      S.edited[key] && modelText !== undefined ? h("button", { class: "btn subtle", onclick: () => document.getElementById("modal").close("revert") }, "Use Whisper's text") : null,
      h("button", { class: "btn", onclick: () => document.getElementById("modal").close("no") }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => document.getElementById("modal").close("save") }, "Save")),
  ]);
  if (answer !== "save" && answer !== "revert") return;
  const edit = {};
  if (answer === "revert") {
    edit.text = null;
    S.transcripts[key] = modelText;
    delete S.edited[key];
  } else {
    const text = textArea.value.trim();
    if (text !== (S.transcripts[key] || "")) {
      if (modelText !== undefined && text === modelText) { edit.text = null; delete S.edited[key]; }
      else { edit.text = text; S.edited[key] = true; delete S.transcriptFlags[key]; }
      S.transcripts[key] = text;
    }
  }
  if (select.value !== (S.emotionOverride[key] || "")) {
    edit.emotion = select.value || null;
    if (select.value) S.emotionOverride[key] = select.value; else delete S.emotionOverride[key];
  }
  if (Object.keys(edit).length) unwrap(await api.saveManual(key, edit));
  render();
}

function flagNote(key) {
  const f = S.transcriptFlags[key];
  if (f === "no_words") return h("span", { class: "flag" }, "No words heard: listen to it");
  if (f === "non_speech") return h("span", { class: "flag" }, "Non-speech sound");
  return null;
}

function renderPoolOnly() {
  const list = document.getElementById("clip-list");
  if (!list) return;
  list.replaceChildren(...clipRows(poolClips(slotById(S.selected)), slotById(S.selected)));
  markPlaying();
}

// ---------------------------------------------------------------------
// Export view
// ---------------------------------------------------------------------

async function loadPlan() {
  S.plan = unwrap(await api.planExport(reviewState()));
  S.needed = unwrap(await api.neededZips(reviewState()));
}

function renderExport() {
  const p = S.plan;
  if (!p) return h("div", { class: "export" }, h("p", { class: "muted pad" }, "Checking your picks…"));

  const summary = h("section", { class: "panel" },
    h("h2", {}, "Check before exporting"),
    p.errors.length ? h("ul", { class: "warn-list" }, p.errors.map((e) => h("li", {}, e))) : null,
    h("p", {}, `${p.files.length} of ${p.totalSlots} slots get a file in the "${p.folder}" pack.`),
    p.confirmedEmpty.length
      ? h("p", { class: "muted" }, `No match, left silent: ${p.confirmedEmpty.join(", ")}.`)
      : null,
    p.converted
      ? h("p", { class: "muted" }, `${p.converted} ${p.converted === 1 ? "pick is a WAV file" : "picks are WAV files"}. The mod plays Ogg Vorbis, so ${p.converted === 1 ? "it's" : "they're"} converted when you export. Your original zips aren't changed.`)
      : null,
    p.shared && p.shared.length
      ? h("p", { class: "warn" }, `Same clip in more than one slot: ${p.shared.map((list) => list.join(" and ")).join("; ")}. That's allowed; players will hear the same line in each.`)
      : null,
    p.unreviewed.length
      ? h("p", { class: "warn" }, `Never reviewed: ${p.unreviewed.join(", ")}. They'll be silent too. Go back to review them, or mark them as no match.`)
      : null);

  const table = h("section", { class: "panel" },
    h("h2", {}, "Files"),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Output file"), h("th", {}, "From clip"), h("th", {}, "Source"), h("th", {}, "Match"))),
        h("tbody", {}, p.files.map((f) => h("tr", {},
          h("td", { class: "file" }, f.outName),
          h("td", { class: "file" }, f.sourceName),
          h("td", {}, f.sourceLabel),
          h("td", {}, h("span", { class: "dot " + f.state }), f.state === "confident" ? "Confident" : "Stretch")))))));

  const out = h("section", { class: "panel" },
    h("h2", {}, "Export the pack"),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: S.exportFormats.packZip, onchange: (e) => { S.exportFormats.packZip = e.target.checked; },
    }), "Pack folder zip, to drop into an existing install"),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: S.exportFormats.modZip, onchange: (e) => { S.exportFormats.modZip = e.target.checked; },
    }), "Full mod zip with the pack inside, for a fresh install"),
    h("p", { class: "muted small" }, "A mod update replaces the full mod zip's contents, so keep the pack zip handy."),
    h("button", { class: "btn primary", disabled: !p.ok, onclick: () => run(doExport) }, "Export…"),
    S.exportResult ? h("ul", { class: "plain written" }, S.exportResult.map((f) => h("li", {},
      h("span", { class: "file", title: f }, f.split(/[\\/]/).pop()), " ",
      h("button", { class: "linkish", onclick: () => api.revealFile(f) }, "Show in folder")))) : null);

  const needed = S.needed || [];
  const neededBlock = h("section", { class: "panel" },
    h("h2", {}, "Zips this recipe needs"),
    needed.length
      ? h("ul", { class: "needed" }, needed.map((z) => h("li", {},
          h("b", {}, z.label), z.file_name ? h("span", { class: "file small" }, ` ${z.file_name}`) : null,
          h("span", { class: "muted small" }, ` — ${z.picks} ${z.picks === 1 ? "slot" : "slots"}`))))
      : h("p", { class: "muted" }, "No picks yet."),
    h("p", { class: "muted small" }, "Anyone using the recipe needs these zips. Repackaged copies still work, since clips are matched one by one."));
  const hasTranscripts = p.files.some((f) => S.transcripts[f.clipKey]);
  const recipe = h("section", { class: "panel" },
    h("h2", {}, "Share a recipe"),
    h("p", { class: "muted" }, "A recipe lists which clip goes in which slot. It has no audio, so others with the same zips can rebuild this pack."),
    h("label", {}, h("span", {}, "Your name"),
      h("input", { type: "text", value: S.author, maxlength: 60, oninput: (e) => { S.author = e.target.value; } })),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: S.includeTranscripts, disabled: !hasTranscripts,
      onchange: (e) => { S.includeTranscripts = e.target.checked; },
    }), hasTranscripts ? "Include transcripts" : "Include transcripts (none available yet)"),
    h("label", { class: "check" }, h("input", {
      type: "checkbox", checked: S.saveNeeded !== false, onchange: (e) => { S.saveNeeded = e.target.checked; },
    }), "Also save the list of zips it needs"),
    h("button", { class: "btn", disabled: !p.files.length, onclick: () => run(async () => {
      const f = unwrap(await api.exportRecipe(reviewState(), { author: S.author, includeTranscripts: S.includeTranscripts, neededList: S.saveNeeded !== false }));
      if (f) toast(f.length > 1 ? "Recipe and list of needed zips saved." : "Recipe saved.");
    }) }, "Save recipe…"));

  return h("div", { class: "export" }, summary, table, h("div", { class: "export-side" }, out, recipe, neededBlock));
}

async function doExport() {
  if (!S.exportFormats.packZip && !S.exportFormats.modZip) { toast("Choose at least one format."); return; }
  const written = unwrap(await api.writeExport(reviewState(), S.exportFormats));
  if (!written) return;
  S.exportResult = written;
  toast(`Exported ${written.length} file(s).`);
  render();
}

// ---------------------------------------------------------------------
// Navigation and render
// ---------------------------------------------------------------------

function go(view) {
  if ((view === "review" || view === "export") && !setupComplete()) {
    toast("Finish setup first: mod zip, pack name, folder, and at least one audio zip.");
    view = "setup";
  }
  S.view = view;
  S.exportResult = view === "export" ? S.exportResult : null;
  if (view === "export") {
    S.plan = null;
    render();
    run(async () => { await loadPlan(); render(); });
    return;
  }
  render();
  document.getElementById("view").focus();
  if (view === "review" && !S.analysisPrompted && !S.job) {
    S.analysisPrompted = true;
    run(async () => {
      await fillFromCache();
      render();
      await startAnalysis({ auto: true });
    });
  }
}

function render() {
  const root = document.getElementById("view");
  const scroll = [...root.querySelectorAll(".pane")].map((p) => p.scrollTop);
  const focusedId = document.activeElement && document.activeElement.id;
  root.replaceChildren(
    S.view === "setup" ? renderSetup() : S.view === "review" ? renderReview() : renderExport());
  root.querySelectorAll(".pane").forEach((p, i) => { if (scroll[i]) p.scrollTop = scroll[i]; });
  if (focusedId) {
    const el = document.getElementById(focusedId);
    if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); }
  }
  document.querySelectorAll(".step").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === S.view);
    b.setAttribute("aria-current", b.dataset.view === S.view ? "step" : "false");
  });
  if (S.view === "setup") updateSetupFooter();
  if (S.view === "review" && S.selected) {
    const sel = root.querySelector(`.slot[data-slot="${CSS.escape(S.selected)}"]`);
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
  markPlaying();
}

document.querySelectorAll(".step").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
document.getElementById("repo-link").addEventListener("click", () => api.openRepo());
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing && S.view === "review") {
    e.preventDefault();
    undo();
  }
  if (e.key === " " && !typing && S.view === "review" && !(e.target && e.target.tagName === "BUTTON")) {
    const a = S.assignments[S.selected];
    if (a) { e.preventDefault(); play(a.clipKey); }
  }
});

render();
})();
