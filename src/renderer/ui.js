// DOM helpers. Text always goes in through textContent, never innerHTML,
// because clip names and recipe text come from files we don't control.
(() => {
"use strict";

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

let toastTimer = null;
function toast(message, kind = "info") {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, kind === "error" ? 7000 : 3500);
}

// Shows a modal with buttons; resolves to the chosen button's value, or
// null when dismissed with Escape.
function choose(title, body, buttons) {
  const dlg = document.getElementById("modal");
  dlg.replaceChildren(
    h("h2", {}, title),
    h("p", {}, body),
    h("div", { class: "modal-actions" },
      buttons.map((b) => h("button", {
        class: b.primary ? "btn primary" : "btn",
        onclick: () => { dlg.close(b.value); },
      }, b.label))),
  );
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue || null), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

window.ui = { h, toast, choose };
})();
