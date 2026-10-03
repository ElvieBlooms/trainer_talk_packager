// The Activity panel: a live, terminal-style view of what the app and its
// models are doing. Lines come from the main process (workers, downloads,
// timings) and from this window (decoding, measuring). Kept outside the
// main render loop so it never interrupts typing.
(() => {
  "use strict";
  const api = window.packager;
  const panel = document.getElementById("activity");
  const pre = document.getElementById("activity-lines");
  const toggle = document.getElementById("activity-toggle");
  const follow = document.getElementById("activity-follow");
  const MAX = 1500;
  let lines = [];

  function stamp(t) {
    const d = new Date(t);
    return d.toTimeString().slice(0, 8);
  }
  function classFor(line) {
    if (/error|failed|crash|couldn't|exited with code [1-9]|device lost/i.test(line)) return "a-err";
    if (/^llama\.cpp|warn/i.test(line)) return "a-warn";
    if (/^(download|preparing|ready|stopped|loaded|loading)/i.test(line) || /loaded in|unloaded/.test(line)) return "a-info";
    return "";
  }
  function row(entry) {
    const div = document.createElement("div");
    div.className = classFor(entry.line.replace(/^(llm|models): /, ""));
    const ts = document.createElement("span");
    ts.className = "a-time";
    ts.textContent = stamp(entry.t) + " ";
    div.append(ts, document.createTextNode(entry.line));
    return div;
  }
  function add(entry) {
    lines.push(entry);
    if (lines.length > MAX) { lines.splice(0, lines.length - MAX); if (pre.firstChild) pre.firstChild.remove(); }
    if (!panel.hidden) {
      pre.append(row(entry));
      if (follow.checked) pre.scrollTop = pre.scrollHeight;
    }
  }
  function redraw() {
    pre.replaceChildren(...lines.map(row));
    pre.scrollTop = pre.scrollHeight;
  }
  function setOpen(open) {
    panel.hidden = !open;
    document.body.classList.toggle("activity-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.classList.toggle("on", open);
    if (open) redraw();
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  document.getElementById("activity-close").addEventListener("click", () => setOpen(false));
  document.getElementById("activity-clear").addEventListener("click", () => { lines = []; pre.replaceChildren(); });
  document.getElementById("activity-logfile").addEventListener("click", () => api.openLog());
  document.getElementById("activity-copy").addEventListener("click", async () => {
    const text = lines.map((e) => `${stamp(e.t)} ${e.line}`).join("\n");
    try { await navigator.clipboard.writeText(text); window.ui.toast("Activity copied."); }
    catch (_) { window.ui.toast("Couldn't copy; use Open log file instead.", "error"); }
  });
  pre.addEventListener("scroll", () => {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
    if (!atBottom && follow.checked) follow.checked = false;
  });

  api.onActivity(add);
  api.getActivity().then((list) => { if (Array.isArray(list)) list.forEach(add); });
})();
