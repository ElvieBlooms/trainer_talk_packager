// Every model the app can download. Files are fetched from the Hugging
// Face Hub on first use, only after the person agrees, and kept in the
// app's data folder.
const HUB = "https://huggingface.co";

const SPEECH = {
  "whisper-base.en": {
    kind: "speech",
    repo: "Xenova/whisper-base.en",
    label: "Whisper Base (English)",
    blurb: "Smaller and faster.",
    license: "MIT",
    ramMB: 900,
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    files: ["onnx/encoder_model.onnx", "onnx/decoder_model_merged_quantized.onnx",
      "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json"],
    optional: ["special_tokens_map.json", "added_tokens.json", "normalizer.json"],
  },
  "whisper-small.en": {
    kind: "speech",
    repo: "Xenova/whisper-small.en",
    label: "Whisper Small (English)",
    blurb: "More accurate, slower, larger download.",
    license: "MIT",
    ramMB: 1500,
    // 8-bit encoder: full precision needs more memory than low-end laptops have.
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    files: ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx",
      "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json"],
    optional: ["special_tokens_map.json", "added_tokens.json", "normalizer.json"],
  },
};

const EMOTION = {
  "wav2vec2-emotion": {
    kind: "emotion",
    repo: "onnx-community/wav2vec2-emotion-recognition-ONNX",
    label: "Emotion (wav2vec2, 7 emotions)",
    blurb: "Labels each clip angry, disgust, fear, happy, neutral, sad, or surprise.",
    license: "MIT",
    ramMB: 1200,
    dtype: "fp32",
    files: ["onnx/model.onnx", "config.json", "preprocessor_config.json"],
    optional: ["tokenizer_config.json", "vocab.json", "special_tokens_map.json"],
  },
};

const MATCHER = {
  "qwen3-4b-instruct": {
    kind: "matcher",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    label: "Qwen3 4B Instruct",
    blurb: "Better judgment. Needs a computer with plenty of free memory.",
    license: "Apache 2.0",
    ramMB: 4500,
    files: ["Qwen3-4B-Instruct-2507-Q4_K_M.gguf"],
    optional: [],
  },
  "qwen3-1.7b": {
    kind: "matcher",
    repo: "bartowski/Qwen_Qwen3-1.7B-GGUF",
    label: "Qwen3 1.7B",
    blurb: "Smaller and faster, for low-memory computers. Weaker judgment, so expect more stretches.",
    license: "Apache 2.0",
    ramMB: 2200,
    noThink: true, // hybrid thinking model; ask for direct answers
    files: ["Qwen_Qwen3-1.7B-Q4_K_M.gguf"],
    optional: [],
  },
};

const ALL = { ...SPEECH, ...EMOTION, ...MATCHER };
const DEFAULTS = { speech: "whisper-base.en", emotion: "wav2vec2-emotion", matcher: "qwen3-4b-instruct" };

function fileUrl(repo, file) {
  return `${HUB}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

// Whisper writes non-speech as bracketed tags, and sometimes returns
// nothing at all. Both are worth flagging in review.
function classify(raw) {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text || /^[\[(]?\s*(blank_audio|silence|no speech)\s*[\])]?$/i.test(text)) {
    return { text: "", flag: "no_words" };
  }
  if (/^[\[(*][^\])*]*[\])*]$/.test(text)) return { text, flag: "non_speech" };
  return { text, flag: "" };
}

module.exports = { HUB, SPEECH, EMOTION, MATCHER, ALL, DEFAULTS, fileUrl, classify };
