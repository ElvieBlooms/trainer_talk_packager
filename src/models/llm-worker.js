// Matching worker (utility process). Runs Qwen3 4B through llama.cpp
// (node-llama-cpp). The clip table goes in the system prompt once; each
// open slot is then one short question, so llama.cpp reuses the
// already-processed prefix instead of re-reading every clip per slot.
//
// In:  { id, cmd: "probe"|"prepare"|"suggest", modelId, dir, clips, slot }
// Out: { id, ok, result } | { id, ok: false, error } | { event: "progress", modelId, loaded, total }
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { ALL } = require("./catalog");
const { downloadModel, isDownloaded, remoteSize, modelDir } = require("./download");

const FAKE = process.env.TTP_FAKE_MODELS === "1";
let state = null; // { modelId, llama, model, context, session, grammar, tableKey, baseHistory }

function send(msg) { process.parentPort.postMessage(msg); }

const SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          clip: { type: "string" },
          direction: { enum: ["by_you", "to_you", "none"] },
          intensity: { enum: [1, 2, 3, 4, 5] },
          fit: { enum: ["confident", "stretch"] },
          reason: { type: "string" },
        },
        required: ["clip", "direction", "intensity", "fit", "reason"],
      },
    },
  },
  required: ["candidates"],
};

function systemPrompt(character, clips) {
  const lines = clips.map((c) => {
    const text = (c.text || "").slice(0, 160);
    const bits = [`${c.id}: "${text || "(no transcript)"}"`];
    if (c.emotion) bits.push(c.emotion);
    if (c.intensity) bits.push(`intensity ${c.intensity}`);
    if (c.seconds) bits.push(`${c.seconds}s`);
    return bits.join(" | ");
  });
  return [
    `You help build a voice pack for ${character || "a character"} in a Pokémon game mod.`,
    "Each slot is a moment in the game. You pick voice clips that fit the moment, using only the clips listed below.",
    "Direction matters as much as the words. by_you means caused by the player's side (your attack lands, the opponent faints). to_you means it happens to the player's side (your Pokémon faints, you black out). A pleased reaction fits by_you; distress fits to_you. none means no side, like entering a room.",
    "Intensity runs 1 (small) to 5 (biggest). Prefer clips whose delivery matches the slot's intensity.",
    "Always list the closest clips you can find, up to 5, best first. Mark a pick confident only if both meaning and delivery fit; mark it stretch if only the tone or part of the meaning fits. A person reviews every pick, so a labeled stretch is useful. Return an empty list only if no clip relates to the moment at all.",
    "For each pick, give the clip id exactly as written in the list (like C12), the direction of the moment the clip would react to, its intensity, and a one-sentence reason.",
    "",
    "Clips:",
    ...lines,
  ].join("\n");
}

function userPrompt(slot, noThink) {
  return [
    `Slot ${slot.id}: ${slot.moment}.`,
    `Direction: ${slot.direction}. Tone: ${slot.tone}. Intensity: ${slot.intensity} of 5.`,
    slot.exclude && slot.exclude.length ? `Already used elsewhere, don't pick: ${slot.exclude.join(", ")}.` : "",
    "Choose up to 5 clips, best first.",
    noThink ? "/no_think" : "",
  ].filter(Boolean).join("\n");
}

function log(line, quiet = false) { send({ event: "log", line: `llm: ${line}`, quiet }); }

