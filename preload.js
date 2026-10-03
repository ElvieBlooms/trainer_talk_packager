// The only bridge between the window and the main process. The window gets
// these named calls and nothing else: no Node, no filesystem.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("packager", {
  appInfo: call("app:info"),
  openRepo: call("app:openRepo"),
  chooseMod: call("mod:choose"),
  addSources: call("sources:add"),
  updateSource: call("sources:update"),
  removeSource: call("sources:remove"),
  clipBytes: call("clip:bytes"),
  loadPack: call("pack:load"),
  matchPack: call("pack:match"),
  unloadPack: call("pack:unload"),
  listRecipes: call("recipes:list"),
  importRecipe: call("recipes:import"),
  applyRecipe: call("recipes:apply"),
  exportRecipe: call("recipes:export"),
  neededZips: call("recipes:needed"),
  planExport: call("export:plan"),
  writeExport: call("export:write"),
  revealFile: call("export:reveal"),
  saveSession: call("session:save"),
  openSession: call("session:open"),
  listModels: call("models:list"),
  selectModel: call("models:select"),
  probeModel: call("models:probe"),
  prepareModel: call("models:prepare"),
  unloadModel: call("models:unload"),
  setMatcherGpu: call("models:setGpu"),
  cachedAnalysis: call("analysis:cached"),
  saveFeatures: call("analysis:features"),
  saveManual: call("analysis:manual"),
  transcribe: call("analysis:transcribe"),
  emotion: call("analysis:emotion"),
  matchSlot: call("match:slot"),
  matchAssign: call("match:assign"),
  openLog: call("app:openLog"),
  selftest: call("models:selftest"),
  getActivity: call("activity:get"),
  postActivity: call("activity:post"),
  onActivity: (cb) => {
    const listener = (_e, entry) => cb(entry);
    ipcRenderer.on("activity:line", listener);
    return () => ipcRenderer.removeListener("activity:line", listener);
  },
  onModelProgress: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on("models:progress", listener);
    return () => ipcRenderer.removeListener("models:progress", listener);
  },
});
