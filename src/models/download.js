// Downloads a model's files into <dir>/<repo>/, resumably. Each file is
// written to "<name>.part" and renamed only once its full size has
// arrived, and a ".complete" marker is written last. A model counts as
// downloaded only when that marker exists, so an interrupted download is
// never mistaken for a finished one.
const fs = require("fs");
const path = require("path");
const { HUB, fileUrl } = require("./catalog");

const STALL_MS = 60 * 1000;
const RETRIES = 5;

function modelDir(dir, spec) {
  return path.join(dir, ...spec.repo.split("/"));
}

function markerPath(dir, spec) {
  return path.join(modelDir(dir, spec), ".complete");
}

function isDownloaded(dir, spec) {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(dir, spec), "utf8"));
    return spec.files.every((f) => {
      const want = m.sizes && m.sizes[f];
      const p = path.join(modelDir(dir, spec), f);
      return want !== undefined && fs.existsSync(p) && fs.statSync(p).size === want;
    });
  } catch (_) {
    return false;
  }
}

// Total size from the Hub's file listing, or null if it can't be read.
async function remoteSize(spec, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${HUB}/api/models/${spec.repo}/tree/main?recursive=true`);
    if (!res.ok) return null;
    const list = await res.json();
    let total = 0;
    for (const f of [...spec.files, ...spec.optional]) {
      const e = list.find((x) => x.path === f);
      if (!e) { if (spec.files.includes(f)) return null; continue; }
      total += (e.lfs && e.lfs.size) || e.size || 0;
    }
    return total;
  } catch (_) {
    return null;
  }
}

class StallError extends Error {}

async function fetchOnce(url, partPath, onBytes, signal, fetchImpl) {
  let have = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal && signal.addEventListener("abort", onOuterAbort);
  let stallTimer = null;
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new StallError("No data received for 60 seconds.")), STALL_MS);
  };
  try {
    arm();
    const res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctrl.signal, redirect: "follow" });
    if (res.status === 404) return { notFound: true };
    if (res.status === 416) { // already complete
      return { total: have };
    }
    if (!res.ok) {
      const err = new Error(`Hugging Face answered ${res.status} for ${url.split("/resolve/main/")[1] || url}.`);
      err.permanent = res.status >= 400 && res.status < 500; // retrying won't help
      throw err;
    }
    let total;
    if (res.status === 206) {
      const m = /\/(\d+)$/.exec(res.headers.get("content-range") || "");
      total = m ? Number(m[1]) : undefined;
    } else {
      have = 0; // server ignored the range; start over
      const len = res.headers.get("content-length");
      total = len ? Number(len) : undefined;
    }
    const out = fs.createWriteStream(partPath, { flags: have ? "a" : "w" });
    onBytes(have, total);
    try {
      for await (const chunk of res.body) {
        arm();
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        have += chunk.length;
        onBytes(have, total);
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total !== undefined && have !== total) throw new Error(`Download ended early (${have} of ${total} bytes).`);
    return { total: have };
  } catch (err) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof StallError) throw ctrl.signal.reason;
    throw err;
  } finally {
    clearTimeout(stallTimer);
    signal && signal.removeEventListener("abort", onOuterAbort);
  }
}

// onProgress({ file, loaded, total }) — loaded/total cover the whole model.
async function downloadModel(dir, spec, { onProgress = () => {}, signal, fetchImpl = fetch } = {}) {
  const root = modelDir(dir, spec);
  if (isDownloaded(dir, spec)) return root;
  fs.mkdirSync(root, { recursive: true });
  try { fs.unlinkSync(markerPath(dir, spec)); } catch (_) { /* none */ }
  const expected = (await remoteSize(spec, fetchImpl)) || 0;
  const done = {};
  const sizes = {};
  const report = (file) => {
    const loaded = Object.values(done).reduce((a, b) => a + b, 0);
    onProgress({ file, loaded, total: Math.max(expected, loaded) });
  };
  for (const file of [...spec.files, ...spec.optional]) {
    const required = spec.files.includes(file);
    const final = path.join(root, file);
    const part = final + ".part";
    fs.mkdirSync(path.dirname(final), { recursive: true });
    let attempt = 0;
    let gotAny = false;
    for (;;) {
      if (signal && signal.aborted) throw new Error("Download stopped.");
      try {
        const r = await fetchOnce(fileUrl(spec.repo, file), part, (n) => { if (n) gotAny = true; done[file] = n; report(file); }, signal, fetchImpl);
        if (r.notFound) {
          if (required) throw new Error(`${file} is missing from ${spec.repo} on Hugging Face.`);
          break;
        }
        fs.renameSync(part, final);
        sizes[file] = fs.statSync(final).size;
        break;
      } catch (err) {
        attempt++;
        // Mid-download drops get several retries; a connection that never
        // delivered a byte fails fast so offline users aren't kept waiting.
        if ((signal && signal.aborted) || err.permanent || attempt > RETRIES
            || (!gotAny && attempt >= 2) || /missing from/.test(err.message)) {
          throw new Error(`Couldn't download ${file}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
      }
    }
  }
  fs.writeFileSync(markerPath(dir, spec), JSON.stringify({ repo: spec.repo, sizes, at: new Date().toISOString() }));
  return root;
}

module.exports = { downloadModel, isDownloaded, remoteSize, modelDir };
