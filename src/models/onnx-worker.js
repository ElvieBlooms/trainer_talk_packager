// Speech and emotion worker (utility process). The window decodes each
// clip to 16 kHz mono and sends the samples; this process downloads the
// models (with the app's own resumable downloader), loads them from disk,
// and runs them.
//
// In:  { id, cmd: "probe"|"prepare"|"transcribe"|"emotion", modelId, samples, dir }
// Out: { id, ok, result } | { id, ok: false, error } | { event: "progress", modelId, loaded, total }
const { ALL, classify } = require("./catalog");
const { downloadModel, isDownloaded, remoteSize } = require("./download");

const FAKE = process.env.TTP_FAKE_MODELS === "1"; // automated UI tests only
const os = require("os");
const pipes = {}; // kind -> { modelId, run }

// Lean ONNX Runtime settings: no memory arena or pattern caching (they
// trade a lot of memory for a little speed), and a few threads only, so
// low-end laptops stay responsive.
const SESSION_OPTIONS = {
  enableCpuMemArena: false,
  enableMemPattern: false,
  intraOpNumThreads: Math.max(1, Math.min(4, (os.cpus() || []).length - 1)),
  interOpNumThreads: 1,
};
let lib = null;

function send(msg) { process.parentPort.postMessage(msg); }
function log(line, quiet = false) { send({ event: "log", line: `models: ${line}`, quiet }); }

function transformers(dir) {
  if (!lib) {
    lib = require("@huggingface/transformers");
    lib.env.allowRemoteModels = false; // the app downloads; transformers.js only reads
    lib.env.allowLocalModels = true;
    lib.env.localModelPath = dir.endsWith("/") ? dir : dir + "/";
    lib.env.useFSCache = false;
  }
  return lib;
}

async function prepare(modelId, dir) {
  const spec = ALL[modelId];
  if (!spec || (spec.kind !== "speech" && spec.kind !== "emotion")) throw new Error(`Unknown model ${modelId}.`);
  if (pipes[spec.kind] && pipes[spec.kind].modelId === modelId) return { modelId };
  if (FAKE) {
    for (let i = 1; i <= 4; i++) {
      send({ event: "progress", modelId, loaded: i * 25, total: 100 });
      await new Promise((r) => setTimeout(r, 40));
    }
    pipes[spec.kind] = spec.kind === "speech"
      ? { modelId, run: async (s) => ({ text: ` Fake words for ${s.length} samples.` }) }
      : { modelId, run: async () => [{ label: "hap", score: 0.7 }, { label: "neu", score: 0.2 }, { label: "sad", score: 0.1 }] };
    return { modelId };
  }
  await downloadModel(dir, spec, { onProgress: (p) => send({ event: "progress", modelId, file: p.file, loaded: p.loaded, total: p.total }) });
  const t = transformers(dir);
  const t0 = Date.now();
  log(`loading ${spec.label} on the CPU with ${SESSION_OPTIONS.intraOpNumThreads} threads…`);
  if (spec.kind === "speech") {
    const pipe = await t.pipeline("automatic-speech-recognition", spec.repo, { dtype: spec.dtype, device: "cpu", local_files_only: true, session_options: SESSION_OPTIONS });
    pipes.speech = { modelId, run: pipe, dispose: () => pipe.dispose() };
    log(`${spec.label} loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s; memory in use ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
    return { modelId };
  }
  // Emotion: load the feature extractor and model directly. The
  // audio-classification pipeline also asks for a tokenizer.json, which
  // audio-only models don't ship.
  const extractor = await t.AutoFeatureExtractor.from_pretrained(spec.repo, { local_files_only: true });
  const model = await t.AutoModelForAudioClassification.from_pretrained(spec.repo, { dtype: spec.dtype, device: "cpu", local_files_only: true, session_options: SESSION_OPTIONS });
  const labels = model.config.id2label || {};
  pipes.emotion = {
    modelId,
    dispose: () => model.dispose(),
    run: async (samples) => {
      const inputs = await extractor(samples);
      const { logits } = await model(inputs);
      const probs = t.softmax(Array.from(logits.data));
      return probs.map((score, i) => ({ label: labels[i] || String(i), score }))
        .sort((a, b) => b.score - a.score);
    },
  };
  log(`${spec.label} loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s; memory in use ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  return { modelId };
}

const EMOTION_NAMES = { ang: "angry", dis: "disgust", fea: "fear", hap: "happy", neu: "neutral", sad: "sad", sur: "surprise" };
function emotionName(label) {
  const l = String(label).toLowerCase();
  return EMOTION_NAMES[l.slice(0, 3)] || l;
}

process.parentPort.on("message", async (e) => {
  const msg = e.data || {};
  try {
    let result;
    if (msg.cmd === "probe") {
      const spec = ALL[msg.modelId];
      if (!spec) throw new Error(`Unknown model ${msg.modelId}.`);
      const ready = FAKE ? false : isDownloaded(msg.dir, spec);
      result = { downloaded: ready, sizeBytes: ready ? 0 : FAKE ? 150 * 1024 * 1024 : await remoteSize(spec) };
    } else if (msg.cmd === "prepare") {
      result = await prepare(msg.modelId, msg.dir);
    } else if (msg.cmd === "unload") {
      const p = pipes[msg.kind];
      delete pipes[msg.kind];
      if (p && p.dispose) await p.dispose();
      if (p) log(`unloaded the ${msg.kind} model`);
      if (global.gc) global.gc();
      result = { unloaded: !!p };
    } else if (msg.cmd === "selftest") {
      const ort = require("onnxruntime-node");
      transformers(msg.dir);
      result = { onnx: "ok", backends: (ort.listSupportedBackends ? ort.listSupportedBackends() : []).filter((b) => b.bundled).map((b) => b.name) };
    } else if (msg.cmd === "transcribe") {
      if (!pipes.speech) throw new Error("The speech model isn't loaded.");
      const out = await pipes.speech.run(msg.samples, { return_timestamps: false });
      result = classify(out && out.text);
    } else if (msg.cmd === "emotion") {
      if (!pipes.emotion) throw new Error("The emotion model isn't loaded.");
      const out = await pipes.emotion.run(msg.samples);
      result = (Array.isArray(out) ? out : [out]).map((x) => ({ label: emotionName(x.label), score: Math.round(x.score * 1000) / 1000 }));
    } else {
      throw new Error(`Unknown command ${msg.cmd}`);
    }
    send({ id: msg.id, ok: true, result });
  } catch (err) {
    send({ id: msg.id, ok: false, error: (err && err.message) || String(err) });
  }
});
