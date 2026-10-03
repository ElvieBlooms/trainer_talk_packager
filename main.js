// Electron main process. Owns every zip and every file write; the window
// only ever sees clip lists, review state, and clip bytes for playback.
const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } = require("electron");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { readModZip, readAudioZip } = require("./src/core/zips");
const { slotsFor } = require("./src/core/schema");
const { validateRecipe, matchRecipe, buildRecipe, neededZips, neededZipsText, MAX_RECIPE_BYTES } = require("./src/core/recipe");
const { planExport, writeExport } = require("./src/core/exporter");
const { ALL: MODELS, SPEECH, EMOTION, MATCHER, DEFAULTS } = require("./src/models/catalog");
const { splitSuggestions, assignFromSuggestions } = require("./src/core/assign");
const { matchPack } = require("./src/core/packmatch");
const AdmZip = require("adm-zip");
const { crcHex } = require("./src/core/zips");

const REPO_URL = "https://github.com/ElvieBlooms/Trainer_Talk";
const SESSION_FORMAT = 1;

let win = null;
let mod = null;                 // result of readModZip
const sources = new Map();      // sourceId -> { id, label, path, md5, speaker, zip, clips }
let nextSource = 1;
const importedRecipes = [];     // { id, recipe, warnings, origin }

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: "Trainer Talk Packager",
    icon: path.join(__dirname, "src", "renderer", "assets", "icon.png"), // window icon on Linux
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "src", "renderer", "index.html"));
  // Links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// Wraps a handler so errors come back as { error } instead of throwing
// across IPC, which would lose the message.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  });
}

// The reference pack (an existing pack read from the mod zip) is kept as
// a hidden source: its files can be played and transcribed, but they're
// never offered as picks or written to a recipe.
const REF_ID = "ref";

function allClips() {
  return [...sources.values()].filter((s) => !s.reference).flatMap((s) => s.clips);
}

function allClipsWithRef() {
  return [...sources.values()].flatMap((s) => s.clips);
}

function clipsByKey() {
  return Object.fromEntries(allClipsWithRef().map((c) => [c.key, c]));
}

function userSources() {
  return [...sources.values()].filter((s) => !s.reference);
}

function sourcePublic(s) {
  return { id: s.id, label: s.label, path: s.path, fileName: path.basename(s.path), md5: s.md5,
    speaker: s.speaker, skipped: s.skipped, clips: s.clips };
}

function readClipBytes(key) {
  const sourceId = key.split("::")[0];
  const s = sources.get(sourceId);
  if (!s) throw new Error("That clip's source zip is no longer loaded.");
  const entryName = key.slice(sourceId.length + 2);
  const entry = s.zip.getEntry(entryName);
  if (!entry) throw new Error("Clip not found in its zip.");
  return entry.getData();
}

function addSource(file, preset = {}) {
  const id = preset.id && !sources.has(preset.id) ? preset.id : `s${nextSource++}`;
  const { zip, clips, skipped, md5 } = readAudioZip(file, id);
  if (clips.length === 0) throw new Error(`${path.basename(file)} has no .ogg or .wav clips.`);
  const label = preset.label || path.basename(file, path.extname(file));
  const s = { id, label, path: file, md5, speaker: preset.speaker || "", zip, clips, skipped };
  sources.set(id, s);
  const n = parseInt(id.slice(1), 10);
  if (!Number.isNaN(n) && n >= nextSource) nextSource = n + 1;
  return sourcePublic(s);
}

// ---- bundled recipes ----

function bundledRecipeFiles() {
  const root = path.join(__dirname, "recipes");
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".json")) out.push(p);
    }
  };
  walk(root);
  return out;
}

