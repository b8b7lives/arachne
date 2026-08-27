const KEY_EXPLAIN = "arachne.explain";
const $ = (id: string) => document.getElementById(id);

export const isTouch = (): boolean => matchMedia("(pointer: coarse)").matches;
export const isPhone = (): boolean => matchMedia("(max-width: 40rem)").matches;
export const isNarrow = (): boolean => matchMedia("(max-width: 900px)").matches;

let explainOn = false;
let explainTimer: ReturnType<typeof setTimeout> | undefined;

function readExplain(): boolean {
  try {
    const v = localStorage.getItem(KEY_EXPLAIN);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeExplain(on: boolean): void {
  try {
    localStorage.setItem(KEY_EXPLAIN, on ? "1" : "0");
  } catch {
  }
}

function targets(): HTMLElement[] {
  const seen = new Set<Element>();
  return [...document.querySelectorAll<HTMLElement>("main [title], #about-panel [title]")]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => !el.closest("#palette, h2, .section-tools, table") && !el.matches("a, .tile, .mini, #preview-wrap"))
    .filter((el) => !el.closest("#loadout") || el.closest(".tool-item") === document.querySelector("#loadout .tool-item"))
    .filter((el) => !(el.tagName !== "LABEL" && el.closest("label[title]")))
    .filter((el) => {
      const box = el.closest("label, .field, .field-inline") ?? el;
      if (seen.has(box)) return false;
      seen.add(box);
      return true;
    });
}

function legend(): HTMLElement | null {
  const table = document.querySelector("#palette .palette-table");
  if (!table) return null;
  const dl = document.createElement("dl");
  dl.className = "explain palette-legend";
  const add = (term: string, text: string) => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = text;
    dl.append(dt, dd);
  };
  for (const th of table.querySelectorAll<HTMLElement>("thead th[title]")) add(th.textContent ?? "", th.title);
  const seen = new Set<string>();
  for (const f of table.querySelectorAll<HTMLElement>(".flag[title]")) {
    const k = f.textContent ?? "";
    if (seen.has(k)) continue;
    seen.add(k);
    add(k, f.title);
  }
  table.before(dl);
  return dl;
}

function applyExplain(): void {
  for (const n of document.querySelectorAll(".explain")) n.remove();
  if (!explainOn) return;
  legend();
  for (const el of targets()) {
    const note = document.createElement("span");
    note.className = "explain";
    note.textContent = el.title;
    const host = el.closest("label");
    if (host) host.append(note);
    else el.after(note);
  }
}

function scheduleExplain(): void {
  clearTimeout(explainTimer);
  explainTimer = setTimeout(applyExplain, 150);
}

function explainBar(): void {
  const bar = document.createElement("div");
  bar.id = "explain-bar";
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "explain-on";
  box.checked = explainOn;
  label.append(box, " explain controls");
  bar.append(label);
  $("about-panel")?.after(bar);
  box.onchange = () => {
    explainOn = box.checked;
    writeExplain(explainOn);
    applyExplain();
  };
  for (const id of ["summary", "loadout", "palette"]) {
    const watched = $(id);
    if (!watched) continue;
    new MutationObserver((muts) => {
      if (muts.some((m) => [...m.addedNodes].some((n) => !(n instanceof Element && n.classList.contains("explain"))))) scheduleExplain();
    }).observe(watched, { childList: true, subtree: id === "loadout" });
  }
  applyExplain();
}

function jumpBar(): void {
  const bar = document.createElement("nav");
  bar.id = "jump-bar";
  for (const [id, text] of [["source-panel", "Source"], ["solver-panel", "Palette"], ["summary-panel", "Summary"], ["export-panel", "Download"]]) {
    const a = document.createElement("a");
    a.href = `#${id}`;
    a.textContent = text;
    bar.append(a);
  }
  document.body.append(bar);
  document.body.classList.add("has-jump-bar");
}

function collapseAbout(): void {
  const about = $("about-panel");
  const h2 = about?.querySelector("h2");
  if (!about || !h2) return;
  about.classList.add("collapsed");
  h2.onclick = () => about.classList.toggle("collapsed");
}

function touchHints(): void {
  const file = $("file");
  if (file && !$("skip-hint")) {
    const skip = document.createElement("p");
    skip.className = "note";
    skip.id = "skip-hint";
    skip.textContent = "The survival default palette and a full netherite kit are already in place. If you only want the build, use Download at the bottom.";
    file.closest(".row")?.after(skip);
  }
  const hint = $("preview-hint");
  if (hint) hint.textContent = "tap the picture area to choose a photo";
  $("preview-wrap")?.setAttribute("title", "tap to choose a picture");
}

export function touchDefaults(): void {
  if (!isTouch()) return;
  const view = $("palette-view") as HTMLSelectElement | null;
  if (view) view.value = "list";
}

function shareButton(): void {
  const btn = $("export-share");
  if (!btn || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return;
  const probe = new File([new Uint8Array(1)], "probe.zip", { type: "application/zip" });
  if (!navigator.canShare({ files: [probe] })) return;
  btn.hidden = false;
}

export function initMobile(): void {
  if (!isTouch()) return;
  explainOn = readExplain();
  shareButton();
  touchHints();
  if (isPhone()) collapseAbout();
  if (isNarrow()) jumpBar();
  explainBar();
}

export function registerWorker(base: string): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const go = () => void navigator.serviceWorker.register(`${base}sw.js`).catch(() => undefined);
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go);
}