async function loadRuntime(spec, dir, gpu) {
  const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
  const llama = await getLlama({
    gpu: gpu ? "auto" : false,
    build: "never",
    logLevel: LlamaLogLevel.warn,
    logger: (level, message) => { const m = String(message).trim(); if (m) log(`llama.cpp ${level}: ${m}`); },
  });
  log(`loading ${spec.label} on ${gpu ? "the GPU if available" : "the CPU"}…`);
  const t0 = Date.now();
  const model = await llama.loadModel({
    modelPath: path.join(modelDir(dir, spec), spec.files[0]),
    ...(llama.gpu ? {} : { gpuLayers: 0 }),
  });
  const grammar = await llama.createGrammarForJsonSchema(SCHEMA);
  log(`loaded ${spec.files[0]} on ${llama.gpu || "cpu"} in ${((Date.now() - t0) / 1000).toFixed(1)} s; memory in use ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  return { llama, model, grammar, context: null, session: null, tableKey: null };
}

async function disposeRuntime() {
  if (!state || state.fake) return;
  try { if (state.session) state.session.dispose(); } catch (_) { /* already gone */ }
  try { if (state.context) await state.context.dispose(); } catch (_) { /* already gone */ }
  try { await state.model.dispose(); } catch (_) { /* already gone */ }
  try { await state.llama.dispose(); } catch (_) { /* already gone */ }
}

async function prepare(modelId, dir, gpu) {
  const spec = ALL[modelId];
  if (!spec || spec.kind !== "matcher") throw new Error(`Unknown model ${modelId}.`);
  if (state && state.modelId === modelId && (state.fake || state.gpuWanted === gpu)) return { modelId, gpu: state.fake ? "fake" : state.llama.gpu || "cpu" };
  if (FAKE) {
    for (let i = 1; i <= 4; i++) { send({ event: "progress", modelId, loaded: i * 25, total: 100 }); await new Promise((r) => setTimeout(r, 40)); }
    state = { modelId, fake: true };
    return { modelId, gpu: "fake" };
  }
  await downloadModel(dir, spec, { onProgress: (p) => send({ event: "progress", modelId, file: p.file, loaded: p.loaded, total: p.total }) });
  await disposeRuntime();
  state = { modelId, spec, dir, gpuWanted: gpu, ...(await loadRuntime(spec, dir, gpu)) };
  return { modelId, gpu: state.llama.gpu || "cpu" };
}

// The context is sized to the clip table, so a big pack doesn't overflow
// it and a small one doesn't waste memory.
async function ensureSession(character, clips) {
  const { LlamaChatSession } = await import("node-llama-cpp");
  const tableKey = JSON.stringify([character, clips]);
  if (state.session && state.tableKey === tableKey) return;
  const sys = systemPrompt(character, clips);
  const needed = state.model.tokenize(sys).length + 1500;
  const max = Math.min(state.model.trainContextSize || 32768, 32768);
  if (needed > max) throw new Error(`The clip list is too long for the matcher (${needed} tokens).`);
  if (!state.context || state.context.contextSize < needed) {
    if (state.session) { state.session.dispose(); state.session = null; }
    if (state.context) await state.context.dispose();
    const size = Math.min(max, Math.max(4096, Math.ceil(needed / 1024) * 1024 + 1024));
    state.context = await state.model.createContext({ contextSize: size });
    log(`context ${state.context.contextSize} tokens for a ${needed}-token prompt`);
  }
  if (state.session) state.session.dispose();
  const sequence = state.context.getSequence();
  state.session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: sys });
  state.firstSlot = true;
  log(`clip list for the matcher: ${clips.length} clips, ${needed - 1500} tokens.`);

  // Reading the clip list is the slow part on a low-end CPU. Its processed
  // state is saved to disk, keyed by model, clip list, and context size, so
  // an interrupted or repeated run picks up without rereading it.
  const cacheDir = path.join(state.dir, "..", "matcher-cache"); // beside the models folder
  const key = crypto.createHash("sha1").update(JSON.stringify([state.modelId, sys, state.context.contextSize])).digest("hex");
  const file = path.join(cacheDir, `${key}.state`);
  let restored = false;
  if (fs.existsSync(file)) {
    try {
      const t0 = Date.now();
      await sequence.loadStateFromFile(file, { acceptRisk: true });
      restored = true;
      state.firstSlot = false;
      log(`reused the saved reading of the clip list (${((Date.now() - t0) / 1000).toFixed(1)} s instead of reading it again)`);
    } catch (err) {
      log(`couldn't reuse the saved reading (${err.message}); reading it again`);
      try { fs.unlinkSync(file); } catch (_) { /* gone */ }
    }
  }
  if (!restored) {
    const t0 = Date.now();
    log("reading the clip list (this is the slow part; it's saved afterwards)…");
    await state.session.preloadPrompt("");
    state.firstSlot = false;
    log(`read the clip list in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const { fileSize } = await sequence.saveStateToFile(file);
      log(`saved the reading to disk (${Math.round(fileSize / 1048576)} MB)`);
      pruneCache(cacheDir, file);
    } catch (err) {
      log(`couldn't save the reading: ${err.message}`);
    }
  }
  state.tableKey = tableKey;
  state.baseHistory = state.session.getChatHistory();
}