function loadRecipeFile(file, origin) {
  const st = fs.statSync(file);
  if (st.size > MAX_RECIPE_BYTES) throw new Error(`${path.basename(file)} is larger than 512 KB.`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const { recipe, warnings } = validateRecipe(raw, mod.schema, st.size);
  return { id: `${origin}:${file}`, origin, fileName: path.basename(file), recipe, warnings };
}

// Each zip a recipe needs, and whether it's loaded: same MD5, or at least
// one of its picks found among the loaded clips.
function neededWithStatus(recipe) {
  const m = matchRecipe(recipe, allClips());
  const loadedMd5 = new Set(userSources().map((s) => s.md5));
  return neededZips(recipe).map((z) => ({
    ...z,
    loaded: (z.zip_md5 && loadedMd5.has(z.zip_md5)) || z.slots.some((slot) => m.assignments[slot]),
  }));
}

function recipeSummary(r) {
  const m = matchRecipe(r.recipe, allClips());
  return {
    needed: neededWithStatus(r.recipe),
    id: r.id, origin: r.origin, fileName: r.fileName, warnings: r.warnings,
    label: r.recipe.label, folder: r.recipe.folder, author: r.recipe.author, created: r.recipe.created,
    packType: r.recipe.pack_type, matched: m.matched, total: m.total,
    sources: r.recipe.sources.map((s) => s.label),
  };
}

function allRecipes(packType) {
  const list = [];
  const errors = [];
  for (const f of bundledRecipeFiles()) {
    try { list.push(loadRecipeFile(f, "bundled")); } catch (e) { errors.push(`${path.basename(f)}: ${e.message}`); }
  }
  list.push(...importedRecipes);
  return { list: list.filter((r) => r.recipe.pack_type === packType), errors };
}

// ---- IPC ----

handle("app:info", () => ({ version: app.getVersion(), repoUrl: REPO_URL }));
handle("app:openRepo", () => shell.openExternal(REPO_URL));

handle("mod:choose", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose the Trainer Talk mod zip",
    filters: [{ name: "Zip files", extensions: ["zip"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  mod = readModZip(r.filePaths[0]);
  importedRecipes.length = 0;
  return {
    path: mod.path, fileName: path.basename(mod.path), manifest: mod.manifest,
    schemaSource: mod.schemaSource, schema: mod.schema, existingPacks: mod.existingPacks,
    slots: Object.fromEntries(Object.keys(mod.schema.pack_types).map((t) => [t, slotsFor(mod.schema, t)])),
  };
});

handle("sources:add", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Add audio zips",
    filters: [{ name: "Zip files", extensions: ["zip"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (r.canceled) return { added: [], errors: [] };
  const added = [];
  const errors = [];
  for (const f of r.filePaths) {
    if (userSources().some((s) => s.path === f)) { errors.push(`${path.basename(f)} is already added.`); continue; }
    try { added.push(addSource(f)); } catch (e) { errors.push(e.message); }
  }
  return { added, errors };
});

handle("sources:update", (id, patch) => {
  const s = sources.get(id);
  if (!s) throw new Error("Unknown source.");
  if (typeof patch.label === "string") s.label = patch.label.slice(0, 80);
  if (typeof patch.speaker === "string") s.speaker = patch.speaker.slice(0, 40);
  return sourcePublic(s);
});

handle("sources:remove", (id) => { sources.delete(id); return true; });

handle("clip:bytes", (key) => readClipBytes(key));

// Reads an existing pack from the mod zip as the hidden reference source.
handle("pack:load", (packType, folder) => {
  if (!mod) throw new Error("Choose the mod zip first.");
  const def = mod.schema.pack_types[packType];
  if (!def || !/^[a-z0-9_]{1,40}$/.test(folder || "")) throw new Error("Unknown pack.");
  const slotIds = new Set(slotsFor(mod.schema, packType).map((s) => s.id));
  const zip = new AdmZip(mod.path);
  const prefix = `${mod.root}${def.root}/${folder}/`;
  const clips = [];
  let label = folder;
  let pairings = null;
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    const name = e.entryName.slice(prefix.length);
    if (name === "meta.json") { try { label = JSON.parse(zip.readAsText(e)).label || label; } catch (_) { /* no label */ } continue; }
    if (name === "pairings.json") { try { pairings = JSON.parse(zip.readAsText(e)); } catch (_) { /* unreadable */ } continue; }
    const slot = name.replace(/\.ogg$/i, "");
    if (name.includes("/") || !/\.ogg$/i.test(name) || !slotIds.has(slot)) continue;
    clips.push({ key: `${REF_ID}::${e.entryName}`, sourceId: REF_ID, entryName: e.entryName, name, slot, crc: crcHex(e), size: e.header.size });
  }
  if (!clips.length) throw new Error(`The "${folder}" pack has no slot files.`);
  sources.set(REF_ID, { id: REF_ID, label: `${label} (from the mod)`, path: mod.path, md5: "", speaker: "", zip, clips, skipped: 0, reference: true });
  log(`loaded the "${folder}" pack from the mod: ${clips.length} slot files${pairings ? ", with pairings.json" : ""}`);
  return { label, folder, clips, hasPairings: !!pairings };
});

handle("pack:match", (opts) => {
  const ref = sources.get(REF_ID);
  if (!ref) throw new Error("Load a pack first.");
  const r = matchPack(ref.clips, allClips(), opts || {});
  log(`pack match: ${Object.keys(r.exact).length} exact, ${Object.keys(r.similar).length} by transcript, ${r.unmatched.length} unmatched`);
  return r;
});

handle("pack:unload", () => { sources.delete(REF_ID); return true; });

handle("recipes:list", (packType) => {
  if (!mod) throw new Error("Choose the mod zip first.");
  const { list, errors } = allRecipes(packType);
  return { recipes: list.map(recipeSummary).sort((a, b) => b.matched - a.matched), errors };
});

handle("recipes:import", async () => {
  if (!mod) throw new Error("Choose the mod zip first.");
  const r = await dialog.showOpenDialog(win, {
    title: "Import a recipe",
    filters: [{ name: "Recipe files", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const loaded = loadRecipeFile(r.filePaths[0], "imported");
  const i = importedRecipes.findIndex((x) => x.id === loaded.id);
  if (i >= 0) importedRecipes[i] = loaded; else importedRecipes.push(loaded);
  return recipeSummary(loaded);
});

handle("recipes:apply", (id, packType) => {
  const r = allRecipes(packType).list.find((x) => x.id === id);
  if (!r) throw new Error("That recipe is no longer available.");
  const m = matchRecipe(r.recipe, allClips());
  return { ...m, label: r.recipe.label, folder: r.recipe.folder, warnings: r.warnings };
});

function recipeFromState(state, opts) {
  const srcs = userSources().map((s, i) => ({
    id: s.id, recipeId: `source${i + 1}`, label: s.label, md5: s.md5, clipCount: s.clips.length, fileName: path.basename(s.path),
  }));
  return buildRecipe({
    schema: mod.schema, packType: state.packType, label: state.label, folder: state.folder,
    author: opts.author, sources: srcs, clipsByKey: clipsByKey(), assignments: state.assignments,
    empty: state.empty, transcripts: state.transcripts || {}, includeTranscripts: !!opts.includeTranscripts,
  });
}

handle("recipes:needed", (state) => {
  if (!mod) throw new Error("Choose the mod zip first.");
  return neededZips(recipeFromState(state, {}));
});

handle("recipes:export", async (state, opts) => {
  const recipe = recipeFromState(state, opts);
  const r = await dialog.showSaveDialog(win, {
    title: "Save recipe",
    defaultPath: `${state.folder || "pack"}_${(opts.author || "recipe").toLowerCase().replace(/[^a-z0-9_-]/g, "")}.json`,
    filters: [{ name: "Recipe files", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(recipe, null, 2) + "\n");
  const written = [r.filePath];
  if (opts.neededList) {
    const listPath = r.filePath.replace(/\.json$/i, "") + ".needed-zips.md";
    fs.writeFileSync(listPath, neededZipsText(recipe));
    written.push(listPath);
  }
  log(`saved recipe ${path.basename(r.filePath)}${opts.neededList ? " with its list of needed zips" : ""}`);
  return written;
});

function planFrom(state) {
  return planExport({
    schema: mod.schema, packType: state.packType, folder: state.folder, label: state.label,
    assignments: state.assignments, empty: state.empty, clipsByKey: clipsByKey(),
    sources: userSources(),
  });
}

handle("export:plan", (state) => {
  if (!mod) throw new Error("Choose the mod zip first.");
  return planFrom(state);
});

handle("export:write", async (state, formats) => {
  const plan = planFrom(state);
  if (!plan.ok) throw new Error(plan.errors.join(" "));
  const r = await dialog.showOpenDialog(win, {
    title: "Choose where to save",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const written = await writeExport({
    plan, sources: userSources(), readClip: readClipBytes, mod, outDir: r.filePaths[0], formats,
    onProgress: (line) => log(line, true),
  });
  log(`exported ${written.map((f) => path.basename(f)).join(", ")}${plan.converted ? ` (${plan.converted} WAV clips converted to Ogg Vorbis)` : ""}`);
  return written;
});

handle("export:reveal", (file) => shell.showItemInFolder(file));

// ---- sessions ----
// A session stores the zip paths and review state, never audio. Reopening
// one re-reads the original zips.

handle("session:save", async (state) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Save session",
    defaultPath: `${state.folder || "pack"}.ttpsession`,
    filters: [{ name: "Packager sessions", extensions: ["ttpsession"] }],
  });
  if (r.canceled || !r.filePath) return null;
  // Clip names and checksums let a shared session find its picks again
  // even if a zip was repackaged with different folders inside.
  const clipMeta = Object.fromEntries(allClips().map((c) => [c.key, { name: c.name, crc: c.crc, sourceId: c.sourceId }]));
  const data = {
    session_format: SESSION_FORMAT,
    modId: mod && mod.manifest.id,
    clipMeta,
    modPath: mod && mod.path,
    sources: userSources().map((s) => ({ id: s.id, label: s.label, path: s.path, md5: s.md5, speaker: s.speaker })),
    state,
  };
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
});

// Finds a file the session points to. Tries the saved path, then the
// session file's folder and any folder a file was already found in, then
// asks the person to locate it. Located zips are checked against the
// saved checksum, so a wrong file isn't picked up silently.
async function locate({ savedPath, md5, what, required, searchDirs, check }) {
  const base = path.basename(savedPath || "");
  const tried = [savedPath, ...searchDirs.map((d) => path.join(d, base))].filter(Boolean);
  for (const p of tried) {
    if (fs.existsSync(p)) {
      if (p !== savedPath) log(`found ${base} at ${p} (the session said ${savedPath})`);
      return p;
    }
  }
  for (;;) {
    const ask = await dialog.showMessageBox(win, {
      type: "question",
      title: `Locate ${what}`,
      message: `Where is ${base}?`,
      detail: `The session used ${what} at:\n${savedPath}\n\nThat file isn't there${searchDirs.length ? " or next to the session file" : ""}. If it was moved or this session came from someone else, show the app where it is.`,
      buttons: ["Locate…", required ? "Cancel" : "Skip this zip"],
      defaultId: 0,
      cancelId: 1,
    });
    if (ask.response !== 0) return null;
    const pick = await dialog.showOpenDialog(win, {
      title: `Locate ${base}`,
      defaultPath: searchDirs[0] || undefined,
      filters: [{ name: "Zip files", extensions: ["zip"] }],
      properties: ["openFile"],
    });
    if (pick.canceled || !pick.filePaths[0]) continue;
    const chosen = pick.filePaths[0];
    let problem = null;
    try { problem = check ? check(chosen) : null; } catch (e) { problem = e.message; }
    if (!problem && md5) {
      const actual = require("crypto").createHash("md5").update(fs.readFileSync(chosen)).digest("hex");
      if (actual !== md5) problem = "Its contents differ from the zip the session used. Picks are matched by clip name and checksum, so most should still line up, but some may not.";
    }
    if (problem) {
      const warn = await dialog.showMessageBox(win, {
        type: "warning", title: "Not the same file", message: `${path.basename(chosen)} may not be the right file.`,
        detail: problem, buttons: ["Use it anyway", "Choose another"], defaultId: 1, cancelId: 1,
      });
      if (warn.response !== 0) continue;
    }
    log(`located ${base} at ${chosen}`);
    return chosen;
  }
}

handle("session:open", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Open session",
    filters: [{ name: "Packager sessions", extensions: ["ttpsession"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const data = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8"));
  if (data.session_format !== SESSION_FORMAT) throw new Error("This session file is from a different app version.");
  const searchDirs = [path.dirname(r.filePaths[0])];
  const remember = (p) => { const d = path.dirname(p); if (!searchDirs.includes(d)) searchDirs.push(d); };

  const modPath = await locate({
    savedPath: data.modPath, what: "the mod zip", required: true, searchDirs,
    check: (p) => {
      const m = readModZip(p);
      return data.modId && m.manifest.id !== data.modId ? `It's the "${m.manifest.name}" mod, not "${data.modId}".` : null;
    },
  });
  if (!modPath) return null;
  remember(modPath);
  mod = readModZip(modPath);
  sources.clear();
  nextSource = 1;
  const problems = [];
  const loaded = [];
  for (const s of data.sources || []) {
    const found = await locate({ savedPath: s.path, md5: s.md5, what: `the audio zip "${s.label}"`, required: false, searchDirs });
    if (!found) { problems.push(`Skipped ${path.basename(s.path)}; its picks were dropped.`); continue; }
    remember(found);
    const pub = addSource(found, { id: s.id, label: s.label, speaker: s.speaker });
    loaded.push(pub);
  }
  return {
    mod: {
      path: mod.path, fileName: path.basename(mod.path), manifest: mod.manifest, schemaSource: mod.schemaSource,
      schema: mod.schema, existingPacks: mod.existingPacks,
      slots: Object.fromEntries(Object.keys(mod.schema.pack_types).map((t) => [t, slotsFor(mod.schema, t)])),
    },
    sources: loaded,
    state: data.state,
    clipMeta: data.clipMeta || {},
    problems,
  };
});

// ---- models: transcription, emotion, matching ----
// Two utility processes: one for the ONNX models (speech, emotion), one
// for the llama.cpp matcher. Nothing downloads until the window asks,
// and the window only asks after the person agrees. Results are cached by
// model, clip name, and CRC, so the same zip is never analyzed twice.

const workers = {};
let llmOnGpu = false;
let rpcNext = 1;
const rpcPending = new Map();

function userFile(name) {
  return path.join(app.getPath("userData"), name);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
// Everything the app does is logged here: to packager.log on disk, and
// live to the Activity panel. `quiet` lines (fast-changing progress) go to
// the panel only, so the log file stays readable.
const activity = [];
function emit(line) {
  const entry = { t: Date.now(), line: String(line).slice(0, 2000) };
  activity.push(entry);
  if (activity.length > 1500) activity.splice(0, activity.length - 1500);
  if (win && !win.isDestroyed()) win.webContents.send("activity:line", entry);
}
function log(line, quiet = false) {
  emit(line);
  if (quiet) return;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.appendFileSync(userFile("packager.log"), `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* logging is best-effort */ }
}

// Download progress arrives many times a second; the panel gets one line
// every two seconds per file, with speed.
const dlState = {};
function logDownload(msg) {
  const key = `${msg.modelId}|${msg.file || ""}`;
  const now = Date.now();
  const st = dlState[key] || (dlState[key] = { t: now, loaded: msg.loaded, last: 0 });
  const done = msg.total && msg.loaded >= msg.total;
  if (!done && now - st.last < 2000) return;
  const mbps = (msg.loaded - st.loaded) / 1048576 / Math.max(0.001, (now - st.t) / 1000);
  st.t = now; st.loaded = msg.loaded; st.last = now;
  const pct = msg.total ? Math.round((msg.loaded / msg.total) * 100) : 0;
  log(`download ${msg.modelId}${msg.file ? " " + msg.file : ""}: ${pct}% (${(msg.loaded / 1048576).toFixed(1)} of ${(msg.total / 1048576).toFixed(1)} MB${done ? "" : `, ${mbps.toFixed(1)} MB/s`})`, !done);
}

let settings = null;
function getSettings() {
  if (!settings) settings = readJson(userFile("settings.json"), {});
  if (!SPEECH[settings.speech]) settings.speech = DEFAULTS.speech;
  if (!EMOTION[settings.emotion]) settings.emotion = DEFAULTS.emotion;
  if (!MATCHER[settings.matcher]) settings.matcher = DEFAULTS.matcher;
  return settings;
}
let analysis = null;
function getAnalysis() {
  if (!analysis) analysis = readJson(userFile("analysis.json"), {});
  return analysis;
}
let analysisTimer = null;
function saveAnalysisSoon() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => writeJson(userFile("analysis.json"), analysis), 500);
}

function workerFor(kind) {
  const name = kind === "matcher" ? "llm" : "onnx";
  if (workers[name]) return workers[name];
  const file = name === "llm" ? "llm-worker.js" : "onnx-worker.js";
  const w = utilityProcess.fork(path.join(__dirname, "src", "models", file), [], {
    serviceName: `Trainer Talk Packager ${name}`,
    env: { ...process.env },
  });
  w.on("message", (msg) => {
    if (msg && msg.event === "log") { log(msg.line, !!msg.quiet); return; }
    if (msg && msg.event === "progress") {
      logDownload(msg);
      if (win && !win.isDestroyed()) win.webContents.send("models:progress", msg);
      return;
    }
    const p = rpcPending.get(msg && msg.id);
    if (!p) return;
    rpcPending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else { log(`${name} error: ${msg.error}`); p.reject(new Error(msg.error)); }
  });
  w.on("exit", (code) => {
    log(`${name} worker exited with code ${code}`);
    const gpuCrash = name === "llm" && code && llmOnGpu;
    if (name === "llm") llmOnGpu = false;
    if (gpuCrash) {
      // A graphics driver crash takes the whole process down, so it can't
      // be caught inside the worker. Remember it and use the CPU from now on.
      getSettings().matcherGpu = false;
      writeJson(userFile("settings.json"), settings);
      log("matcher crashed while on the GPU; switched to the CPU for future runs");
    }
    for (const [id, p] of rpcPending) {
      if (p.worker === name) {
        p.reject(new Error(!code ? "The model process stopped."
          : gpuCrash ? "The graphics driver crashed while running the matcher. The app switched it to the CPU."
          : `The ${name === "llm" ? "matching model" : "speech or emotion model"} crashed, most likely because the computer ran out of memory. Close other apps, or choose a smaller model.`));
        rpcPending.delete(id);
      }
    }
    if (workers[name] === w) workers[name] = null; // a replacement may already be running
  });
  workers[name] = w;
  return w;
}

function rpc(kind, cmd, payload = {}) {
  const id = rpcNext++;
  const worker = kind === "matcher" ? "llm" : "onnx";
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve, reject, worker });
    workerFor(kind).postMessage({ id, cmd, dir: userFile("models"), ...payload });
  });
}

function cacheKey(prefix, model, clip) {
  return `${prefix}:${model}|${clip.name}|${clip.crc}`;
}

handle("models:list", () => {
  const st = getSettings();
  const list = (group) => Object.entries(group).map(([id, m]) => ({ id, label: m.label, blurb: m.blurb, license: m.license, ramMB: m.ramMB }));
  const os = require("os");
  return {
    // The screenshot demo shows a typical machine, not the one it runs on.
    memory: process.env.TTP_DEMO_MODELS ? { totalMB: 16384, freeMB: 11000 }
      : { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) },
    speech: list(SPEECH), emotion: list(EMOTION), matcher: list(MATCHER),
    selected: { speech: st.speech, emotion: st.emotion, matcher: st.matcher },
    matcherGpu: st.matcherGpu === true,
  };
});

handle("models:select", (kind, id) => {
  const group = { speech: SPEECH, emotion: EMOTION, matcher: MATCHER }[kind];
  if (!group || !group[id]) throw new Error("Unknown model.");
  getSettings()[kind] = id;
  writeJson(userFile("settings.json"), settings);
  return id;
});

handle("models:setGpu", (on) => {
  getSettings().matcherGpu = !!on;
  writeJson(userFile("settings.json"), settings);
  stopWorker("llm"); // reload on the chosen device next time
  return !!on;
});

handle("models:probe", (id) => {
  const spec = MODELS[id];
  if (!spec) throw new Error("Unknown model.");
  return rpc(spec.kind, "probe", { modelId: id });
});

function stopWorker(name) {
  const w = workers[name];
  if (!w) return;
  workers[name] = null;
  try { w.kill(); } catch (_) { /* already gone */ }
  log(`stopped ${name} worker to free memory`);
}

// Only one kind of model is kept in memory: loading the matcher stops the
// speech/emotion process, and the other way round.
handle("models:unload", async (kind) => {
  if (kind === "matcher") { stopWorker("llm"); return true; }
  if (workers.onnx) await rpc(kind, "unload", { kind });
  return true;
});

handle("models:prepare", async (id) => {
  const spec = MODELS[id];
  if (!spec) throw new Error("Unknown model.");
  stopWorker(spec.kind === "matcher" ? "onnx" : "llm");
  log(`preparing ${id} (${spec.repo})`);
  const r = await rpc(spec.kind, "prepare", { modelId: id, gpu: getSettings().matcherGpu === true });
  if (spec.kind === "matcher") llmOnGpu = !!r.gpu && r.gpu !== "cpu" && r.gpu !== "fake";
  log(`ready ${id} ${JSON.stringify(r)}`);
  return r;
});

handle("analysis:cached", (clipKeys) => {
  const st = getSettings();
  const cache = getAnalysis();
  const byKey = clipsByKey();
  const out = {};
  for (const k of clipKeys) {
    const clip = byKey[k];
    if (!clip) continue;
    const entry = {
      speech: cache[cacheKey("speech", st.speech, clip)],
      emotion: cache[cacheKey("emotion", st.emotion, clip)],
      features: cache[cacheKey("features", "v2", clip)],
      manual: cache[cacheKey("manual", "v1", clip)],
    };
    if (entry.speech || entry.emotion || entry.features || entry.manual) out[k] = entry;
  }
  return out;
});

handle("analysis:features", (clipKey, features) => {
  const clip = clipsByKey()[clipKey];
  if (!clip || !features || typeof features !== "object") return false;
  getAnalysis()[cacheKey("features", "v2", clip)] = features;
  saveAnalysisSoon();
  return true;
});

// Hand edits (a corrected transcript, a chosen emotion) are stored per
// clip and always win over model results.
handle("analysis:manual", (clipKey, edit) => {
  const clip = clipsByKey()[clipKey];
  if (!clip || !edit || typeof edit !== "object") throw new Error("That clip is no longer loaded.");
  const k = cacheKey("manual", "v1", clip);
  const cur = { ...(getAnalysis()[k] || {}) };
  if ("text" in edit) { if (typeof edit.text === "string") cur.text = edit.text.slice(0, 600); else delete cur.text; }
  if ("emotion" in edit) { if (typeof edit.emotion === "string" && edit.emotion) cur.emotion = edit.emotion.slice(0, 20); else delete cur.emotion; }
  if (Object.keys(cur).length) getAnalysis()[k] = cur; else delete getAnalysis()[k];
  saveAnalysisSoon();
  log(`edited ${clip.name}: ${"text" in edit ? `transcript ${edit.text === null ? "reverted" : `"${cur.text}"`}` : ""}${"emotion" in edit ? ` emotion ${cur.emotion || "back to the model's label"}` : ""}`, true);
  return cur;
});

function checkSamples(clipKey, samples) {
  const clip = clipsByKey()[clipKey];
  if (!clip) throw new Error("That clip is no longer loaded.");
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error("No audio samples received.");
  return clip;
}

handle("analysis:transcribe", async (clipKey, samples) => {
  const clip = checkSamples(clipKey, samples);
  const model = getSettings().speech;
  const t0 = Date.now();
  const r = await rpc("speech", "transcribe", { samples });
  log(`transcribed ${clip.name} (${(samples.length / 16000).toFixed(1)} s of audio) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${r.flag ? `[${r.flag}] ` : ""}"${r.text}"`, true);
  const entry = { text: r.text, flag: r.flag };
  getAnalysis()[cacheKey("speech", model, clip)] = entry;
  saveAnalysisSoon();
  return entry;
});

handle("analysis:emotion", async (clipKey, samples) => {
  const clip = checkSamples(clipKey, samples);
  const model = getSettings().emotion;
  const t0 = Date.now();
  const r = await rpc("emotion", "emotion", { samples });
  log(`emotion ${clip.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${r.slice(0, 3).map((x) => `${x.label} ${Math.round(x.score * 100)}%`).join(", ")}`, true);
  getAnalysis()[cacheKey("emotion", model, clip)] = r;
  saveAnalysisSoon();
  return r;
});

// Asks the matcher about one slot. Returns the filtered candidate list;
// the window collects these and calls match:assign at the end.
handle("match:slot", async (payload) => {
  const { character, slot, clips, exclude, fresh } = payload;
  // Each slot's answer is saved as soon as it arrives, keyed by model,
  // clip list, slot, and exclusions, so an interrupted run skips the slots
  // it already finished.
  const model = getSettings().matcher;
  const key = "match:" + crypto.createHash("sha1").update(JSON.stringify([model, character, clips, slot, exclude || []])).digest("hex");
  let raw = !fresh && getAnalysis()[key];
  if (raw) {
    log(`match ${slot.id}: reused the saved answer`, true);
  } else {
    raw = await rpc("matcher", "suggest", { character, clips, slot: { ...slot, exclude } });
    if (raw && Array.isArray(raw.candidates)) {
      getAnalysis()[key] = { candidates: raw.candidates };
      saveAnalysisSoon();
    }
  }
  if (raw && raw.fellBackToCpu) llmOnGpu = false;
  if (raw && raw.fellBackToCpu && getSettings().matcherGpu === true) {
    settings.matcherGpu = false; // remembered, so next time starts on the CPU
    writeJson(userFile("settings.json"), settings);
  }
  const valid = new Set(clips.map((c) => c.id));
  const cands = raw && Array.isArray(raw.candidates) ? raw.candidates : [];
  const split = splitSuggestions(slot, cands, valid);
  log(`match ${slot.id}: ${cands.length} returned, ${split.kept.length} kept, ${split.flagged.length} wrong direction, ${split.unknown} unknown clip ids. Raw: ${JSON.stringify(cands).slice(0, 600)}`);
  return { ...split, returned: cands.length };
});

handle("match:assign", (slots, suggestions, taken) => assignFromSuggestions(slots, suggestions, new Set(taken)));

handle("models:selftest", async () => {
  const out = {};
  for (const kind of ["speech", "matcher"]) {
    try { out[kind] = await rpc(kind, "selftest"); } catch (e) { out[kind] = { error: e.message }; }
  }
  log(`selftest ${JSON.stringify(out)}`);
  return out;
});

handle("activity:get", () => activity.slice(-500));
handle("activity:post", (line) => { if (typeof line === "string") log(line.slice(0, 500), true); return true; });

handle("app:openLog", () => shell.openPath(userFile("packager.log")));

app.on("before-quit", () => {
  if (analysis) writeJson(userFile("analysis.json"), analysis);
  for (const w of Object.values(workers)) if (w) w.kill();
});
