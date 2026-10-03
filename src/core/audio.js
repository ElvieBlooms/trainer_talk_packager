// Converts WAV clips to Ogg Vorbis at export. The mod loads "<slot>.ogg"
// by name, so every exported file must really be Ogg Vorbis. Encoding is
// done by libvorbis compiled to WebAssembly (wasm-media-encoders), so no
// native library or external tool is needed on any platform.

const OGG_QUALITY = 5; // Vorbis VBR quality 0..10; 5 is roughly 160 kbps, ample for voice

function isWav(name) {
  return /\.wav$/i.test(name || "");
}

// Reads a RIFF/WAVE file. Supports integer PCM (8, 16, 24, 32 bit), IEEE
// float (32, 64 bit), and WAVE_FORMAT_EXTENSIBLE wrapping either. Returns
// { sampleRate, channels: Float32Array[] } with samples in -1..1.
function parseWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 12 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      let format = b.readUInt16LE(body);
      const channels = b.readUInt16LE(body + 2);
      const sampleRate = b.readUInt32LE(body + 4);
      const bits = b.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 40) format = b.readUInt16LE(body + 24); // extensible: sub-format GUID starts with the real code
      fmt = { format, channels, sampleRate, bits };
    } else if (id === "data") {
      data = b.subarray(body, Math.min(b.length, body + size));
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("The WAV file has no format or audio data.");
  const { format, channels, sampleRate, bits } = fmt;
  if (!channels || !sampleRate) throw new Error("The WAV file's header is invalid.");
  const bytes = bits / 8;
  if (![1, 3].includes(format) || !Number.isInteger(bytes)) {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit). Re-save it as PCM.`);
  }
  const frames = Math.floor(data.length / (bytes * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      let v;
      if (format === 3) v = bits === 64 ? data.readDoubleLE(p) : data.readFloatLE(p);
      else if (bits === 8) v = (data.readUInt8(p) - 128) / 128;
      else if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (bits === 32) v = data.readInt32LE(p) / 2147483648;
      else throw new Error(`Unsupported WAV bit depth (${bits}).`);
      out[c][i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return { sampleRate, channels: out };
}

// The encoder takes one or two channels; anything more is mixed to stereo.
function toStereoOrMono(channels) {
  if (channels.length <= 2) return channels;
  const n = channels[0].length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let c = 0; c < channels.length; c++) {
    const target = c % 2 === 0 ? left : right;
    const src = channels[c];
    for (let i = 0; i < n; i++) target[i] += src[i];
  }
  const share = Math.ceil(channels.length / 2);
  for (let i = 0; i < n; i++) { left[i] /= share; right[i] /= share; }
  return [left, right];
}

let encoderPromise = null;
function encoder() {
  if (!encoderPromise) encoderPromise = require("wasm-media-encoders").createOggEncoder();
  return encoderPromise;
}

// Encoding is serialized: one encoder instance, one clip at a time.
let queue = Promise.resolve();
function wavToOgg(wavBuffer, quality = OGG_QUALITY) {
  const job = queue.then(async () => {
    const { sampleRate, channels } = parseWav(wavBuffer);
    const chans = toStereoOrMono(channels);
    const enc = await encoder();
    enc.configure({ channels: chans.length, sampleRate, vbrQuality: quality });
    const parts = [];
    const step = 8192;
    for (let i = 0; i < chans[0].length; i += step) {
      const chunk = enc.encode(chans.map((c) => c.subarray(i, i + step)));
      if (chunk.length) parts.push(Buffer.from(chunk)); // copy: the encoder reuses its buffer
    }
    const tail = enc.finalize();
    if (tail.length) parts.push(Buffer.from(tail));
    return Buffer.concat(parts);
  });
  queue = job.catch(() => {});
  return job;
}

module.exports = { isWav, parseWav, wavToOgg, OGG_QUALITY };
