// Delivery features measured straight from the audio, with no model:
// duration, loudness, and pitch. Intensity is then ranked within the pack,
// because "loud" for one character is quiet for another.
(function (root) {
  "use strict";
  const RATE = 16000;

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }

  function measure(samples) {
    const n = samples.length;
    const seconds = n / RATE;
    const frame = 320; // 20 ms
    const db = [];
    for (let i = 0; i + frame <= n; i += frame) {
      let sum = 0;
      for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
      db.push(10 * Math.log10(sum / frame + 1e-12));
    }
    if (!db.length) return { seconds: round(seconds, 2), loudness: -120, peak: -120, pitch: 0, pitchRange: 0, voiced: 0 };
    const peak = Math.max(...db);
    const activeIdx = db.map((d, i) => (d > peak - 30 ? i : -1)).filter((i) => i >= 0);
    const loudness = activeIdx.reduce((a, i) => a + db[i], 0) / activeIdx.length;

    // Pitch by autocorrelation on active 40 ms windows, 70–500 Hz.
    const win = 640;
    const minLag = Math.floor(RATE / 500);
    const maxLag = Math.floor(RATE / 70);
    const f0 = [];
    const track = new Array(db.length).fill(0); // per-frame pitch, 0 = unvoiced
    for (const idx of activeIdx) {
      const start = idx * frame;
      if (start + win + maxLag > n) continue;
      let energy = 0;
      for (let j = 0; j < win; j++) energy += samples[start + j] * samples[start + j];
      if (energy <= 0) continue;
      let best = 0;
      let bestLag = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0;
        let e2 = 0;
        for (let j = 0; j < win; j++) {
          const b = samples[start + j + lag];
          c += samples[start + j] * b;
          e2 += b * b;
        }
        const r = c / Math.sqrt(energy * e2 + 1e-12);
        if (r > best) { best = r; bestLag = lag; }
      }
      if (best > 0.6 && bestLag) { f0.push(RATE / bestLag); track[idx] = RATE / bestLag; }
    }
    f0.sort((a, b) => a - b);
    const pitch = f0.length ? percentile(f0, 0.5) : 0;
    const pitchRange = f0.length > 2 ? 12 * Math.log2(percentile(f0, 0.9) / percentile(f0, 0.1)) : 0;
    // The "print": loudness shape (normalized, so volume changes don't
    // matter) and pitch in semitones, one value per 20 ms.
    const mean = db.reduce((a, b) => a + b, 0) / db.length;
    const sd = Math.sqrt(db.reduce((a, b) => a + (b - mean) ** 2, 0) / db.length) || 1;
    const env = db.map((d) => round((Math.max(d, peak - 50) - mean) / sd, 2));
    const semis = track.map((hz) => (hz ? round(12 * Math.log2(hz / 100), 1) : 0));
    return {
      seconds: round(seconds, 2),
      loudness: round(loudness, 1),
      peak: round(peak, 1),
      pitch: Math.round(pitch),
      pitchRange: round(pitchRange, 1),
      voiced: round(f0.length / Math.max(1, activeIdx.length), 2),
      print: { env, semis },
    };
  }

  // How alike two clips sound, 0..1. Slides the shorter clip along the
  // longer one (so trimmed copies still line up) and compares loudness
  // shape and pitch movement at the best offset, plus overall length.
  function soundSimilarity(a, b) {
    if (!a || !b || !a.print || !b.print) return null;
    const A = a.print.env.length <= b.print.env.length ? a : b;
    const B = A === a ? b : a;
    const ea = A.print.env;
    const eb = B.print.env;
    const n = ea.length;
    if (n < 5) return null;
    const maxShift = Math.min(eb.length - Math.ceil(n * 0.6), eb.length - n + 25);
    let best = { r: -1, shift: 0 };
    for (let shift = -Math.min(25, Math.floor(n * 0.4)); shift <= Math.max(0, maxShift); shift++) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, k = 0;
      for (let i = 0; i < n; i++) {
        const j = i + shift;
        if (j < 0 || j >= eb.length) continue;
        const x = ea[i], y = eb[j];
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; k++;
      }
      if (k < n * 0.6) continue;
      const cov = sxy - (sx * sy) / k;
      const vx = sxx - (sx * sx) / k;
      const vy = syy - (sy * sy) / k;
      const r = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
      if (r > best.r) best = { r, shift };
    }
    // Pitch: share of frames voiced in both whose pitch is within a
    // semitone and a half at the best offset.
    let both = 0, close = 0;
    for (let i = 0; i < n; i++) {
      const j = i + best.shift;
      if (j < 0 || j >= eb.length) continue;
      const pa = A.print.semis[i], pb = B.print.semis[j];
      if (pa && pb) { both++; if (Math.abs(pa - pb) <= 1.5) close++; }
    }
    // A short clip can line up with part of a long one by chance, so the
    // shape score is weighed by how much of the longer clip it covers.
    const coverage = Math.min(1, Math.sqrt(n / eb.length));
    const shape = Math.max(0, best.r) * coverage;
    const lengthSim = Math.max(0, 1 - Math.abs(a.seconds - b.seconds) / Math.max(a.seconds, b.seconds, 0.01));
    const pitchAgree = both >= 5 ? close / both : null;
    const score = pitchAgree === null
      ? 0.75 * shape + 0.25 * lengthSim
      : 0.55 * shape + 0.3 * pitchAgree + 0.15 * lengthSim;
    return { score: round(score, 3), shape: round(shape, 2), pitch: pitchAgree === null ? null : round(pitchAgree, 2), length: round(lengthSim, 2) };
  }

  function round(x, d) {
    const k = 10 ** d;
    return Math.round(x * k) / k;
  }

  // Ranks clips within the pack: loudness counts most, then pitch height
  // and pitch movement. Returns { clipKey: 1..5 }.
  function intensities(featuresByKey) {
    const keys = Object.keys(featuresByKey);
    if (keys.length < 3) return Object.fromEntries(keys.map((k) => [k, 3]));
    const rank = (field) => {
      const sorted = keys.map((k) => featuresByKey[k][field] || 0).sort((a, b) => a - b);
      return (v) => {
        let lo = 0;
        while (lo < sorted.length && sorted[lo] < v) lo++;
        return lo / (sorted.length - 1);
      };
    };
    const rl = rank("loudness");
    const rp = rank("pitch");
    const rr = rank("pitchRange");
    const scores = keys.map((k) => {
      const f = featuresByKey[k];
      return [k, 0.5 * rl(f.loudness || 0) + 0.3 * rp(f.pitch || 0) + 0.2 * rr(f.pitchRange || 0)];
    });
    const sortedScores = scores.map((s) => s[1]).sort((a, b) => a - b);
    const cut = [0.2, 0.4, 0.6, 0.8].map((p) => percentile(sortedScores, p));
    return Object.fromEntries(scores.map(([k, s]) => [k, 1 + cut.filter((c) => s > c).length]));
  }

  const api = { measure, intensities, soundSimilarity, RATE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.features = api;
})(typeof window !== "undefined" ? window : this);
