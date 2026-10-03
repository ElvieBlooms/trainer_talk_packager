# Trainer Talk Packager

Builds voice packs for [Trainer Talk](https://github.com/ElvieBlooms/Trainer_Talk) from audio zips you download yourself. No audio ships with this app.

## How it works

1. **Set up.** Choose the Trainer Talk mod zip, pick a trainer or milestone pack, name it, and add one or more audio zips. Costume or variant zips for the same character all go into one shared pool.
2. **Review.** If a recipe matches your clips, its picks fill in automatically. Play any clip, swap picks, mark a pick as a stretch, or mark a slot as having no match.
3. **Export.** Get a pack folder zip to drop into an existing install, a full mod zip with the pack inside, or both. You can also save a recipe to share.

When you start reviewing, the app offers to analyze clips that haven't been analyzed yet:

- **Transcripts** from Whisper (Base or Small), so you can read and search what each clip says.
- **Emotion** from a wav2vec2 classifier: angry, disgust, fear, happy, neutral, sad, or surprise.
- **Intensity**, ranked 1 to 5 within the pack from loudness and pitch measured in the audio. This needs no download.

Then **Suggest picks** asks Qwen3 4B to propose clips for every open slot, each with a direction, intensity, and reason. Suggestions whose direction contradicts the slot are dropped, and slots with the fewest options choose first. Suggestions only fill open slots; your picks are never replaced.

You choose how much to run at once. **Analyze clips…** works on every clip without results, the clips shown in the list, or a single clip (the **Analyze** button on any clip), and can redo clips with a different model. **Suggest picks…** works on one slot, the open slots in a group, or every open slot. Only one model is in memory at a time: the speech model is unloaded before the emotion model loads, and both are unloaded before the matcher starts. Smaller runs don't lower the memory a model needs, but they keep each wait short and let you stop and pick up later.

**Edit** on any clip (or clicking the transcript in a pick) lets you correct the transcript, such as Pokémon names Whisper mishears, and set the emotion by ear. Edits are saved, win over model results, and survive re-analysis.

The matcher saves as it goes. Its reading of the clip list (the slow first step) is saved to disk and reused, and each slot's answer is saved the moment it arrives, so a stopped, crashed, or closed run picks up where it left off. Editing a transcript or emotion changes the clip list, so the next run reads it again.

The **Activity** button in the top bar opens a live, terminal-style panel showing what the app and its models are doing: downloads with speed, each clip as it's measured, transcribed, and labeled (with timings), the matcher reading the clip list and writing its answer (tokens per second), and any llama.cpp warnings. Copy it or open the full log file from the panel.

Everything runs on your computer. Each model downloads once from Hugging Face after you agree, resumes if interrupted, and is kept in the app's data folder. Results are cached, so the same zip is never analyzed twice. Problems are written to `packager.log` in the same folder.

## WAV files

Audio zips can hold `.ogg` or `.wav` clips (integer or float PCM, any sample rate). The mod plays Ogg Vorbis, so WAV picks are converted when you export (quality 5, about 160 kbps; more than two channels are mixed to stereo). Your zips aren't changed, and recipes record the original WAV file names. A pack built from WAV clips won't match the mod's existing Ogg files byte for byte, so rebuilding it uses transcripts or sound matching instead.

## Sessions

**Save session…** stores your picks, edits, and analysis, plus where the mod and audio zips were. Opening a session on another computer, or after moving files, looks next to the session file first, then asks you to locate anything still missing. A located zip is checked against the original; if it was repackaged, picks are found again by clip name and checksum.

A clip can fill more than one slot. The app warns you (in the slot list, on the pick, and before export) but doesn't stop you.

## Running it

From source (needs Node.js 20 or newer):

```
npm install
npm start
```

On Aurora or other immutable Fedora systems, `brew install node` works without layering packages. The included `.npmrc` skips ONNX Runtime's optional GPU downloads. The matcher uses your GPU through Vulkan when it can, and the CPU otherwise.

Build installers locally with `npm run dist:linux` (AppImage), `npm run dist:win` (Windows installer), or `npm run dist:mac` (DMG and zip). Each must run on its own platform, because the speech and matching models use native libraries.

## Releases

GitHub Actions builds every platform on its own runner: Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel (`.github/workflows/release.yml`).

1. Set `"version"` in `package.json` (for example `0.10.0`) and commit.
2. Tag and push: `git tag v0.10.0 && git push origin v0.10.0`. The tag must match the version.
3. When the workflow finishes, a **draft** release has every installer attached. Add notes and publish it.

To test a build without releasing, run the workflow from the Actions tab; the installers appear as downloadable artifacts.

The app icon lives in `build/icon.png` (1024×1024); electron-builder makes the Windows and macOS icon formats from it. A smaller copy in `src/renderer/assets/` is used for the window and the top bar.

The builds aren't code-signed. Windows SmartScreen may warn on first run (More info > Run anyway). On macOS, right-click the app and choose Open the first time, or run `xattr -dr com.apple.quarantine "/Applications/Trainer Talk Packager.app"`.

## Recipes

To turn a pack the mod already has into a recipe, choose it under **From a pack in the mod** in the Recipes panel and add the character's zips. Pack files copied straight from a zip match by checksum, instantly and exactly; files that were re-encoded or trimmed can be matched by transcript and length, or by sound: the shape of the loudness, how the pitch moves, and the length, compared at the best alignment so trimmed copies still line up. Clear winners are filled in as stretches; otherwise the closest clips are listed under the slot, and **Find closest by sound** reruns this for any one slot.

Milestone folders (`leaders`, `stadium`, and so on) work the same way. Exact matches tag your zips with their speaker automatically (one leader per zip, or an announcer when a zip covers several), and transcript and sound matching only consider each leader's own clips plus announcer zips. A clip the pack used for many slots, like a shared "Congratulations" outro, comes back shared. In review, each slot can play the pack's original file next to the pick. Then save the recipe from the Export step.


A recipe is a JSON file listing which clip goes in which slot. It has no audio. Recipes match clips by filename and checksum, so they keep working even if a zip is repackaged. Shared recipes live in [`recipes/`](recipes/); see [CONTRIBUTING.md](CONTRIBUTING.md) to add one. [NEEDED_ZIPS.md](NEEDED_ZIPS.md) lists the zips each recipe needs; regenerate it with `npm run needed-zips` after merging recipes. The packager shows the same list when saving a recipe (and can save it as a file beside the recipe), and the setup screen shows which of a recipe's zips are already loaded.

## Slot list

The app reads the slot list from the mod's `schema.json`. Mods without one use the built-in copy in [`schemas/`](schemas/), generated by `npm run schema`.

## Tests

```
npm test
```

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled and downloaded components.
