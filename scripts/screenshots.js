// Regenerates the README screenshots in docs/screenshots/.
//
//   npm run screenshots
//
// Builds a demo project (scripts/demo-data.js: synthesized clips, original
// placeholder lines, a stand-in mod zip), then drives the real app through
// each step with file dialogs answered automatically and the models
// replaced by canned demo answers. Nothing is downloaded. On Linux without
// a display, run it under xvfb-run.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, dialog, BrowserWindow, nativeTheme } = require("electron");
const { build } = require("./demo-data");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-shots-"));
const demo = build(path.join(WORK, "demo"));

// Demo switches, set before the app (and its model processes) start.
process.env.TTP_FAKE_MODELS = "1";
process.env.TTP_DEMO_MODELS = demo.demoPath;
app.setPath("userData", path.join(WORK, "userdata"));
nativeTheme.themeSource = "light";

const opens = [
  { filePaths: [demo.modPath] },
  { filePaths: demo.zips },
  { filePaths: [demo.recipePath] },
];
dialog.showOpenDialog = async () => ({ canceled: false, ...(opens.shift() || { canceled: true, filePaths: [] }) });
dialog.showSaveDialog = async () => ({ canceled: true });
dialog.showMessageBox = async () => ({ response: 0 });

require(path.join(ROOT, "main.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await sleep(1200);
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1280, 800);
  await sleep(400);
  const js = (code) => win.webContents.executeJavaScript(code);
  const click = (sel, text) => js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) throw new Error("Not found: ${sel} ${text}");
    el.click();
  })()`);
  const until = async (code, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(code)) return; await sleep(200); }
    throw new Error(`Timed out waiting for: ${code}`);
  };
  const hideToast = () => js(`document.getElementById("toast").className = ""`);
  const shot = async (name) => {
    await sleep(350);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log(`saved docs/screenshots/${name}.png`);
  };

  try {
    // 1. Setup: mod, zips, an imported recipe applied.
    await click("button", "Choose mod zip…");
    await until(`!!document.querySelector(".fields input")`);
    await click("button", "Add audio zips…");
    await until(`document.querySelectorAll(".source").length === 2`);
    await click("button", "Import recipe file…");
    await until(`[...document.querySelectorAll(".recipes button")].some((b) => b.textContent === "Apply")`);
    await click(".recipes button", "Apply");
    await sleep(500);
    await hideToast();
    await shot("1-setup");

    // 2. Review opens with the offer to analyze clips.
    await js(`document.getElementById("start-review").click()`);
    await until(`document.getElementById("modal").open`);
    await shot("2-analyze");
    await click("dialog button", "Start");
    await until(`!document.querySelector(".asr-bar")`, 30000);

    // 3. Ask the matcher about one slot.
    await js(`document.querySelector('.slot[data-slot="faint_enemy"]').click()`);
    await click(".pick button", "Suggest for this slot…");
    await until(`document.getElementById("modal").open`);
    await shot("3-suggest");
    await click("dialog button", "Suggest picks");
    await until(`!document.querySelector(".asr-bar") && !!document.querySelector(".pick .transcript-edit")`, 30000);
    await hideToast();
    await shot("4-review");

    // 4. Editing a clip's transcript and emotion.
    await js(`(() => { const li = document.querySelector(".pool .clip"); [...li.querySelectorAll("button")].find((b) => b.textContent === "Edit").click(); })()`);
    await until(`document.getElementById("modal").open`);
    await shot("5-edit");
    await js(`document.getElementById("modal").close("no")`);

    // 5. The Activity panel.
    await js(`document.getElementById("activity-toggle").click()`);
    await sleep(400);
    await shot("6-activity");
    await js(`document.getElementById("activity-close").click()`);

    // 6. Export.
    await click("button", "Continue to export");
    await until(`!!document.querySelector(".export table")`);
    await shot("7-export");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  app.quit();
});
