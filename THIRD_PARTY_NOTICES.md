# Third-party notices

Trainer Talk Packager is MIT licensed. It bundles or downloads the following:

| Component | Use | License |
| --- | --- | --- |
| Electron | App framework | MIT |
| adm-zip | Reading and writing zips | MIT |
| wasm-media-encoders, including libvorbis and libogg compiled to WebAssembly | Converting WAV clips to Ogg Vorbis on export | MIT; libvorbis and libogg are BSD-3-Clause |
| transformers.js (`@huggingface/transformers`) | Runs the speech model | Apache 2.0 |
| ONNX Runtime (`onnxruntime-node`) | Model inference | MIT |
| sharp and libvips (dependency of transformers.js, not used for audio) | Image processing | Apache 2.0, LGPL 3.0 |
| node-llama-cpp and llama.cpp | Runs the matching model | MIT |
| OpenAI Whisper weights, ONNX conversions in `Xenova/whisper-base.en` and `Xenova/whisper-small.en` (Small uses the 8-bit encoder) | Speech to text, downloaded on first use | MIT |
| wav2vec2 emotion recognition (`onnx-community/wav2vec2-emotion-recognition-ONNX`, from `Dpngtm/wav2vec2-emotion-recognition`), downloaded on first use | Emotion labels | MIT (trained on TESS, CREMA-D, SAVEE, and RAVDESS, which have their own terms) |
| Qwen3 4B Instruct 2507, Q4_K_M GGUF (`unsloth/Qwen3-4B-Instruct-2507-GGUF`), downloaded on first use | Suggesting picks | Apache 2.0 |
| Qwen3 1.7B, Q4_K_M GGUF (`bartowski/Qwen_Qwen3-1.7B-GGUF`), downloaded on first use | Suggesting picks on low-memory computers | Apache 2.0 |

Each package's full license text ships in its folder under `node_modules`.
Check model licenses again before changing to a different model or version.