// Keeps the two most recent saved readings; each can be a few hundred MB.
function pruneCache(dir, keep) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".state")).map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(2)) if (f !== keep) fs.unlinkSync(f);
  } catch (_) { /* best effort */ }
}

async function ask(character, clips, slot) {
  await ensureSession(character, clips);
  // Every slot starts from the same history, so answers don't leak
  // between slots and the clip table stays cached.
  state.session.setChatHistory(state.baseHistory);
  const t0 = Date.now();
  let tokens = 0;
  let firstAt = 0;
  let lastReport = t0;
  log(`${slot.id}: ${state.firstSlot ? "reading the clip list and the question…" : "reading the question…"}`, true);
  state.firstSlot = false;
  const raw = await state.session.prompt(userPrompt(slot, state.spec && state.spec.noThink), {
    grammar: state.grammar, maxTokens: 700, temperature: 0.2,
    onTextChunk: () => {
      tokens++;
      const now = Date.now();
      if (!firstAt) { firstAt = now; log(`${slot.id}: started answering after ${((now - t0) / 1000).toFixed(1)} s`, true); }
      if (now - lastReport > 1500) {
        lastReport = now;
        log(`${slot.id}: writing… ${tokens} tokens, ${(tokens / Math.max(0.001, (now - firstAt) / 1000)).toFixed(1)} tokens/s`, true);
      }
    },
  });
  const secs = (Date.now() - t0) / 1000;
  log(`${slot.id}: finished in ${secs.toFixed(1)} s (${tokens} tokens${firstAt ? `, ${(tokens / Math.max(0.001, (Date.now() - firstAt) / 1000)).toFixed(1)} tokens/s` : ""})`, true);
  const parsed = state.grammar.parse(raw);
  return Array.isArray(parsed.candidates) ? parsed.candidates : [];
}

async function suggest({ character, clips, slot }) {
  if (!state) throw new Error("The matching model isn't loaded.");
  if (state.fake) {
    // Test hook: crash once, the way a graphics driver failure does.
    const marker = process.env.TTP_FAKE_CRASH_ONCE;
    if (marker && !require("fs").existsSync(marker)) { require("fs").writeFileSync(marker, "1"); process.exit(134); }
    const pick = clips.find((c) => !(slot.exclude || []).includes(c.id));
    return { candidates: pick ? [{ clip: pick.id, direction: slot.direction, intensity: slot.intensity, fit: "stretch", reason: "Fake suggestion for testing." }] : [] };
  }
  try {
    return { candidates: await ask(character, clips, slot) };
  } catch (err) {
    // GPU backends can fail mid-evaluation on some drivers. Fall back to
    // the CPU once, and tell the app so it starts there next time.
    if (state.llama.gpu && /eval has failed|decode|vk|vulkan|device/i.test(err.message)) {
      log(`GPU (${state.llama.gpu}) evaluation failed: ${err.message}. Retrying on the CPU.`);
      const { modelId, spec, dir } = state;
      await disposeRuntime();
      state = { modelId, spec, dir, gpuWanted: false, ...(await loadRuntime(spec, dir, false)) };
      return { candidates: await ask(character, clips, slot), fellBackToCpu: true };
    }
    throw err;
  }
}

process.parentPort.on("message", async (e) => {
  const msg = e.data || {};
  try {
    let result;
    if (msg.cmd === "probe") {
      const spec = ALL[msg.modelId];
      if (!spec) throw new Error(`Unknown model ${msg.modelId}.`);
      const ready = FAKE ? false : isDownloaded(msg.dir, spec);
      result = { downloaded: ready, sizeBytes: ready ? 0 : FAKE ? 2500 * 1024 * 1024 : await remoteSize(spec) };
    } else if (msg.cmd === "prepare") {
      result = await prepare(msg.modelId, msg.dir, msg.gpu !== false);
    } else if (msg.cmd === "selftest") {
      const { getLlama } = await import("node-llama-cpp");
      const llama = await getLlama({ gpu: "auto", build: "never" });
      result = { llama: "ok", gpu: llama.gpu || "cpu" };
    } else if (msg.cmd === "suggest") {
      result = await suggest(msg);
    } else {
      throw new Error(`Unknown command ${msg.cmd}`);
    }
    send({ id: msg.id, ok: true, result });
  } catch (err) {
    send({ id: msg.id, ok: false, error: (err && err.message) || String(err) });
  }
});
