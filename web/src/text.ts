import groups from "./font-groups.json";
import {
  bandKey,
  dilate,
  fetchSheet,
  type HintedSheet,
  layoutLine,
  maskOf,
  missingFrom,
  paintMask,
} from "./hinted";
import type {
  CatalogFace,
  FontCatalog,
  FontCoverage,
  TextAlign,
  TextItem,
  TextKind,
  TextTurn,
} from "./types";

const CRISP_BELOW = 20;
const KINDS: TextKind[] = ["auto", "crisp", "smooth", "hinted"];
const MARGIN = 4;
const DEFAULT_FONT = "atkinson-hyperlegible-next";
const FALLBACK_TEXT = "noto-sans";
const FALLBACK_EMOJI = "noto-emoji";
const FALLBACK_FAMILIES = ["Noto Sans", "Noto Emoji"];
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

export interface TextRaster {
  overlay: Uint8ClampedArray;
  nearest: Uint8Array;
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaletteEntry {
  name: string;
  tone: string;
  rgb: [number, number, number];
}

interface Deps {
  onChange: () => void;
  onDragEnd: () => void;
  outSize: () => [number, number];
  preview: () => HTMLCanvasElement;
  lastPreview: () => ImageData | null;
  palette: () => PaletteEntry[];
  popped: () => boolean;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let deps: Deps;
let items: TextItem[] = [];
let on = true;
let selected: string | null = null;
let catalog: FontCatalog | null = null;
let catalogReady: Promise<void> | null = null;
let catalogFailed = false;
let coverageRaw: Record<string, string> | null = null;
let coverageReady: Promise<void> | null = null;
const coverageRanges = new Map<string, [number, number][]>();
const scratchPool = new Map<
  string,
  { cv: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
>();
const loaded = new Map<string, Promise<void>>();
const failed = new Set<string>();
const sheets = new Map<string, HintedSheet>();
const sheetLoads = new Map<string, Promise<void>>();
const sheetFailed = new Set<string>();
const leftOut = new Map<string, string>();
let boxes: Box[] = [];
let drag: { id: string; dx: number; dy: number } | null = null;
let painting = false;
let paintAgain = false;
const HISTORY_MAX = 100;
const TYPING_STEP_MS = 800;
const past: string[] = [];
const future: string[] = [];
let committed = "";
let lastTyped = 0;

export function textItems(): TextItem[] {
  return structuredClone(items);
}

export function hasText(): boolean {
  return on && items.some((t) => t.text.trim().length > 0);
}

export function textOn(): boolean {
  return on;
}

export function setTextItems(list: TextItem[] | undefined, isOn = true): void {
  items = Array.isArray(list) ? list.filter(valid).map(normalize) : [];
  on = isOn;
  selected = items[0]?.id ?? null;
  past.length = 0;
  future.length = 0;
  committed = snap();
  renderList();
  renderFields();
}

function snap(): string {
  return JSON.stringify({ items, on, selected });
}

function syncHistoryButtons() {
  const undo = document.getElementById("text-undo") as HTMLButtonElement | null;
  const redo = document.getElementById("text-redo") as HTMLButtonElement | null;
  if (undo) undo.disabled = past.length === 0;
  if (redo) redo.disabled = future.length === 0;
}

function commit(source: "typing" | "other" = "other") {
  const now = snap();
  if (now !== committed) {
    const at = performance.now();
    const coalesce = source === "typing" && at - lastTyped < TYPING_STEP_MS && past.length > 0;
    if (!coalesce) {
      past.push(committed);
      if (past.length > HISTORY_MAX) past.shift();
      future.length = 0;
    }
    lastTyped = source === "typing" ? at : 0;
    committed = now;
  }
  syncHistoryButtons();
  deps.onChange();
}

function restore(state: string) {
  const s = JSON.parse(state) as { items: TextItem[]; on: boolean; selected: string | null };
  items = s.items.filter(valid).map(normalize);
  on = Boolean(s.on);
  selected = items.some((t) => t.id === s.selected) ? s.selected : (items[0]?.id ?? null);
  committed = state;
  lastTyped = 0;
  renderList();
  renderFields();
  restorePreview();
  syncHistoryButtons();
  deps.onChange();
}

function undo() {
  if (past.length === 0) return;
  future.push(committed);
  restore(past.pop()!);
}

function redo() {
  if (future.length === 0) return;
  past.push(committed);
  restore(future.pop()!);
}

function valid(t: unknown): t is TextItem {
  return typeof t === "object" && t !== null && typeof (t as TextItem).text === "string";
}

function normalize(t: TextItem): TextItem {
  const d = defaults();
  return {
    ...d,
    ...t,
    id: typeof t.id === "string" && t.id ? t.id : d.id,
    kind: KINDS.includes(t.kind) ? t.kind : d.kind,
    size: clamp(num(t.size, d.size), 4, 512),
    ax: clamp(num(t.ax, d.ax), 0, 100),
    ay: clamp(num(t.ay, d.ay), 0, 100),
    lineHeight: clamp(num(t.lineHeight, d.lineHeight), 0.6, 3),
    tracking: clamp(num(t.tracking, d.tracking), -10, 40),
    ink: clamp(num(t.ink, d.ink), 64, 192),
    shadowX: clamp(num(t.shadowX, d.shadowX), -16, 16),
    shadowY: clamp(num(t.shadowY, d.shadowY), -16, 16),
    color: hex(t.color, d.color),
    outlineColor: hex(t.outlineColor, d.outlineColor),
    shadowColor: hex(t.shadowColor, d.shadowColor),
    gradientColor: hex(t.gradientColor, d.gradientColor),
    underline: Boolean(t.underline),
    gradient: Boolean(t.gradient),
    gradientDir: t.gradientDir === "across" ? "across" : "down",
    rotate: turn(t.rotate),
    mirror: Boolean(t.mirror),
    flip: Boolean(t.flip),
    stacked: Boolean(t.stacked),
  };
}

function hex(v: unknown, fallback: string): string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}

function turn(v: unknown): TextTurn {
  const n = Number(v);
  return n === 90 || n === 180 || n === 270 ? n : 0;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function newId(): string {
  const c = globalThis.crypto;
  return c && "randomUUID" in c
    ? c.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function defaults(): TextItem {
  return {
    id: newId(),
    text: "",
    font: DEFAULT_FONT,
    size: 16,
    bold: true,
    kind: "auto",
    color: "#ffffff",
    outline: true,
    outlineColor: "#000000",
    shadow: false,
    shadowColor: "#000000",
    shadowX: 1,
    shadowY: 1,
    align: "center",
    ax: 50,
    ay: 50,
    lineHeight: 1.2,
    tracking: 0,
    ink: 128,
    underline: false,
    gradient: false,
    gradientColor: "#9aa3b2",
    gradientDir: "down",
    rotate: 0,
    mirror: false,
    flip: false,
    stacked: false,
  };
}

export function resolveKind(t: TextItem): "crisp" | "smooth" | "hinted" {
  if (t.kind !== "auto") return t.kind;
  return t.size < CRISP_BELOW ? "crisp" : "smooth";
}

export interface TextStyle {
  kind: "crisp" | "smooth" | "hinted";
  reason: string | null;
}

// The style a line is drawn in. A hinted line falls back to crisp, with the
// reason for the chip, when its sheet cannot draw it.
export function styleOf(t: TextItem): TextStyle {
  const k = resolveKind(t);
  if (k !== "hinted") return { kind: k, reason: null };
  const f = face(t.font);
  if (!f || failed.has(t.font)) return { kind: "crisp", reason: "this font did not load" };
  if (f.native) return { kind: "crisp", reason: "pixel faces already sit on the block grid" };
  if (!f.hinted) return { kind: "crisp", reason: "this font has no hinted letters" };
  if (sheetFailed.has(f.id)) return { kind: "crisp", reason: "the hinted letters did not load" };
  const sheet = sheets.get(f.id);
  if (!sheet) return { kind: "hinted", reason: null };
  const size = Math.round(t.size);
  if (!sheet.sizes.includes(size)) {
    const [lo, hi] = [sheet.sizes[0], sheet.sizes[sheet.sizes.length - 1]];
    return { kind: "crisp", reason: `hinted covers ${lo} to ${hi} blocks` };
  }
  const band = sheet.bands.get(bandKey(sheetWeight(sheet, t).weight, size));
  if (!band) return { kind: "crisp", reason: "the hinted letters did not load" };
  const missing = missingFrom(band, renderableText(t));
  if (missing.length) {
    return { kind: "crisp", reason: `hinted has no ${missing.slice(0, 6).join(" ")}` };
  }
  return { kind: "hinted", reason: null };
}

function sheetWeight(sheet: HintedSheet, t: TextItem): { weight: number; embolden: boolean } {
  const hasBold = sheet.weights.includes(700);
  if (t.bold) return { weight: hasBold ? 700 : sheet.weights[0], embolden: !hasBold };
  return { weight: sheet.weights.includes(400) ? 400 : sheet.weights[0], embolden: false };
}

function ensureSheet(id: string): Promise<void> {
  const cached = sheetLoads.get(id);
  if (cached) return cached;
  const f = face(id);
  if (!f?.hinted) return Promise.resolve();
  const p = fetchSheet(`${base()}fonts/catalog/${f.id}/${f.hinted.file}`).then(
    (sheet) => {
      sheets.set(id, sheet);
      sheetFailed.delete(id);
    },
    (e) => {
      sheetLoads.delete(id);
      sheetFailed.add(id);
      throw e;
    },
  );
  sheetLoads.set(id, p);
  return p;
}

function current(): TextItem | null {
  return items.find((t) => t.id === selected) ?? null;
}

function base(): string {
  return import.meta.env.BASE_URL;
}

export function loadCatalog(): Promise<void> {
  if (catalogReady) return catalogReady;
  catalogReady = fetch(`${base()}fonts/catalog/fonts.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`font catalog: HTTP ${r.status}`);
      return r.json() as Promise<FontCatalog>;
    })
    .then(
      (doc) => {
        catalog = doc;
        catalogFailed = false;
        fillPicker();
      },
      (e) => {
        catalogReady = null;
        catalogFailed = true;
        throw e;
      },
    );
  return catalogReady;
}

function scratch(slot: string, w: number, h: number) {
  let s = scratchPool.get(slot);
  if (!s) {
    const cv = new OffscreenCanvas(w, h);
    s = { cv, ctx: cv.getContext("2d", { willReadFrequently: slot === "raster" })! };
    scratchPool.set(slot, s);
  } else if (s.cv.width !== w || s.cv.height !== h) {
    s.cv.width = w;
    s.cv.height = h;
  } else {
    s.ctx.clearRect(0, 0, w, h);
  }
  return s;
}

function face(id: string): CatalogFace | null {
  return catalog?.faces.find((f) => f.id === id) ?? null;
}

function groupOf(f: CatalogFace): string {
  for (const key of groups.order) {
    const g = groups.groups[key as keyof typeof groups.groups];
    if (g.tags.length === 0) return key;
    for (const [tag, score] of Object.entries(f.tags)) {
      const hit = g.tags.some((t) => (t.endsWith("/") ? tag.startsWith(t) : tag === t));
      if (hit && score >= g.min) return key;
    }
  }
  return "display";
}

let fontHot = -1;

function stripPos(el: HTMLElement, f: CatalogFace | null) {
  if (!catalog || !f) {
    el.style.backgroundPosition = "0 9999px";
    return;
  }
  el.style.backgroundPosition = `0 -${f.strip * catalog.strips.names.h}px`;
}

function fillPicker() {
  if (!catalog) return;
  document.documentElement.style.setProperty(
    "--font-strips",
    `url("${base()}fonts/catalog/${catalog.strips.names.file}")`,
  );
  $("text-font-drop").dataset.count = String(catalog.faces.filter((f) => !f.hidden).length);
  for (const t of items) snapSize(t);
  renderFields();
}

function fontRows(): HTMLElement[] {
  return [...$("text-font-drop").querySelectorAll<HTMLElement>(".picker-row")];
}

function renderFontDrop() {
  if (!catalog) return;
  if (!coverageRaw) void loadCoverage().catch(() => undefined);
  const drop = $("text-font-drop");
  const input = $<HTMLInputElement>("text-font-search");
  const cur = current();
  let q = input.value.trim().toLowerCase();
  if (cur && q === familyOf(cur.font).toLowerCase()) q = "";
  const by = new Map<string, CatalogFace[]>();
  for (const f of catalog.faces) {
    if (f.hidden) continue;
    const g = groupOf(f);
    const label = groups.groups[g as keyof typeof groups.groups].label;
    if (q && !f.name.toLowerCase().includes(q) && !label.includes(q)) continue;
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(f);
  }
  drop.replaceChildren();
  let n = 0;
  for (const key of groups.order) {
    const list = by.get(key);
    if (!list?.length) continue;
    const g = document.createElement("div");
    g.className = "picker-group";
    g.textContent = groups.groups[key as keyof typeof groups.groups].label;
    drop.append(g);
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const f of list) {
      const row = document.createElement("div");
      row.className = "picker-row";
      row.dataset.id = f.id;
      row.setAttribute("role", "option");
      row.id = `text-font-opt-${n}`;
      n += 1;
      const s = document.createElement("span");
      s.className = "font-strip";
      stripPos(s, f);
      const name = document.createElement("span");
      name.className = "name";
      const tags = [f.native ? `pixel ${f.native}` : "", f.small ? "" : "big text only"].filter(
        Boolean,
      );
      name.textContent = tags.length ? `${f.name}, ${tags.join(", ")}` : f.name;
      if (cur && missingIn(f, cur.text).length) {
        row.classList.add("lacks");
        row.title = "does not have every character in your text";
      }
      row.append(s, name);
      row.onmousedown = (ev) => {
        ev.preventDefault();
        commitFont(f.id);
      };
      drop.append(row);
    }
  }
  if (!drop.childElementCount) {
    const none = document.createElement("div");
    none.className = "picker-empty";
    none.textContent = `no font matches "${q}"`;
    drop.append(none);
  }
  fontHot = -1;
  input.setAttribute("aria-expanded", "true");
  input.removeAttribute("aria-activedescendant");
  drop.hidden = false;
}

function closeFontDrop() {
  $("text-font-drop").hidden = true;
  const input = $<HTMLInputElement>("text-font-search");
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  fontHot = -1;
  const t = current();
  if (t) input.value = familyOf(t.font);
}

function commitFont(id: string) {
  const t = current();
  if (!t) return;
  t.font = id;
  snapSize(t);
  closeFontDrop();
  renderFields();
  changed();
}

function bindFontPicker() {
  const input = $<HTMLInputElement>("text-font-search");
  input.addEventListener("focus", () => {
    input.select();
    renderFontDrop();
  });
  input.addEventListener("click", () => {
    if ($("text-font-drop").hidden) {
      input.select();
      renderFontDrop();
    }
  });
  input.addEventListener("input", renderFontDrop);
  input.addEventListener("blur", closeFontDrop);
  input.addEventListener("keydown", (e) => {
    const drop = $("text-font-drop");
    if (drop.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      renderFontDrop();
    }
    const rows = fontRows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      fontHot =
        e.key === "ArrowDown"
          ? (fontHot + 1) % rows.length
          : (fontHot - 1 + rows.length) % rows.length;
      rows.forEach((r, i) => {
        r.classList.toggle("hot", i === fontHot);
        r.setAttribute("aria-selected", String(i === fontHot));
      });
      rows[fontHot].scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", rows[fontHot].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = fontHot >= 0 ? rows[fontHot] : rows[0];
      if (pick?.dataset.id) commitFont(pick.dataset.id);
    } else if (e.key === "Escape") {
      closeFontDrop();
      input.blur();
    }
  });
}

function ensureFont(id: string): Promise<void> {
  const cached = loaded.get(id);
  if (cached) return cached;
  const f = face(id);
  if (!f) {
    if (catalog) failed.add(id);
    return Promise.resolve();
  }
  const p = Promise.all(
    f.files.map((file) => {
      const ff = new FontFace(f.name, `url(${base()}fonts/catalog/${f.id}/${file.file})`, {
        weight: file.weight === "variable" ? "100 900" : String(file.weight),
        style: file.style === "italic" ? "italic" : "normal",
      });
      document.fonts.add(ff);
      return ff.load().then(() => undefined);
    }),
  ).then(
    () => {
      failed.delete(id);
    },
    (e) => {
      loaded.delete(id);
      failed.add(id);
      throw e;
    },
  );
  loaded.set(id, p);
  return p;
}

function loadCoverage(): Promise<void> {
  if (coverageReady) return coverageReady;
  coverageReady = fetch(`${base()}fonts/catalog/fonts-coverage.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`font coverage: HTTP ${r.status}`);
      return r.json() as Promise<FontCoverage>;
    })
    .then(
      (doc) => {
        coverageRaw = doc.faces;
        if (!$("text-font-drop").hidden) renderFontDrop();
      },
      (e) => {
        coverageReady = null;
        throw e;
      },
    );
  return coverageReady;
}

function rangesOf(id: string): [number, number][] | null {
  const cached = coverageRanges.get(id);
  if (cached) return cached;
  const raw = coverageRaw?.[id];
  if (raw === undefined) return null;
  const out: [number, number][] = raw
    ? raw.split(",").map((part) => {
        const [a, b] = part.split("-");
        const lo = parseInt(a, 16);
        return [lo, b === undefined ? lo : parseInt(b, 16)];
      })
    : [];
  coverageRanges.set(id, out);
  return out;
}

function covers(f: CatalogFace | null, cp: number): boolean {
  const r = f ? rangesOf(f.id) : null;
  if (!r) return true;
  let lo = 0;
  let hi = r.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[mid][0]) hi = mid - 1;
    else if (cp > r[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function missingIn(f: CatalogFace | null, text: string): string[] {
  const out: string[] = [];
  for (const ch of new Set([...text])) {
    if (/\s/.test(ch)) continue;
    if (!covers(f, ch.codePointAt(0)!)) out.push(ch);
  }
  return out;
}

function fallbackFor(ch: string): string | null {
  const cp = ch.codePointAt(0)!;
  for (const id of [FALLBACK_TEXT, FALLBACK_EMOJI]) {
    const f = face(id);
    if (f && rangesOf(id) && covers(f, cp)) return id;
  }
  return null;
}

function renderableText(t: TextItem): string {
  const f = face(t.font);
  if (!f || !rangesOf(f.id)) {
    leftOut.delete(t.id);
    return t.text;
  }
  const gone = missingIn(f, t.text).filter((ch) => !fallbackFor(ch));
  if (gone.length === 0) {
    leftOut.delete(t.id);
    return t.text;
  }
  leftOut.set(t.id, gone.join(" "));
  const drop = new Set(gone);
  return [...t.text].filter((ch) => !drop.has(ch)).join("");
}

function snapSize(t: TextItem) {
  const native = face(t.font)?.native ?? 0;
  if (native) t.size = clamp(Math.max(native, Math.round(t.size / native) * native), 4, 512);
}

function familyOf(id: string): string {
  return face(id)?.name ?? face(DEFAULT_FONT)?.name ?? "Atkinson Hyperlegible Next";
}

function fontString(t: TextItem): string {
  const fam = [familyOf(t.font), ...FALLBACK_FAMILIES].map((n) => `"${n}"`).join(", ");
  return `${t.bold ? 700 : 400} ${t.size}px ${fam}`;
}

function prepare(ctx: OffscreenCanvasRenderingContext2D, t: TextItem) {
  ctx.font = fontString(t);
  ctx.textAlign = t.align;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  if ("letterSpacing" in ctx) (ctx as { letterSpacing: string }).letterSpacing = `${t.tracking}px`;
}

function linesOf(t: TextItem, text: string): string[] {
  return t.stacked ? [...text.replace(/\n/g, "")] : text.split("\n");
}

function lineBaselines(
  t: TextItem,
  text: string,
  outW: number,
  outH: number,
): { x: number; ys: number[] } {
  const lines = linesOf(t, text);
  const step = t.size * t.lineHeight;
  const x = Math.round((t.ax / 100) * outW);
  const top = (t.ay / 100) * outH;
  const ys = lines.map((_, i) => Math.round(top + i * step));
  return { x, ys };
}

function transformOf(t: TextItem, x: number, y: number): DOMMatrix {
  return new DOMMatrix()
    .translateSelf(x, y)
    .rotateSelf(t.rotate)
    .scaleSelf(t.mirror ? -1 : 1, t.flip ? -1 : 1)
    .translateSelf(-x, -y);
}

function drawItem(
  ctx: OffscreenCanvasRenderingContext2D,
  t: TextItem,
  outW: number,
  outH: number,
): Box {
  prepare(ctx, t);
  const text = renderableText(t);
  const lines = linesOf(t, text);
  const { x, ys } = lineBaselines(t, text, outW, outH);
  const rule = Math.max(1, Math.round(t.size / 12));
  const rows = lines.map((line, i) => {
    const m = ctx.measureText(line);
    return {
      line,
      y: ys[i],
      l: x - m.actualBoundingBoxLeft,
      r: x + m.actualBoundingBoxRight,
      top: ys[i] - m.actualBoundingBoxAscent,
      bottom: ys[i] + m.actualBoundingBoxDescent + (t.underline ? 2 * rule : 0),
    };
  });
  const left = Math.min(...rows.map((r) => r.l));
  const right = Math.max(...rows.map((r) => r.r));
  const top = Math.min(...rows.map((r) => r.top));
  const bottom = Math.max(...rows.map((r) => r.bottom));
  const crisp = styleOf(t).kind !== "smooth";
  let fill: string | CanvasGradient = snapHex(t.color);
  if (t.gradient && !crisp) {
    const g =
      t.gradientDir === "across"
        ? ctx.createLinearGradient(left, 0, right, 0)
        : ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, snapHex(t.color));
    g.addColorStop(1, snapHex(t.gradientColor));
    fill = g;
  }
  const m = transformOf(t, x, ys[0] ?? 0);
  ctx.save();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  for (const row of rows) {
    if (t.shadow) {
      ctx.fillStyle = snapHex(t.shadowColor);
      ctx.fillText(row.line, x + t.shadowX, row.y + t.shadowY);
      if (t.underline)
        ctx.fillRect(row.l + t.shadowX, row.y + rule + t.shadowY, row.r - row.l, rule);
    }
    if (t.outline) {
      ctx.strokeStyle = snapHex(t.outlineColor);
      ctx.lineWidth = 2;
      ctx.strokeText(row.line, x, row.y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(row.line, x, row.y);
    if (t.underline) ctx.fillRect(row.l, row.y + rule, row.r - row.l, rule);
  }
  ctx.restore();
  return boxFrom(t, m, left, top, right, bottom);
}

function boxFrom(
  t: TextItem,
  m: DOMMatrix,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Box {
  const pad =
    1 + (t.outline ? 1 : 0) + (t.shadow ? Math.max(Math.abs(t.shadowX), Math.abs(t.shadowY)) : 0);
  const corners = [
    [left - pad, top - pad],
    [right + pad, top - pad],
    [left - pad, bottom + pad],
    [right + pad, bottom + pad],
  ].map(([cx, cy]) => m.transformPoint(new DOMPoint(cx, cy)));
  const bx = Math.floor(Math.min(...corners.map((p) => p.x)));
  const by = Math.floor(Math.min(...corners.map((p) => p.y)));
  return {
    id: t.id,
    x: bx,
    y: by,
    w: Math.ceil(Math.max(...corners.map((p) => p.x))) - bx,
    h: Math.ceil(Math.max(...corners.map((p) => p.y))) - by,
  };
}

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blit(
  ctx: OffscreenCanvasRenderingContext2D,
  mask: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  rgb: [number, number, number],
) {
  if (w <= 0 || h <= 0) return;
  const s = scratch("glyph", w, h);
  s.ctx.putImageData(paintMask(mask, w, h, rgb), 0, 0);
  ctx.drawImage(s.cv, x, y);
}

// A hinted line: glyph bitmaps from the sheet placed at whole-block pens,
// shadow, outline (the letters grown by one block) and fill as opaque
// blocks, then the same transform as the other styles with smoothing off.
function drawHintedItem(
  ctx: OffscreenCanvasRenderingContext2D,
  t: TextItem,
  outW: number,
  outH: number,
  sheet: HintedSheet,
): Box {
  const text = renderableText(t);
  const lines = linesOf(t, text);
  const { x, ys } = lineBaselines(t, text, outW, outH);
  const size = Math.round(t.size);
  const { weight, embolden } = sheetWeight(sheet, t);
  const band = sheet.bands.get(bandKey(weight, size))!;
  const rule = Math.max(1, Math.round(t.size / 12));
  const rows = lines.map((line, i) => {
    const lay = layoutLine(sheet, band, line, size, t.tracking, embolden);
    const x0 =
      t.align === "left" ? x : t.align === "right" ? x - lay.width : x - Math.round(lay.width / 2);
    return {
      lay,
      y: ys[i],
      l: x0 + lay.left,
      r: x0 + lay.right,
      top: ys[i] + lay.top,
      bottom: ys[i] + lay.bottom + (t.underline ? 2 * rule : 0),
    };
  });
  const left = Math.min(...rows.map((r) => r.l));
  const right = Math.max(...rows.map((r) => r.r));
  const top = Math.min(...rows.map((r) => r.top));
  const bottom = Math.max(...rows.map((r) => r.bottom));
  const fill = snapHex(t.color);
  const shadow = snapHex(t.shadowColor);
  const outline = snapHex(t.outlineColor);
  const m = transformOf(t, x, ys[0] ?? 0);
  ctx.save();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.imageSmoothingEnabled = false;
  for (const row of rows) {
    const w = row.lay.right - row.lay.left;
    const h = row.lay.bottom - row.lay.top;
    const mask = maskOf(row.lay, embolden);
    if (t.shadow) {
      blit(ctx, mask, w, h, row.l + t.shadowX, row.top + t.shadowY, rgbOf(shadow));
      if (t.underline) {
        ctx.fillStyle = shadow;
        ctx.fillRect(row.l + t.shadowX, row.y + rule + t.shadowY, row.r - row.l, rule);
      }
    }
    if (t.outline)
      blit(ctx, dilate(mask, w, h), w + 2, h + 2, row.l - 1, row.top - 1, rgbOf(outline));
    blit(ctx, mask, w, h, row.l, row.top, rgbOf(fill));
    if (t.underline) {
      ctx.fillStyle = fill;
      ctx.fillRect(row.l, row.y + rule, row.r - row.l, rule);
    }
  }
  ctx.restore();
  return boxFrom(t, m, left, top, right, bottom);
}

export async function rasterizeText(outW: number, outH: number): Promise<TextRaster | null> {
  const live = items.filter((t) => t.text.trim().length > 0);
  if (live.length === 0) {
    boxes = [];
    return null;
  }
  await loadCatalog().catch(() => undefined);
  await Promise.all([
    loadCoverage().catch(() => undefined),
    Promise.allSettled(live.map((t) => ensureFont(t.font))),
  ]);
  const extras = new Set<string>();
  for (const t of live) {
    const f = face(t.font);
    if (!f || failed.has(t.font)) {
      extras.add(FALLBACK_TEXT);
      if (PICTOGRAPH.test(t.text)) extras.add(FALLBACK_EMOJI);
      continue;
    }
    for (const ch of missingIn(f, t.text)) {
      const fb = fallbackFor(ch);
      if (fb) extras.add(fb);
    }
  }
  if (extras.size) await Promise.allSettled([...extras].map(ensureFont));
  await Promise.allSettled(
    live.filter((t) => resolveKind(t) === "hinted").map((t) => ensureSheet(t.font)),
  );
  const overlay = new Uint8ClampedArray(outW * outH * 4);
  const nearest = new Uint8Array(outW * outH);
  const next: Box[] = [];
  const { ctx } = scratch("raster", outW, outH);
  for (const t of live) {
    ctx.clearRect(0, 0, outW, outH);
    const style = styleOf(t);
    const sheet = sheets.get(t.font);
    const box =
      style.kind === "hinted" && sheet
        ? drawHintedItem(ctx, t, outW, outH, sheet)
        : drawItem(ctx, t, outW, outH);
    next.push(box);
    const x0 = clamp(box.x, 0, outW);
    const y0 = clamp(box.y, 0, outH);
    const x1 = clamp(box.x + box.w, 0, outW);
    const y1 = clamp(box.y + box.h, 0, outH);
    if (x1 <= x0 || y1 <= y0) continue;
    const bw = x1 - x0;
    const px = ctx.getImageData(x0, y0, bw, y1 - y0).data;
    const crisp = style.kind !== "smooth";
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const s = ((y - y0) * bw + (x - x0)) * 4;
        let a = px[s + 3];
        if (a === 0) continue;
        if (crisp) {
          if (a < t.ink) continue;
          a = 255;
        }
        const i = y * outW + x;
        const o = i * 4;
        const af = a / 255;
        const ob = overlay[o + 3] / 255;
        const outA = af + ob * (1 - af);
        for (let c = 0; c < 3; c++) {
          overlay[o + c] = Math.round((px[s + c] * af + overlay[o + c] * ob * (1 - af)) / outA);
        }
        overlay[o + 3] = Math.round(outA * 255);
        if (crisp) nearest[i] = 1;
        else if (a >= 128) nearest[i] = 0;
      }
    }
  }
  boxes = next;
  refreshChips();
  return { overlay, nearest };
}

function hit(x: number, y: number): Box | null {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b;
  }
  return null;
}

function mapPoint(e: PointerEvent): [number, number] {
  const cv = deps.preview();
  const r = cv.getBoundingClientRect();
  return [
    ((e.clientX - r.left) * cv.width) / r.width,
    ((e.clientY - r.top) * cv.height) / r.height,
  ];
}

export function markSelection(): void {
  const b = selected ? boxes.find((x) => x.id === selected) : undefined;
  if (!b || !hasText() || deps.popped()) return;
  const ctx = deps.preview().getContext("2d")!;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
  ctx.strokeRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
  ctx.lineDashOffset = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.strokeRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
  ctx.restore();
}

function restorePreview() {
  const cv = deps.preview();
  const last = deps.lastPreview();
  const ctx = cv.getContext("2d")!;
  if (last) ctx.putImageData(last, 0, 0);
  else ctx.clearRect(0, 0, cv.width, cv.height);
  return ctx;
}

async function paintLive() {
  if (painting) {
    paintAgain = true;
    return;
  }
  painting = true;
  try {
    do {
      paintAgain = false;
      const cv = deps.preview();
      const raster = await rasterizeText(cv.width, cv.height);
      if (!raster) {
        restorePreview();
        continue;
      }
      const { width: w, height: h } = cv;
      const ctx = cv.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      const last = deps.lastPreview();
      if (last) {
        const under = scratch("under", w, h);
        under.ctx.putImageData(last, 0, 0);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(under.cv, 0, 0);
        ctx.globalAlpha = 1;
      }
      const layer = scratch("layer", w, h);
      layer.ctx.putImageData(new ImageData(new Uint8ClampedArray(raster.overlay), w, h), 0, 0);
      ctx.drawImage(layer.cv, 0, 0);
      markSelection();
    } while (paintAgain);
  } finally {
    painting = false;
  }
}

function wirePreview() {
  const cv = deps.preview();
  cv.addEventListener("pointerdown", (e) => {
    if (!hasText() || deps.popped()) return;
    const [x, y] = mapPoint(e);
    const b = hit(x, y);
    if (!b) {
      if (selected) {
        selected = null;
        renderList();
        restorePreview();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    select(b.id);
    const t = current();
    if (!t) return;
    const [outW, outH] = deps.outSize();
    drag = { id: b.id, dx: x - (t.ax / 100) * outW, dy: y - (t.ay / 100) * outH };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const t = current();
    if (!t || t.id !== drag.id) return;
    const [x, y] = mapPoint(e);
    const [outW, outH] = deps.outSize();
    t.ax = clamp(((x - drag.dx) / outW) * 100, 0, 100);
    t.ay = clamp(((y - drag.dy) / outH) * 100, 0, 100);
    syncPosition(t);
    void paintLive();
  });
  const end = (e: PointerEvent) => {
    if (!drag) return;
    drag = null;
    try {
      cv.releasePointerCapture(e.pointerId);
    } catch {}
    commit();
    deps.onDragEnd();
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener(
    "click",
    (e) => {
      if (hasText()) e.stopPropagation();
    },
    true,
  );
}

function select(id: string) {
  selected = id;
  renderList();
  renderFields();
  restorePreview();
  markSelection();
}

function label(t: TextItem): string {
  const first = t.text.split("\n")[0].trim();
  if (!first) return "new text";
  const points = [...first];
  return points.length > 14 ? `${points.slice(0, 14).join("")}…` : first;
}

function renderList() {
  const root = $("text-items");
  root.replaceChildren();
  $<HTMLInputElement>("text-on").checked = on;
  root.hidden = !on;
  const labels = items.map(label);
  const seen = new Map<string, number>();
  items.forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    const active = t.id === selected;
    b.className = `mini text-item${active ? " on" : ""}`;
    b.setAttribute("aria-pressed", String(active));
    const nth = (seen.get(labels[i]) ?? 0) + 1;
    seen.set(labels[i], nth);
    const twins = labels.filter((l) => l === labels[i]).length;
    b.textContent = twins > 1 ? `${labels[i]} ${nth}` : labels[i];
    b.title = "select this text";
    b.onclick = () => select(t.id);
    root.append(b);
  });
  const idle = !on || !current();
  $<HTMLButtonElement>("text-delete").disabled = idle;
  $<HTMLButtonElement>("text-dup").disabled = idle;
  $<HTMLButtonElement>("text-fit").disabled = idle;
  $<HTMLButtonElement>("text-center").disabled = idle;
  $("text-fields").hidden = idle;
}

function syncPosition(t: TextItem) {
  $<HTMLInputElement>("text-x").value = String(Math.round(t.ax));
  $<HTMLInputElement>("text-x-num").value = String(Math.round(t.ax));
  $<HTMLInputElement>("text-y").value = String(Math.round(t.ay));
  $<HTMLInputElement>("text-y-num").value = String(Math.round(t.ay));
}

function renderFields() {
  const t = current();
  if (!t) return;
  $<HTMLTextAreaElement>("text-text").value = t.text;
  if (document.activeElement !== $("text-font-search")) {
    $<HTMLInputElement>("text-font-search").value = catalog ? familyOf(t.font) : "";
  }
  stripPos($("text-font-strip"), face(t.font));
  const native = face(t.font)?.native ?? 0;
  for (const id of ["text-size", "text-size-num"]) {
    const el = $<HTMLInputElement>(id);
    el.step = native ? String(native) : "1";
    el.min = native ? String(native) : "4";
    el.value = String(t.size);
  }
  $<HTMLInputElement>("text-bold").checked = t.bold;
  $<HTMLSelectElement>("text-kind").value = t.kind;
  $<HTMLInputElement>("text-color").value = t.color;
  $<HTMLInputElement>("text-outline").checked = t.outline;
  $<HTMLInputElement>("text-outline-color").value = t.outlineColor;
  $<HTMLInputElement>("text-shadow").checked = t.shadow;
  $<HTMLInputElement>("text-shadow-color").value = t.shadowColor;
  for (const [id, v] of [
    ["text-shadow-x", t.shadowX],
    ["text-shadow-y", t.shadowY],
  ] as const) {
    $<HTMLInputElement>(id).value = String(v);
    $<HTMLInputElement>(`${id}-num`).value = String(v);
  }
  $("text-shadow-fields").hidden = !t.shadow;
  $<HTMLInputElement>("text-underline").checked = t.underline;
  $<HTMLInputElement>("text-gradient").checked = t.gradient;
  $<HTMLInputElement>("text-gradient-color").value = t.gradientColor;
  $<HTMLSelectElement>("text-gradient-dir").value = t.gradientDir;
  $<HTMLSelectElement>("text-align").value = t.align;
  $<HTMLInputElement>("text-line").value = String(t.lineHeight);
  $<HTMLInputElement>("text-tracking").value = String(t.tracking);
  $<HTMLInputElement>("text-ink").value = $<HTMLInputElement>("text-ink-num").value = String(t.ink);
  $<HTMLSelectElement>("text-rotate").value = String(t.rotate);
  $<HTMLInputElement>("text-mirror").checked = t.mirror;
  $<HTMLInputElement>("text-flip").checked = t.flip;
  $<HTMLInputElement>("text-stacked").checked = t.stacked;
  syncPosition(t);
  renderChips(t);
}

function renderChips(t: TextItem) {
  const style = styleOf(t);
  const kind = style.kind;
  for (const id of ["text-gradient", "text-gradient-color", "text-gradient-dir"]) {
    $<HTMLInputElement>(id).disabled = kind !== "smooth";
  }
  $("text-gradient-note").hidden = kind === "smooth";
  for (const id of ["text-ink", "text-ink-num"]) {
    $<HTMLInputElement>(id).disabled = kind !== "crisp";
  }
  const chip = $("text-kind-chip");
  chip.textContent =
    kind === "hinted"
      ? "one color, hard edges, letters fitted to the block grid, same in every browser"
      : kind === "smooth"
        ? "soft edges, dithered like the picture"
        : style.reason
          ? `${style.reason}, drawing crisp`
          : "one color, hard edges, no dither";
  const f = face(t.font);
  const note = $("text-font-note");
  if (catalogFailed) {
    note.textContent = "the font list did not load, drawing in a fallback font";
    note.hidden = false;
  } else if (failed.has(t.font)) {
    note.textContent = f
      ? "this font did not load, a fallback is drawn instead"
      : "this font is not in the list, a fallback is drawn instead";
    note.hidden = false;
  } else if (leftOut.get(t.id)) {
    note.textContent = `no font here has these characters, so they are left out ${leftOut.get(t.id)}`;
    note.hidden = false;
  } else if (f && !f.small && t.size < CRISP_BELOW) {
    note.textContent = "this face was judged for big text, letters may break apart under 20 blocks";
    note.hidden = false;
  } else if (f?.native) {
    note.textContent = `pixel face, sizes are multiples of ${f.native}`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  const snap = $("text-snap");
  const n = nearestEntry(t.color);
  snap.textContent = n ? `lands on ${n.name}, ${n.tone}` : "no map colors are on";
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function oklab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function nearestEntry(hex: string): PaletteEntry | null {
  if (!deps) return null;
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return null;
  const target = oklab([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  let best: PaletteEntry | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const e of deps.palette()) {
    const lab = oklab(e.rgb);
    const d = (lab[0] - target[0]) ** 2 + (lab[1] - target[1]) ** 2 + (lab[2] - target[2]) ** 2;
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

function snapHex(hex: string): string {
  const e = nearestEntry(hex);
  if (!e) return hex;
  return `#${e.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function refreshChips() {
  if (!deps) return;
  const t = current();
  if (t) renderChips(t);
}

function changed(source: "typing" | "other" = "other") {
  const t = current();
  if (t) {
    renderList();
    renderChips(t);
  }
  commit(source);
}

function addLine() {
  on = true;
  const t = defaults();
  if (items.length) t.ay = clamp(items[items.length - 1].ay + 20, 0, 100);
  items.push(t);
  select(t.id);
  $<HTMLTextAreaElement>("text-text").focus();
  commit();
}

function duplicateLine() {
  const t = current();
  if (!t) return;
  const copy = { ...structuredClone(t), id: newId(), ay: clamp(t.ay + 20, 0, 100) };
  items.splice(items.indexOf(t) + 1, 0, copy);
  select(copy.id);
  commit();
}

function deleteLine() {
  const t = current();
  if (!t) return;
  items = items.filter((x) => x.id !== t.id);
  selected = items[items.length - 1]?.id ?? null;
  renderList();
  renderFields();
  commit();
}

function deselect() {
  if (!selected) return;
  selected = null;
  renderList();
  restorePreview();
}

function nudge(dx: number, dy: number) {
  const t = current();
  if (!t) return;
  const [outW, outH] = deps.outSize();
  t.ax = clamp(t.ax + (dx * 100) / outW, 0, 100);
  t.ay = clamp(t.ay + (dy * 100) / outH, 0, 100);
  syncPosition(t);
  commit();
}

function bindKeys() {
  document.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (e.isComposing || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (el?.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z" && !e.shiftKey) {
      if (past.length) {
        e.preventDefault();
        undo();
      }
      return;
    }
    if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
      if (future.length) {
        e.preventDefault();
        redo();
      }
      return;
    }
    if (!on || !current()) return;
    if (mod && key === "d") {
      e.preventDefault();
      duplicateLine();
      return;
    }
    if (mod) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteLine();
      return;
    }
    if (e.key === "Escape") {
      deselect();
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = arrows[e.key];
    if (!d) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    nudge(d[0] * step, d[1] * step);
  });
}

function bind() {
  const upd = <K extends keyof TextItem>(
    id: string,
    key: K,
    read: (el: HTMLInputElement) => TextItem[K],
    ev = "input",
    source: "typing" | "other" = "other",
  ) => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener(ev, () => {
      const t = current();
      if (!t) return;
      t[key] = read(el);
      changed(source);
    });
  };
  upd("text-text", "text", (el) => el.value, "input", "typing");
  bindFontPicker();
  upd("text-underline", "underline", (el) => el.checked, "change");
  upd("text-gradient", "gradient", (el) => el.checked, "change");
  upd("text-gradient-color", "gradientColor", (el) => el.value);
  upd(
    "text-gradient-dir",
    "gradientDir",
    (el) => (el.value === "across" ? "across" : "down"),
    "change",
  );
  upd("text-rotate", "rotate", (el) => turn(el.value), "change");
  upd("text-mirror", "mirror", (el) => el.checked, "change");
  upd("text-flip", "flip", (el) => el.checked, "change");
  upd("text-stacked", "stacked", (el) => el.checked, "change");
  upd("text-bold", "bold", (el) => el.checked, "change");
  upd("text-kind", "kind", (el) => el.value as TextKind, "change");
  upd("text-color", "color", (el) => el.value);
  upd("text-outline", "outline", (el) => el.checked, "change");
  upd("text-outline-color", "outlineColor", (el) => el.value);
  upd("text-shadow", "shadow", (el) => el.checked, "change");
  $("text-shadow").addEventListener("change", () => {
    $("text-shadow-fields").hidden = !current()?.shadow;
  });
  upd("text-shadow-color", "shadowColor", (el) => el.value);
  upd("text-align", "align", (el) => el.value as TextAlign, "change");
  upd("text-line", "lineHeight", (el) => clamp(num(el.value, 1.2), 0.6, 3), "change");
  upd("text-tracking", "tracking", (el) => clamp(num(el.value, 0), -10, 40), "change");
  for (const [range, numId, key, lo, hi] of [
    ["text-size", "text-size-num", "size", 4, 512],
    ["text-ink", "text-ink-num", "ink", 64, 192],
    ["text-x", "text-x-num", "ax", 0, 100],
    ["text-y", "text-y-num", "ay", 0, 100],
    ["text-shadow-x", "text-shadow-x-num", "shadowX", -16, 16],
    ["text-shadow-y", "text-shadow-y-num", "shadowY", -16, 16],
  ] as const) {
    const r = $<HTMLInputElement>(range);
    const n = $<HTMLInputElement>(numId);
    const apply = (v: string) => {
      const t = current();
      if (!t) return;
      t[key] = clamp(num(v, t[key]), lo, hi);
      if (key === "size") snapSize(t);
      r.value = n.value = String(Math.round(t[key]));
      changed();
    };
    r.addEventListener("input", () => apply(r.value));
    n.addEventListener("change", () => apply(n.value));
  }
  $("text-on").addEventListener("change", () => {
    on = $<HTMLInputElement>("text-on").checked;
    renderList();
    renderFields();
    commit();
  });
  $("text-add").onclick = addLine;
  $("text-dup").onclick = duplicateLine;
  $("text-delete").onclick = deleteLine;
  $("text-undo").onclick = undo;
  $("text-redo").onclick = redo;
  $("text-fit").onclick = () => {
    void fitWidth();
  };
  $("text-center").onclick = () => {
    void centerVertically();
  };
}

async function fitWidth() {
  const t = current();
  if (!t) return;
  await loadCatalog().catch(() => undefined);
  await ensureFont(t.font).catch(() => undefined);
  const [outW, outH] = deps.outSize();
  const cv = new OffscreenCanvas(8, 8);
  const ctx = cv.getContext("2d")!;
  const probe = { ...t, size: 100 };
  prepare(ctx, probe);
  const widest = Math.max(...linesOf(t, renderableText(t)).map((l) => ctx.measureText(l).width), 1);
  const limit = t.rotate % 180 ? outH : outW;
  const native = face(t.font)?.native ?? 0;
  let size = Math.floor((100 * (limit - 2 * MARGIN)) / widest);
  if (native) size = Math.max(native, Math.floor(size / native) * native);
  t.size = clamp(size, 4, 512);
  renderFields();
  changed();
}

async function centerVertically() {
  const t = current();
  if (!t) return;
  await loadCatalog().catch(() => undefined);
  await ensureFont(t.font).catch(() => undefined);
  if (resolveKind(t) === "hinted") await ensureSheet(t.font).catch(() => undefined);
  const [outW, outH] = deps.outSize();
  const { ctx } = scratch("probe", outW, outH);
  const sheet = sheets.get(t.font);
  const box =
    styleOf(t).kind === "hinted" && sheet
      ? drawHintedItem(ctx, t, outW, outH, sheet)
      : drawItem(ctx, t, outW, outH);
  t.ay = clamp(t.ay + ((outH / 2 - (box.y + box.h / 2)) / outH) * 100, 0, 100);
  syncPosition(t);
  changed();
}

export function initText(d: Deps): void {
  deps = d;
  bind();
  bindKeys();
  wirePreview();
  renderList();
  committed = snap();
  syncHistoryButtons();
  void loadCatalog().catch(() => refreshChips());
}
