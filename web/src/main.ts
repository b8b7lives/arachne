import type {
  AuditDto, CandidateBlock, ExportOpts, GenerateOpts, GenerateResult,
  Adjust, HeightCapOpts, HeightCapResult, MapColor, MarginalErrors, OwnedTool, RankedDto,
  SharedPalette, SolverConfig, TierMeta,
  ToolMeta,
  SupportTotals, ViewModel, WorkerResponse,
} from "./types";
import { openView2D } from "./view2d";
import { unframe, zip, type ZipEntry } from "./zip";
import { extractPreset, PresetTable, presetToPalette } from "./mapartcraft";
import {
  BlockIndex, buildBlockIndex, clearWorkspace, KEY_LOADOUT_PRESETS, KEY_PALETTE_PRESETS,
  LoadoutPreset, loadPresets, loadWorkspace, newId, PalettePreset, persistenceAvailable,
  savePresets, saveWorkspace,
} from "./store";

const STACK = 64, SHULKER = 1728, DC = 3456;

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(opts: { width: number; height: number }): Promise<Window>;
    };
  }
}

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 1;
const pending = new Map<number, {
  resolve: (v: unknown) => void; reject: (e: Error) => void; touch: () => void;
}>();

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  if ("progress" in ev.data) {
    showProgress(ev.data.progress);
    pending.get(ev.data.id)?.touch();
    return;
  }
  const p = pending.get(ev.data.id);
  if (!p) return;
  pending.delete(ev.data.id);
  if (ev.data.ok) p.resolve(ev.data.result);
  else p.reject(new Error(ev.data.error));
};

function failAllPending(reason: string) {
  for (const [, p] of pending) p.reject(new Error(reason));
  pending.clear();
  status(reason);
}

worker.onerror = (e) => {
  const where = e.filename ? ` (${e.filename}:${e.lineno})` : "";
  failAllPending(`compute worker failed${where}: ${e.message || "unknown error"}`);
};
worker.onmessageerror = () => failAllPending("compute worker sent an unreadable message");

const RPC_TIMEOUT_MS = 60_000;

function rpc<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(
            `compute worker went silent on "${String(msg.cmd)}" for 60s`));
        }
      }, RPC_TIMEOUT_MS);
    };
    arm();
    const settle = (fn: (v: never) => void) => (v: never) => { clearTimeout(timer); fn(v); };
    pending.set(id, {
      resolve: settle(resolve as (v: never) => void) as (v: unknown) => void,
      reject: settle(reject as (v: never) => void) as (e: Error) => void,
      touch: arm,
    });
    try {
      worker.postMessage({ id, ...msg }, transfer);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e as Error);
    }
  });
}

let colors: MapColor[] = [];
let blocks: CandidateBlock[] = [];
let atlasCols = 32;
let atlasTile = 16;
let atlasUrl = "";
let toolMeta: Record<string, ToolMeta> = {};
let tierMeta: Record<string, TierMeta> = {};
let source: { bmp: ImageBitmap; name: string } | null = null;
let genResult: GenerateResult | null = null;
let rankedByColor = new Map<number, RankedDto[]>();
let marginalDeltas: Map<number, number> | null = null;
let tileMaterials: Record<string, number>[] | null = null;
let supportTotals: SupportTotals | null = null;
let supportTotalsSig: string | null = null;
let supportTotalsBusy = false;
let generateSeq = 0;
let marginalTotal = 0;
const selectionOverride = new Map<number, number>();
const deliberate = new Set<number>();
const enabled = new Set<number>();
let previewZoom = 1;
let previewHidden = false;
let previewInline = false;
const COLLAPSIBLE = ["loadout-panel", "io-panel", "solver-panel", "summary-panel"];
const collapsedSections = new Set<string>();
let blockIndex: BlockIndex | null = null;
declare const __BUILD_ID__: string;
declare const __BUILD_DATE__: string;

let dataVersion = 0;
let versions: string[] = [];
let dismissedStale = "";
let driftExpanded = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string, fallback: number) => Number(($(id) as HTMLInputElement).value) || fallback;
const maps = (id: string) => Math.min(16, Math.max(1, Math.round(num(id, 1))));
const checked = (id: string) => ($(id) as HTMLInputElement).checked;
const status = (t: string) => { $("status").textContent = t; };

function showProgress(fraction: number | null) {
  const bar = $("progress");
  const fill = $("progress-fill");
  if (fraction === null) { bar.classList.add("idle"); fill.style.width = "0%"; return; }
  bar.classList.remove("idle");
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

const DEFAULT_LOADOUT: OwnedTool[] = (["pickaxe", "axe", "shovel", "hoe"] as const).map(
  (kind) => ({ kind, tier: "netherite", efficiency: 5, silk: true, unbreaking: 3, mending: true }),
);
let loadout: OwnedTool[] = structuredClone(DEFAULT_LOADOUT);

interface Term {
  word: string;
  short: string;
  gloss: string;
  long: string;
}

const VOCAB: Record<string, Term> = {
  silk_gated: {
    word: "silk",
    gloss: "silk-touch-only blocks",
    short: "needs silk touch to recover the block itself",
    long: "Without Silk Touch, stone gives cobble and glass gives nothing at all. Off: only blocks that drop themselves with any tool.",
  },
  gravity: {
    word: "gravity",
    gloss: "blocks that fall",
    short: "falls without support",
    long: "Sand and gravel fall when the block beneath them goes missing. Off: kept out of your palette entirely.",
  },
  support_mandatory: {
    word: "support",
    gloss: "blocks needing something beneath",
    short: "needs a support block beneath",
    long: "Vanilla pops carpets and pressure plates off if nothing is underneath, however you place them, so the schematic adds filler. Off: only blocks that stand on their own.",
  },
  unstable: {
    word: "unstable",
    gloss: "blocks that change over time",
    short: "changes over time once placed (grass, ice, unwaxed copper, coral)",
    long: "Grass spreads and unwaxed copper oxidizes, so the map drifts away from what you built. Off: only blocks that stay exactly as placed.",
  },
  constrained: {
    word: "constrained",
    gloss: "blocks needing a specific base",
    short: "needs a specific substrate/neighbor to stay placed",
    long: "Wheat needs farmland and kelp needs water. Plain filler will not hold either. Off: only blocks that sit on anything.",
  },
  flammable: {
    word: "flammable",
    gloss: "blocks that burn",
    short: "can burn",
    long: "Fire spreads through wool and wood. Matters if the build sits near lava or in the Nether. Off: nothing that burns.",
  },
  unrecoverable: {
    word: "can't recover",
    gloss: "blocks you can't get back",
    short: "no way to get this block back with your current tools",
    long: "Your loadout has no way to get these back when you tear the map down, so you would be spending them permanently. Off: hide them.",
  },
  class_match_only: {
    word: "match my loadout",
    gloss: "only blocks my tools are made for",
    short: "your loadout has no tool of the class this block wants",
    long: "For strict palettes such as silk pick only. Hides anything your loadout carries no matching tool for, even where you could still break it slowly. On: a pickaxe-only palette really is pickaxe-only.",
  },
};

const TOGGLE_DEFS: [string, boolean][] = [
  ["gravity", true],
  ["support_mandatory", true],
  ["silk_gated", true],
  ["flammable", true],
  ["unrecoverable", true],
  ["unstable", true],
  ["constrained", true],
  ["class_match_only", false],
];

function term(key: string): Term {
  return VOCAB[key] ?? VOCAB[key.replace(/s$/, "")] ?? {
    word: key, short: key, gloss: key, long: key,
  };
}

const toggles: Record<string, boolean> = Object.fromEntries(
  TOGGLE_DEFS.map(([k, v]) => [k, v]),
);

const FIELDS: [string, "value" | "checked"][] = [
  ["maps-w", "value"], ["maps-h", "value"], ["fit", "value"], ["honor-alpha", "checked"],
  ["alpha-threshold", "value"],
  ["crop-zoom", "value"], ["crop-x", "value"], ["crop-y", "value"],
  ["dither", "value"], ["dbs-refine", "checked"], ["game-version", "value"],
  ["height-mode", "value"], ["cliff-cap", "value"], ["max-height", "value"],
  ["support-mode", "value"], ["support-block", "value"], ["grid-overlay", "checked"],
  ["split-export", "checked"], ["first-map-id", "value"], ["borrow-edge", "checked"],
  ["mapdat-on", "checked"], ["sheet-on", "checked"],
  ["export-name", "value"],
  ["adjust-on", "checked"], ["bg-mode", "value"], ["bg-color", "value"],
  ["adj-brightness", "value"], ["adj-contrast", "value"], ["adj-saturation", "value"],
  ["adj-temperature", "value"], ["adj-tint", "value"],
  ["palette-view", "value"], ["palette-sort", "value"], ["materials-basis", "value"],
  ["tile-size", "value"],
  ["haste", "value"], ["flying", "checked"], ["no-cooldown", "checked"],
];
const LOADOUT_FIELDS = ["haste", "flying", "no-cooldown"];
let factoryFields: Record<string, string | boolean> = {};

function fieldValues(only?: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [id, prop] of FIELDS) {
    if (only && !only.includes(id)) continue;
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) out[id] = prop === "checked" ? (el as HTMLInputElement).checked : el.value;
  }
  return out;
}

function applyFields(vals: Record<string, string | boolean> | undefined) {
  if (!vals) return;
  applyFieldValues(vals);
  for (const [id, prop] of FIELDS) {
    if (prop !== "value") continue;
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el?.type === "number") clampNumberField(el);
  }
}

function applyFieldValues(vals: Record<string, string | boolean>) {
  for (const [id, prop] of FIELDS) {
    if (!(id in vals)) continue;
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    if (prop === "checked") (el as HTMLInputElement).checked = Boolean(vals[id]);
    else el.value = String(vals[id]).slice(0, 500);
  }
}

function pickKeys(): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const [cid, idx] of selectionOverride) {
    const key = blockIndex?.keyOf(idx);
    if (key) picks[String(cid)] = key;
  }
  return picks;
}

function applyPicks(picks: Record<string, string> | undefined, informed?: number[]) {
  selectionOverride.clear();
  deliberate.clear();
  for (const [cid, key] of Object.entries(picks ?? {}).slice(0, 256)) {
    const id = Number(cid);
    if (!colors.some((c) => c.id === id)) continue;
    const idx = blockIndex?.indexOf(String(key));
    if (idx !== undefined) selectionOverride.set(id, idx);
  }
  const marks = Array.isArray(informed) ? informed.slice(0, 256) : [];
  for (const cid of marks) if (selectionOverride.has(cid)) deliberate.add(cid);
}

function toolsForWasm(): OwnedTool[] {
  return loadout.map(({ nick: _nick, ...rest }) => rest);
}

function persist() {
  saveWorkspace({
    enabled: [...enabled].sort((a, b) => a - b),
    picks: pickKeys(),
    deliberate: [...deliberate].sort((a, b) => a - b),
    tools: structuredClone(loadout),
    toggles: { ...toggles },
    fields: fieldValues(),
    previewZoom,
    previewHidden,
    previewInline,
    dismissedStale,
    collapsed: [...collapsedSections].sort(),
  });
}

const GRAY_SAT = 0.15;

function saturation(c: MapColor): number {
  const mx = Math.max(...c.rgb), mn = Math.min(...c.rgb);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

function defaultToggles(): Record<string, boolean> {
  return Object.fromEntries(TOGGLE_DEFS.map(([k, v]) => [k, v]));
}

function pickToggles(keys: string[], src: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));
}

function familyPreset(id: string, name: string, match: (id: string) => boolean): PalettePreset {
  const enabled: number[] = [];
  const picks: Record<string, string> = {};
  for (const c of colors) {
    const idx = blocks.findIndex((b) => b.color_id === c.id && match(b.block_id));
    const key = idx < 0 ? undefined : blockIndex?.keyOf(idx);
    if (!key) continue;
    enabled.push(c.id);
    picks[String(c.id)] = key;
  }
  return { id, name, builtin: true, enabled, picks, toggles: blockFilterDefaults() };
}

function blockFilterDefaults(): Record<string, boolean> {
  return pickToggles(BLOCK_FILTER_KEYS, defaultToggles());
}

function fluidOnly(cid: number): boolean {
  const cands = blocks.filter((b) => b.color_id === cid);
  return cands.length > 0 && cands.every((b) => b.fluid);
}

function builtinPalettes(): PalettePreset[] {
  return [
    {
      id: "builtin:full", name: "every color", builtin: true,
      enabled: colors.map((c) => c.id), picks: {}, toggles: blockFilterDefaults(),
    },
    {
      id: "builtin:survival", name: "survival default", builtin: true,
      enabled: colors.filter((c) => !fluidOnly(c.id)).map((c) => c.id), picks: {},
      toggles: blockFilterDefaults(),
    },
    {
      id: "builtin:gray", name: "grayscale", builtin: true,
      enabled: colors.filter((c) => saturation(c) < GRAY_SAT).map((c) => c.id), picks: {},
      toggles: blockFilterDefaults(),
    },
    familyPreset("builtin:carpet", "carpets only", (b) => b.endsWith("_carpet")),
    familyPreset(
      "builtin:concrete", "concrete + terracotta",
      (b) => b.endsWith("_concrete") || b === "terracotta"
        || (b.endsWith("_terracotta") && !b.endsWith("_glazed_terracotta")),
    ),
  ];
}

function builtinLoadouts(): LoadoutPreset[] {
  const env = { haste: "0", flying: false };
  return [
    {
      id: "builtin:kit", name: "full silk kit", builtin: true,
      tools: structuredClone(DEFAULT_LOADOUT),
      toggles: pickToggles(LOADOUT_FILTER_KEYS, defaultToggles()), fields: { ...env },
    },
    {
      id: "builtin:silkpick", name: "silk pickaxe only", builtin: true,
      tools: [{
        kind: "pickaxe", tier: "netherite", efficiency: 5, silk: true,
        unbreaking: 3, mending: true,
      }],
      toggles: { ...pickToggles(LOADOUT_FILTER_KEYS, defaultToggles()), class_match_only: true },
      fields: { ...env },
    },
    {
      id: "builtin:pick", name: "pickaxe only", builtin: true,
      tools: [{
        kind: "pickaxe", tier: "netherite", efficiency: 5, silk: false,
        unbreaking: 3, mending: true,
      }],
      toggles: { ...pickToggles(LOADOUT_FILTER_KEYS, defaultToggles()), class_match_only: true },
      fields: { ...env },
    },
  ];
}

function palettePresets(): PalettePreset[] {
  return [...builtinPalettes(), ...loadPresets<PalettePreset>(KEY_PALETTE_PRESETS)];
}

function loadoutPresets(): LoadoutPreset[] {
  return [...builtinLoadouts(), ...loadPresets<LoadoutPreset>(KEY_LOADOUT_PRESETS)];
}

function paletteSig(p: Pick<PalettePreset, "enabled" | "picks" | "toggles">): string {
  return JSON.stringify([
    [...p.enabled].sort((a, b) => a - b),
    Object.entries(p.picks).sort(([a], [b]) => Number(a) - Number(b)),
    Object.entries(pickToggles(BLOCK_FILTER_KEYS, p.toggles ?? toggles)).sort(),
  ]);
}

function loadoutSig(p: Pick<LoadoutPreset, "tools" | "toggles" | "fields">): string {
  const tools = p.tools.map((t) => [
    t.kind, t.tier, t.efficiency, t.silk, t.nick ?? "",
    t.unbreaking ?? 0, Boolean(t.mending), Boolean(t.unbreakable),
  ]);
  return JSON.stringify([
    tools,
    Object.entries(pickToggles(LOADOUT_FILTER_KEYS, p.toggles)).sort(),
    Object.entries(p.fields).sort(),
  ]);
}

function currentPalette(): Pick<PalettePreset, "enabled" | "picks" | "deliberate" | "toggles"> {
  return {
    enabled: [...enabled],
    picks: pickKeys(),
    deliberate: [...deliberate],
    toggles: pickToggles(BLOCK_FILTER_KEYS, toggles),
  };
}

function currentLoadout(): Pick<LoadoutPreset, "tools" | "toggles" | "fields"> {
  return {
    tools: loadout,
    toggles: pickToggles(LOADOUT_FILTER_KEYS, toggles),
    fields: fieldValues(LOADOUT_FIELDS),
  };
}

function fillPresetSelect(
  sel: HTMLSelectElement,
  list: { id: string; name: string; builtin?: boolean }[],
) {
  sel.innerHTML = "";
  sel.add(new Option("(unsaved)", ""));
  for (const [label, members] of [
    ["Arachne presets", list.filter((p) => p.builtin)],
    ["Your presets", list.filter((p) => !p.builtin)],
  ] as const) {
    if (!members.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const p of members) group.append(new Option(p.name, p.id));
    sel.add(group);
  }
}

function syncPresetSelects() {
  const ps = $("palette-preset") as HTMLSelectElement | null;
  if (ps) {
    const sig = paletteSig(currentPalette());
    const match = palettePresets().find((p) => paletteSig(p) === sig);
    ps.value = match?.id ?? "";
    const meta = document.getElementById("palette-meta");
    if (meta) {
      meta.textContent = match?.name ?? "edited, not saved";
      meta.title = match
        ? "the palette matches this saved preset"
        : "the palette matches no saved preset; save it to keep it under a name";
    }
  }
  const ls = $("loadout-preset") as HTMLSelectElement | null;
  if (ls) {
    const sig = loadoutSig(currentLoadout());
    ls.value = loadoutPresets().find((p) => loadoutSig(p) === sig)?.id ?? "";
  }
}

function applyPalettePreset(p: PalettePreset) {
  enabled.clear();
  for (const id of p.enabled) enabled.add(id);
  applyPicks(p.picks, p.deliberate);
  const filters = pickToggles(BLOCK_FILTER_KEYS, p.toggles ?? {});
  for (const [k, v] of Object.entries(filters)) setToggle(k, v);
  dismissedStale = "";
  if (Object.keys(filters).length) void refreshSolver();
  else renderPalette();
  scheduleGenerate();
  if (genResult) renderSummary();
}

function applyLoadoutPreset(p: LoadoutPreset) {
  loadout = sanitizeTools(p.tools);
  if (!loadout.length) loadout = structuredClone(DEFAULT_LOADOUT);
  for (const [k, v] of Object.entries(pickToggles(LOADOUT_FILTER_KEYS, p.toggles))) {
    setToggle(k, v);
  }
  applyFields(p.fields);
  dismissedStale = "";
  renderLoadout();
  void refreshSolver();
}

function wirePresetBar<T extends { id: string; name: string; builtin?: boolean }>(
  kind: "palette" | "loadout",
  key: string,
  list: () => T[],
  capture: (name: string, id: string) => T,
  apply: (p: T) => void,
) {
  const sel = $(`${kind}-preset`) as HTMLSelectElement;
  const refresh = () => { fillPresetSelect(sel, list()); syncPresetSelects(); };
  const users = () => loadPresets<T>(key);
  const selected = () => list().find((p) => p.id === sel.value);

  sel.onchange = () => {
    const p = selected();
    if (p) apply(p);
    else syncPresetSelects();
  };
  $(`${kind}-preset-save`).onclick = () => {
    const cur = selected();
    const suggestion = cur && !cur.builtin ? cur.name : "";
    const name = prompt(`Name for this ${kind} preset:`, suggestion)?.trim();
    if (!name) return;
    const saved = users();
    const existing = saved.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing && !confirm(`Overwrite "${existing.name}"?`)) return;
    const id = existing?.id ?? newId();
    const next = capture(name, id);
    savePresets(key, existing ? saved.map((p) => (p.id === id ? next : p)) : [...saved, next]);
    refresh();
    sel.value = id;
    persist();
  };
  $(`${kind}-preset-rename`).onclick = () => {
    const p = selected();
    if (!p || p.builtin) { status("pick one of your own presets to rename"); return; }
    const name = prompt("New name:", p.name)?.trim();
    if (!name) return;
    savePresets(key, users().map((q) => (q.id === p.id ? { ...q, name } : q)));
    refresh();
    sel.value = p.id;
  };
  $(`${kind}-preset-delete`).onclick = () => {
    const p = selected();
    if (!p || p.builtin) { status("built-in presets can't be deleted"); return; }
    if (!confirm(`Delete "${p.name}"?`)) return;
    savePresets(key, users().filter((q) => q.id !== p.id));
    refresh();
  };
  refresh();
}

const pickCost = (r: RankedDto) => r.recovery_ticks ?? Number.MAX_SAFE_INTEGER;

interface DriftRow {
  cid: number;
  cur: RankedDto;
  top: RankedDto;
  delta: number;
}

function pickDrift(): { stale: DriftRow[]; hidden: number[]; unusable: number[] } {
  const stale: DriftRow[] = [], hidden: number[] = [], unusable: number[] = [];
  for (const cid of enabled) {
    if (!(rankedByColor.get(cid)?.length ?? 0)) unusable.push(cid);
  }
  for (const [cid, idx] of selectionOverride) {
    if (!enabled.has(cid)) continue;
    const ranked = rankedByColor.get(cid);
    if (!ranked?.length) continue;
    const cur = ranked.find((r) => r.block_index === idx);
    if (!cur) hidden.push(cid);
    else if (deliberate.has(cid)) continue;
    else if (cur.block_index !== ranked[0].block_index && pickCost(cur) > pickCost(ranked[0])) {
      const top = ranked[0];
      const delta = cur.recovery_ticks === null
        ? Infinity
        : pickCost(cur) - pickCost(top);
      stale.push({ cid, cur, top, delta });
    }
  }
  return {
    stale: stale.sort((a, b) => b.delta - a.delta || a.cid - b.cid),
    hidden: hidden.sort((a, b) => a - b),
    unusable: unusable.sort((a, b) => a - b),
  };
}

let currentDrift: { stale: DriftRow[]; hidden: number[]; unusable: number[] } =
  { stale: [], hidden: [], unusable: [] };
let driftByColor = new Map<number, DriftRow>();

function ticksText(ticks: number): string {
  if (!Number.isFinite(ticks)) return "∞";
  const sec = ticks / 20;
  return sec < 1 ? `${sec.toFixed(2)}s` : sec < 60 ? `${sec.toFixed(1)}s` : fmtDuration(ticks);
}

function driftSaving(d: DriftRow): { each: string; total: string | null } {
  const each = ticksText(d.delta);
  const count = genResult?.materials[String(d.cid)] ?? 0;
  if (!count || !Number.isFinite(d.delta)) return { each, total: null };
  return { each, total: fmtDuration(d.delta * count) };
}

function colorNames(ids: number[], max = 4): string {
  const names = ids.map((id) => colors.find((c) => c.id === id)?.name ?? `color ${id}`);
  return names.length <= max
    ? names.join(", ")
    : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

function driftTable(stale: DriftRow[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "drift-table";
  const cols = ["9rem", "12rem", "auto", "5.5rem", "6.5rem", "3.5rem"];
  const colgroup = document.createElement("colgroup");
  for (const w of cols) {
    const col = document.createElement("col");
    if (w !== "auto") col.style.width = w;
    colgroup.append(col);
  }
  table.append(colgroup);
  table.innerHTML += "<thead><tr><th>color</th><th>your pick</th><th>cheapest now</th>"
    + "<th class=\"num\">saves each</th><th class=\"num\">over this picture</th><th></th></tr></thead>";
  const body = document.createElement("tbody");
  for (const d of stale) {
    const c = colors.find((x) => x.id === d.cid);
    const tr = document.createElement("tr");
    const td = (...kids: (Node | string)[]) => {
      const cell = document.createElement("td");
      cell.append(...kids);
      return cell;
    };
    const blockCell = (r: RankedDto, withFlags: boolean) => {
      const name = document.createElement("span");
      name.className = "bname";
      name.textContent = `${r.display_name} · ${costText(r)}`;
      name.title = costTitle(r);
      const kids: (Node | string)[] = [cell(tileEl(r.block_index, "tile small"), name)];
      if (withFlags) {
        const flags = document.createElement("div");
        flags.className = "drift-flags";
        flags.innerHTML = flagsInline(r);
        if (flags.innerHTML) kids.push(flags);
      }
      return td(...kids);
    };
    const { each, total } = driftSaving(d);
    tr.append(td(cell(swatchEl(c!, true), c?.name ?? String(d.cid))));
    tr.append(blockCell(d.cur, false));
    tr.append(blockCell(d.top, true));
    const eachTd = td(d.delta === Infinity ? "makes it recoverable" : each);
    eachTd.className = "num";
    tr.append(eachTd);
    const totalTd = td(total ?? "n/a");
    totalTd.className = "num";
    totalTd.title = total ? "the whole saving for this picture" : "load an image to see the total";
    tr.append(totalTd);
    const use = document.createElement("button");
    use.className = "mini";
    use.textContent = "use it";
    use.title = `switch ${c?.name ?? "this color"} to ${d.top.display_name}`;
    use.onclick = () => {
      selectionOverride.delete(d.cid);
      deliberate.delete(d.cid);
      renderPalette();
      if (genResult) renderSummary();
    };
    tr.append(td(use));
    body.append(tr);
  }
  table.append(body);
  return table;
}

function syncVersionNote() {
  const v = gameVersion();
  const shown = colors.filter((c) => colorExists(c.id)).length;
  const newest = versions[versions.length - 1];
  $("version-note").textContent = v === newest
    ? `${shown} map colors, everything this data knows`
    : `${shown} of ${colors.length} map colors, and only blocks ${v} shipped with`;
}

function renderPickDrift() {
  const div = $("palette-notice");
  const { stale, hidden, unusable } = currentDrift;
  const sig = `${stale.map((d) => d.cid).join(",")}|${hidden.join(",")}`;
  div.innerHTML = "";
  if (unusable.length) {
    const p = document.createElement("p");
    p.className = "note warn-orange";
    p.textContent = `${unusable.length} color${unusable.length > 1 ? "s" : ""} in your palette ` +
      `${unusable.length > 1 ? "have" : "has"} no block your filters allow ` +
      `(${colorNames(unusable)}). ${unusable.length > 1 ? "They place" : "It places"} no blocks, ` +
      "the same as turning them off. Your pick comes back when you re-enable a filter.";
    div.append(p);
  }
  if (hidden.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = `${hidden.length} of your picks ${hidden.length > 1 ? "are" : "is"} hidden by ` +
      `your current filters (${colorNames(hidden)}). The cheapest available block is shown ` +
      "instead. Your pick comes back when you re-enable the filter.";
    div.append(p);
  }
  if (!stale.length || sig === dismissedStale) return;
  const bar = document.createElement("div");
  bar.className = "drift-banner";
  const msg = document.createElement("span");
  const worth = stale.reduce((n, d) => n + (Number.isFinite(d.delta)
    ? d.delta * (genResult?.materials[String(d.cid)] ?? 0) : 0), 0);
  msg.textContent = `${stale.length} of your picks ${stale.length > 1 ? "aren't" : "isn't"} ` +
    `the cheapest with this loadout` +
    (worth ? `, costing ${fmtDuration(worth)} of extra breaking on this picture.` : ".");
  const compare = document.createElement("button");
  compare.className = "mini";
  compare.textContent = "compare";
  compare.title = "see what each pick costs against the cheapest";
  const adopt = document.createElement("button");
  adopt.className = "mini";
  adopt.textContent = `use the cheapest for ${stale.length > 1 ? "these" : "this"}`;
  adopt.title = "drop those overrides and follow the cheapest block again";
  adopt.onclick = () => {
    for (const d of stale) { selectionOverride.delete(d.cid); deliberate.delete(d.cid); }
    dismissedStale = "";
    renderPalette();
    if (genResult) renderSummary();
  };
  const keep = document.createElement("button");
  keep.className = "mini";
  keep.textContent = "keep mine";
  keep.title = "your palette stays as it is; the notice comes back if it changes again";
  keep.onclick = () => { dismissedStale = sig; renderPickDrift(); persist(); };
  bar.append(msg, compare, adopt, keep);
  div.append(bar);

  const detail = driftTable(stale);
  detail.hidden = !driftExpanded;
  compare.onclick = () => {
    driftExpanded = !driftExpanded;
    detail.hidden = !driftExpanded;
    compare.textContent = driftExpanded ? "hide" : "compare";
  };
  compare.textContent = driftExpanded ? "hide" : "compare";
  div.append(detail);
}

function clampNumberField(el: HTMLInputElement) {
  if (el.value.trim() === "") return;
  const n = Number(el.value);
  if (!Number.isFinite(n)) {
    el.value = el.defaultValue;
    return;
  }
  const lo = el.min === "" ? -Infinity : Number(el.min);
  const hi = el.max === "" ? Infinity : Number(el.max);
  const clamped = Math.min(hi, Math.max(lo, n));
  if (clamped !== n) el.value = String(clamped);
}

function bufferNumberFields(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
    el.addEventListener("change", () => clampNumberField(el));
  }
}

let presetTable: PresetTable | null = null;
let beforeImport: SettingsFile | null = null;

function ioResult(text: string, bad = false) {
  const el = $("io-result");
  el.hidden = false;
  el.textContent = text;
  el.className = bad ? "note warn-orange" : "note";
}

async function loadPresetTable(): Promise<PresetTable> {
  if (!presetTable) {
    const res = await fetch(`${import.meta.env.BASE_URL}mapartcraft-presets-26.2.json`);
    if (!res.ok) throw new Error(`preset table: HTTP ${res.status}`);
    presetTable = (await res.json()) as PresetTable;
  }
  return presetTable;
}

interface SettingsFile {
  arachne: number;
  data_version?: number;
  enabled: number[];
  picks: Record<string, string>;
  deliberate?: number[];
  tools?: OwnedTool[];
  toggles?: Record<string, boolean>;
  fields?: Record<string, string | boolean>;
}

function snapshot(): SettingsFile {
  return {
    arachne: 1,
    data_version: dataVersion,
    ...currentPalette(),
    tools: structuredClone(loadout),
    toggles: { ...toggles },
    fields: fieldValues(),
  };
}

function exportSettings() {
  const doc = snapshot();
  const name = exportName();
  download(`${name}-settings.json`,
    new TextEncoder().encode(JSON.stringify(doc, null, 1)).buffer as ArrayBuffer);
  ioResult(`Saved ${name}-settings.json with your palette, picks, loadout and settings.`);
}

function applySettingsFile(doc: SettingsFile) {
  const imported = sanitizeTools(doc.tools);
  if (imported.length) loadout = imported;
  for (const [k, v] of Object.entries(doc.toggles ?? {})) {
    if (Object.hasOwn(toggles, k)) setToggle(k, Boolean(v));
  }
  applyFields(doc.fields);
  enabled.clear();
  const ids = Array.isArray(doc.enabled) ? doc.enabled.slice(0, 256) : [];
  for (const id of ids) if (colors.some((c) => c.id === id)) enabled.add(id);
  applyPicks(doc.picks, doc.deliberate);
  dismissedStale = "";
  renderLoadout();
  syncCropControls();
  syncMapdatControls();
  syncAdjustControls();
  honorAlphaUser = null;
  syncBackgroundControls();
  syncHeightControls();
  persist();
  void refreshSolver();
  scheduleGenerate();
  const stale = doc.data_version && doc.data_version !== dataVersion
    ? ` (saved on data version ${doc.data_version}, this is ${dataVersion})` : "";
  ioResult(`Imported settings: ${enabled.size} colors${stale}.`);
}

function offerUndo() {
  const undo = document.createElement("button");
  undo.className = "mini";
  undo.textContent = "undo";
  undo.title = "put back the palette and loadout from before this import";
  undo.onclick = () => {
    if (!beforeImport) return;
    applySettingsFile(beforeImport);
    beforeImport = null;
    ioResult("Import undone.");
  };
  $("io-result").append(" ", undo);
}

const SHARE_LINK = /#p=([A-Za-z0-9_-]{7,})\s*$/;
const BARE_CODE = /^1[A-Za-z0-9_-]{6,63}$/;

function sharePalette(quiet = false): SharedPalette | null {
  const ids = usableIds();
  if (!ids.length) {
    if (!quiet) {
      ioResult("no color in your palette has a block your filters allow, so there is "
        + "nothing to share yet", true);
    }
    return null;
  }
  const picks: Record<string, string> = {};
  for (const cid of ids) {
    const r = chosen(cid);
    const key = r ? blockIndex?.keyOf(r.block_index) : undefined;
    if (!key) continue;
    picks[String(cid)] = key;
  }
  return { enabled: ids, picks, version: gameVersion() };
}

async function copyShareLink() {
  const palette = sharePalette();
  if (!palette) return;
  try {
    const code = await rpc<string>({ cmd: "share_code", palette });
    const url = `${location.origin}${location.pathname}#p=${code}`;
    const out = $("share-out") as HTMLInputElement;
    $("share-row").hidden = false;
    out.value = url;
    out.select();
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      copied = false;
    }
    ioResult(`${palette.enabled.length} colors in ${url.length} characters, `
      + (copied ? "copied to your clipboard." : "selected above; copy it yourself."));
  } catch (e) {
    ioResult(String(e).replace(/^Error:\s*/, ""), true);
  }
}

async function applyShareCode(code: string, announce: boolean) {
  const shared = await rpc<SharedPalette>({ cmd: "read_share_code", code });
  const vsel = $("game-version") as HTMLSelectElement;
  const switched = shared.version && shared.version !== vsel.value ? shared.version : "";
  if (switched) vsel.value = switched;
  enabled.clear();
  for (const id of shared.enabled) enabled.add(id);
  applyPicks(shared.picks, shared.enabled);
  dismissedStale = "";
  renderPalette();
  persist();
  await refreshSolver();
  if (genResult) { renderSummary(); scheduleGenerate(); }
  if (announce) {
    ioResult(`Loaded ${shared.enabled.length} colors from a shared palette`
      + (switched ? `, made for ${switched}, so it switched to that.` : "."));
  }
}

async function consumeShareHash() {
  const incoming = SHARE_LINK.exec(location.hash);
  if (!incoming) return;
  history.replaceState(null, "", location.pathname + location.search);
  await applyShareCode(incoming[1], true)
    .catch((e) => ioResult(String(e).replace(/^Error:\s*/, ""), true));
}

async function importText(text: string, sourceName: string) {
  const trimmed = text.trim();
  beforeImport = snapshot();
  const share = SHARE_LINK.exec(trimmed);
  if (share) {
    await applyShareCode(share[1], true);
    offerUndo();
    return;
  }
  if (BARE_CODE.test(trimmed)) {
    try {
      await applyShareCode(trimmed, true);
      offerUndo();
      return;
    } catch {
      beforeImport = snapshot();
    }
  }
  if (trimmed.startsWith("{")) {
    let doc: SettingsFile;
    try {
      doc = JSON.parse(trimmed) as SettingsFile;
    } catch {
      throw new Error(
        `${sourceName} does not read as a settings file; it may have been cut short`);
    }
    if (!doc || typeof doc !== "object" || !doc.enabled) {
      throw new Error("that JSON is not an Arachne settings file");
    }
    applySettingsFile(doc);
    offerUndo();
    return;
  }
  const preset = extractPreset(trimmed);
  if (!preset) throw new Error(`${sourceName}: no mapartcraft preset or settings found`);
  const table = await loadPresetTable();
  const imported = presetToPalette(preset, table,
    (key) => blockIndex?.indexOf(key) !== undefined);
  if (!imported.enabled.length) throw new Error("that preset did not name any usable colors");
  applyPalettePreset({
    id: "", name: "imported", ...imported, deliberate: imported.enabled,
  });
  const skipped = imported.skipped
    ? ` · ${imported.skipped} entr${imported.skipped > 1 ? "ies" : "y"} skipped (not in 26.2)` : "";
  ioResult(`Imported ${imported.enabled.length} colors from a mapartcraft palette${skipped}.`);
  offerUndo();
}

const TOOL_KINDS: OwnedTool["kind"][] = ["pickaxe", "axe", "shovel", "hoe", "shears"];
const TOOL_TIERS: OwnedTool["tier"][] =
  ["wood", "stone", "copper", "iron", "diamond", "netherite", "gold"];

function sanitizeTools(raw: unknown): OwnedTool[] {
  if (!Array.isArray(raw)) return [];
  const int = (v: unknown, hi: number) =>
    Math.min(hi, Math.max(0, Math.round(Number(v)) || 0));
  return raw.slice(0, 16).map((t) => {
    const o = (t ?? {}) as Partial<OwnedTool>;
    const tool: OwnedTool = {
      kind: TOOL_KINDS.includes(o.kind as OwnedTool["kind"]) ? o.kind! : "pickaxe",
      tier: TOOL_TIERS.includes(o.tier as OwnedTool["tier"]) ? o.tier! : "netherite",
      efficiency: int(o.efficiency, 255),
      silk: Boolean(o.silk),
      unbreaking: int(o.unbreaking, 255),
      mending: Boolean(o.mending),
      unbreakable: Boolean(o.unbreakable),
    };
    const nick = typeof o.nick === "string" ? o.nick.trim().slice(0, 40) : "";
    if (nick) tool.nick = nick;
    return tool;
  });
}

function gameVersion(): string {
  return ($("game-version") as HTMLSelectElement).value || versions[versions.length - 1] || "";
}

function versionIndex(v: string): number {
  return versions.indexOf(v);
}

function colorExists(cid: number): boolean {
  const c = colors.find((x) => x.id === cid);
  if (!c?.since) return true;
  return versionIndex(c.since) <= versionIndex(gameVersion());
}

function solverConfig(): SolverConfig {
  return {
    env: { haste: num("haste", 0), flying: checked("flying") },
    version: gameVersion(),
    toggles: { ...toggles },
  };
}

function autoToolName(t: OwnedTool): string {
  return (toolMeta[t.kind]?.tiered ?? true) ? `${t.tier} ${t.kind}` : t.kind;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function toolDetail(t: OwnedTool): string {
  const extras = [t.silk ? "silk touch" : "", t.efficiency ? `efficiency ${t.efficiency}` : ""]
    .filter(Boolean).join(", ");
  const full = extras ? `${autoToolName(t)} (${extras})` : autoToolName(t);
  return t.nick ? `${t.nick} (${full})` : full;
}

function enchantBox(
  cls: string,
  label: string,
  help: string,
  value: boolean,
  disabled: boolean,
  on: (v: boolean) => void,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "ench";
  wrap.title = help;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = cls;
  cb.checked = value;
  cb.disabled = disabled;
  cb.onchange = () => on(cb.checked);
  wrap.append(cb, ` ${label}`);
  if (disabled) wrap.classList.add("muted");
  return wrap;
}

const NICK_EXAMPLES: Record<string, string> = {
  pickaxe: "ex: Fortunate Son",
  shovel: "ex: Scoop Dogg",
  axe: "ex: Axel Rose",
  hoe: "ex: Vincent van Hoe",
  shears: "ex: Edward Shearhands",
};

function enchantLevel(
  cls: string,
  label: string,
  help: string,
  value: number,
  disabled: boolean,
  on: (el: HTMLInputElement) => void,
  vanillaCap?: number,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "ench-field";
  wrap.title = help;
  const name = document.createElement("span");
  name.className = "ench-name";
  name.textContent = label;
  const box = document.createElement("input");
  box.type = "number"; box.min = "0"; box.max = "255";
  box.className = cls;
  box.value = String(value);
  box.disabled = disabled;
  wrap.append(name, box);
  if (vanillaCap !== undefined) {
    const flag = document.createElement("span");
    flag.className = "ench-beyond";
    flag.textContent = "beyond vanilla";
    flag.title = `vanilla ${label} stops at ${vanillaCap}; mods and servers go higher. `
      + "Priced the same either way";
    const syncFlag = () => { flag.hidden = (Number(box.value) || 0) <= vanillaCap; };
    box.onchange = () => { clampNumberField(box); syncFlag(); on(box); };
    syncFlag();
    wrap.append(flag);
  } else {
    box.onchange = () => { clampNumberField(box); on(box); };
  }
  if (disabled) wrap.classList.add("muted");
  return wrap;
}

function renderLoadout() {
  const list = $("loadout");
  list.innerHTML = "";
  loadout.forEach((t, i) => {
    const item = document.createElement("div");
    item.className = "tool-item";
    const sel = (cls: string, opts: string[], value: string, on: (v: string) => void) => {
      const s = document.createElement("select");
      s.className = cls;
      for (const o of opts) s.add(new Option(o, o));
      s.value = value;
      s.onchange = () => { on(s.value); refreshSolver(); };
      return s;
    };
    const meta = toolMeta[t.kind] ?? { efficiency: true, silk_touch: true, tiered: true };

    const head = document.createElement("div");
    head.className = "tool-head";
    if (meta.tiered) {
      head.append(sel("tool-tier",
        ["wood", "stone", "copper", "iron", "diamond", "netherite", "gold"],
        t.tier, (v) => (t.tier = v as OwnedTool["tier"])));
    }
    head.append(sel("tool-kind", ["pickaxe", "axe", "shovel", "hoe", "shears"], t.kind, (v) => {
      t.kind = v as OwnedTool["kind"];
      renderLoadout();
    }));
    const nick = document.createElement("input");
    nick.type = "text";
    nick.className = "nick";
    nick.value = t.nick ?? "";
    nick.placeholder = NICK_EXAMPLES[t.kind] ?? autoToolName(t);
    nick.onchange = () => {
      t.nick = nick.value.trim() || undefined;
      renderLoadout();
      if (genResult) renderSummary();
      syncPresetSelects();
      persist();
    };
    const named = document.createElement("label");
    named.className = "tool-name";
    named.title = "optional: your own name for this tool, so the teardown checklist "
      + "says which one you mean";
    named.append("nickname ", nick);
    head.append(named);
    const rm = document.createElement("button");
    rm.textContent = "×"; rm.className = "mini tool-remove";
    rm.title = `remove this ${t.kind}`;
    rm.setAttribute("aria-label", `remove this ${t.kind}`);
    rm.onclick = () => { loadout.splice(i, 1); renderLoadout(); refreshSolver(); };
    head.append(rm);
    item.append(head);

    const never = Boolean(t.unbreakable);
    const ench = document.createElement("div");
    ench.className = "tool-ench";

    const speed = document.createElement("div");
    speed.className = "ench-row";
    speed.append(enchantLevel("tool-eff", "Efficiency",
      "Efficiency enchantment level: how fast you break blocks (Blossom items go past V)",
      t.efficiency, false, (el) => {
        t.efficiency = Number(el.value) || 0;
        refreshSolver();
      }, 5));
    if (meta.silk_touch) {
      speed.append(enchantBox("tool-silk", "Silk Touch",
        "Silk Touch makes a block drop itself: stone stays stone, glass survives",
        t.silk, false, (v) => { t.silk = v; refreshSolver(); }));
    }
    ench.append(speed);

    const wear = document.createElement("div");
    wear.className = "ench-row";
    wear.append(enchantLevel("tool-unbreaking", "Unbreaking",
      "Unbreaking level: durability only. It does not make you mine faster. "
      + "Each block has a 1-in-(level+1) chance of costing durability",
      t.unbreaking ?? 0, never, (el) => {
        t.unbreaking = Number(el.value) || 0;
        if (genResult) renderSummary();
        syncPresetSelects();
        persist();
      }, 3));
    wear.append(enchantBox("tool-mending", "Mending",
      "Mending repairs the tool from XP you pick up (2 durability per point), "
      + "so one tool lasts the whole teardown if you keep XP handy",
      Boolean(t.mending), never, (v) => {
        t.mending = v;
        if (genResult) renderSummary();
        syncPresetSelects();
        persist();
      }));
    wear.append(enchantBox("tool-unbreakable", "Unbreakable",
      "not an enchantment: some servers hand out tools that never wear out at all",
      never, false, (v) => {
        t.unbreakable = v;
        renderLoadout();
        if (genResult) renderSummary();
        syncPresetSelects();
        persist();
      }));
    ench.append(wear);
    if (!meta.silk_touch && t.silk) t.silk = false;
    item.append(ench);
    list.append(item);
  });
}

const LOADOUT_FILTER_KEYS = ["unrecoverable", "class_match_only"];
const BLOCK_FILTER_KEYS = TOGGLE_DEFS
  .map(([k]) => k)
  .filter((k) => !LOADOUT_FILTER_KEYS.includes(k));

const LOADOUT_FILTER_HINTS: Record<string, string> = {
  unrecoverable:
    "On: unrecoverable blocks stay offered and are priced as spent. Off: hide them.",
  class_match_only:
    "Off: every block stays offered. On: a pickaxe-only palette really is pickaxe-only.",
};

const LOADOUT_FILTER_LABELS: Record<string, string> = {
  unrecoverable: "Show blocks I can't recover",
  class_match_only: "Show only blocks my tools are made for",
};

function helpLines(text: string): string[] {
  return text.split(/\s+(?=(?:On|Off)[:,])/).map((s) => s.trim()).filter(Boolean);
}

function toggleRow(key: string, shortHint?: string, plainLabel?: string): HTMLElement {
  const { word, gloss, long: help } = term(key);
  const row = document.createElement("div");
  row.className = "toggle-row";
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.id = `toggle-${key}`;
  cb.checked = toggles[key];
  cb.onchange = () => { toggles[key] = cb.checked; syncFilterChip(); refreshSolver(); };
  label.append(cb, ` ${plainLabel ?? `${word}: ${gloss}`}`);
  label.title = helpLines(help).join("\n");
  row.append(label);
  for (const line of helpLines(shortHint ?? help)) {
    const hint = document.createElement("p");
    hint.className = "toggle-help";
    hint.textContent = line;
    row.append(hint);
  }
  return row;
}

function renderLoadoutFilters() {
  const div = $("loadout-filters");
  div.innerHTML = "";
  for (const key of LOADOUT_FILTER_KEYS) {
    div.append(toggleRow(key, LOADOUT_FILTER_HINTS[key], LOADOUT_FILTER_LABELS[key]));
  }
}

function renderToggles() {
  const div = $("toggles");
  div.innerHTML = "";
  renderLoadoutFilters();
  for (const key of BLOCK_FILTER_KEYS) {
    div.append(toggleRow(key));
  }
  syncFilterChip();
}

function syncFilterChip() {
  const chip = document.getElementById("filter-state");
  if (!chip) return;
  const off = BLOCK_FILTER_KEYS.filter((k) => !toggles[k]).length;
  chip.textContent = off ? `${off} of ${BLOCK_FILTER_KEYS.length} off` : "all on";
  chip.classList.toggle("some-off", off > 0);
}

function setToggle(key: string, value: boolean) {
  toggles[key] = value;
  const cb = document.getElementById(`toggle-${key}`) as HTMLInputElement | null;
  if (cb) cb.checked = value;
  syncFilterChip();
}

const FLAG_KEYS: (keyof RankedDto)[] = [
  "silk_gated", "gravity", "support_mandatory", "unstable", "constrained",
  "flammable",
];
const FLAG_DEFS: [keyof RankedDto, string, string][] = FLAG_KEYS.map(
  (k) => [k, term(k).word, term(k).short],
);

const BREAK_PAUSE_TICKS = 5;
const FLY_SWEEP_TICKS = 2;
const WALK_SWEEP_TICKS = 4;

function harvestTicks(recoveryTicks: number): number {
  if (recoveryTicks === 0) {
    return checked("flying") ? FLY_SWEEP_TICKS : WALK_SWEEP_TICKS;
  }
  return recoveryTicks + (checked("no-cooldown") ? 0 : BREAK_PAUSE_TICKS);
}

function costText(r: RankedDto): string {
  if (r.recovery_ticks === null) return "can't recover";
  if (r.instamine) return "instant";
  const s = r.recovery_ticks / 20;
  return s < 1 ? `${s.toFixed(2)}s` : `${s.toFixed(1)}s`;
}

function costTitle(r: RankedDto): string {
  if (r.recovery_ticks === null) {
    return "no way to get this block back with your current tools";
  }
  const tool = r.recovery_tool === null || r.recovery_tool < 0
    ? "bare hands"
    : (() => {
      const t = loadout[r.recovery_tool];
      return t ? toolDetail(t) : "tool";
    })();
  const how = r.instamine
    ? "breaks instantly (one tick)"
    : `${r.recovery_ticks} ticks (${(r.recovery_ticks / 20).toFixed(2)}s)`;
  return `${how} with ${tool}`;
}

function ticksLabel(r: RankedDto): string {
  return costText(r);
}

function tileTitle(r: RankedDto): string {
  const b = blocks[r.block_index];
  const props = Object.entries(b?.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
  const flags = FLAG_DEFS.filter(([k]) => r[k]).map(([, label]) => label).join(", ");
  return `${r.display_name}${props ? ` [${props}]` : ""}\nteardown: ${ticksLabel(r)}${flags ? `\n${flags}` : ""}`;
}

function usable(cid: number): boolean {
  return enabled.has(cid) && colorExists(cid) && (rankedByColor.get(cid)?.length ?? 0) > 0;
}

function usableIds(): number[] {
  return [...enabled].filter(usable).sort((a, b) => a - b);
}

function chosen(cid: number): RankedDto | undefined {
  const ranked = rankedByColor.get(cid);
  if (!ranked?.length) return undefined;
  const idx = selectionOverride.get(cid);
  return ranked.find((r) => r.block_index === idx) ?? ranked[0];
}

function swatchGradient(c: MapColor): string {
  if (($("height-mode") as HTMLSelectElement).value === "flat") {
    return `rgb(${c.tones.normal.join(",")})`;
  }
  const [d, n, l] = [c.tones.dark, c.tones.normal, c.tones.light].map((t) => `rgb(${t.join(",")})`);
  return `linear-gradient(to bottom, ${d} 0 33%, ${n} 33% 66%, ${l} 66% 100%)`;
}

function tilePos(blockIndex: number): string {
  const col = blockIndex % atlasCols;
  const row = Math.floor(blockIndex / atlasCols);
  return `calc(var(--tile-size, 32px) * -${col}) calc(var(--tile-size, 32px) * -${row})`;
}

function tileEl(blockIndex: number, cls = "tile"): HTMLElement {
  const t = document.createElement("span");
  t.className = cls;
  t.style.backgroundPosition = tilePos(blockIndex);
  return t;
}

const INFO_FLAGS = new Set(["26.2", "flammable"]);

function flagsInline(r: RankedDto): string {
  return FLAG_DEFS.filter(([k]) => r[k])
    .map(([, label, title]) =>
      `<span class="flag${INFO_FLAGS.has(label) ? " info" : ""}" title="${title}">${label}</span>`)
    .join("");
}

function sortedColors(): MapColor[] {
  const mode = ($("palette-sort") as HTMLSelectElement | null)?.value ?? "map";
  const arr = [...colors];
  const cost = (c: MapColor) => chosen(c.id)?.recovery_ticks ?? Number.MAX_SAFE_INTEGER;
  const count = (c: MapColor) => genResult?.materials[String(c.id)] ?? 0;
  const delta = (c: MapColor) => marginalDeltas?.get(c.id) ?? -1;
  const hue = (c: MapColor) => {
    const [r, g, b] = c.rgb.map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.02) return -1;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  switch (mode) {
    case "name": return arr.sort((a, b) => a.name.localeCompare(b.name));
    case "spectrum": return arr.sort((a, b) =>
      hue(a) - hue(b) || (a.rgb[0] + a.rgb[1] + a.rgb[2]) - (b.rgb[0] + b.rgb[1] + b.rgb[2]));
    case "cost": return arr.sort((a, b) => cost(a) - cost(b) || a.id - b.id);
    case "count": return arr.sort((a, b) => count(b) - count(a) || a.id - b.id);
    case "impact": return arr.sort((a, b) => delta(b) - delta(a) || a.id - b.id);
    default: return arr;
  }
}

function driftChip(cid: number): HTMLElement | null {
  const d = driftByColor.get(cid);
  if (!d) return null;
  const { each, total } = driftSaving(d);
  const chip = document.createElement("span");
  chip.className = "chip-drift";
  chip.textContent = d.delta === Infinity ? "not recoverable" : `+${each}`;
  chip.title = `your pick: ${d.cur.display_name} (${costText(d.cur)})\n`
    + `cheapest now: ${d.top.display_name} (${costText(d.top)})`
    + (total ? `\n${total} extra over this picture` : "")
    + "\nclick to switch to the cheapest";
  chip.onclick = (e) => {
    e.stopPropagation();
    selectionOverride.delete(cid);
    deliberate.delete(cid);
    renderPalette();
    if (genResult) renderSummary();
  };
  return chip;
}

function countText(n: number): string {
  return n.toLocaleString("en-US");
}

function countTitle(n: number): string {
  const parts = [`${countText(n)} blocks`];
  parts.push(`${Math.floor(n / STACK)} stacks + ${n % STACK}`);
  if (n >= SHULKER) parts.push(`${(n / SHULKER).toFixed(2)} shulkers`);
  if (n >= DC) parts.push(`${(n / DC).toFixed(2)} double chests`);
  return parts.join(" · ");
}

function deltaText(cid: number): string {
  const d = marginalDeltas?.get(cid);
  if (d === undefined || !marginalTotal || !enabled.has(cid)) return "";
  if (d === Infinity) return "∞";
  const pct = (d / marginalTotal) * 100;
  return pct < 0.005 ? "none" : `+${pct.toFixed(2)}%`;
}

function noneTile(c: MapColor, small: boolean): HTMLElement {
  const cls = small ? "tile small" : "tile";
  const none = document.createElement("button");
  none.className = `${cls} none-tile` + (enabled.has(c.id) ? "" : " selected");
  none.textContent = "×";
  none.title = `drop ${c.name} from the palette`;
  none.setAttribute("aria-label", `use no block for ${c.name}`);
  none.setAttribute("aria-pressed", String(!enabled.has(c.id)));
  none.onclick = (e) => {
    e.stopPropagation();
    enabled.delete(c.id);
    renderPalette();
    scheduleGenerate();
  };
  return none;
}

function candidateStrip(
  c: MapColor,
  cur: RankedDto | undefined,
  small: boolean,
  withNone = true,
): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "tile-strip";
  const cls = small ? "tile small" : "tile";
  const none = document.createElement("button");
  none.className = `${cls} none-tile` + (enabled.has(c.id) ? "" : " selected");
  none.textContent = "×";
  none.title = `drop ${c.name} from the palette`;
  none.setAttribute("aria-label", `use no block for ${c.name}`);
  none.setAttribute("aria-pressed", String(!enabled.has(c.id)));
  none.onclick = (e) => {
    e.stopPropagation();
    enabled.delete(c.id);
    renderPalette();
    scheduleGenerate();
  };
  if (withNone) strip.append(none);
  for (const r of rankedByColor.get(c.id) ?? []) {
    const t = document.createElement("button");
    t.className = cls + (cur && cur.block_index === r.block_index ? " selected" : "") +
      (r.recovery_ticks === null ? " norecovery" : "");
    t.style.backgroundPosition = tilePos(r.block_index);
    t.title = tileTitle(r);
    t.setAttribute("aria-label", tileTitle(r).replace(/\n/g, ", "));
    t.setAttribute("aria-pressed", String(Boolean(cur && cur.block_index === r.block_index)));
    t.onclick = (e) => {
      e.stopPropagation();
      const wasOff = !enabled.has(c.id);
      enabled.add(c.id);
      selectionOverride.set(c.id, r.block_index);
      const top = rankedByColor.get(c.id)?.[0];
      if (top && r.block_index !== top.block_index) deliberate.add(c.id);
      else deliberate.delete(c.id);
      renderPalette();
      if (wasOff) scheduleGenerate();
      else renderSummary();
    };
    strip.append(t);
  }
  return strip;
}

function swatchEl(c: MapColor, small = false): HTMLElement {
  const sw = document.createElement("span");
  sw.className = "swatchbox" + (small ? " small" : "");
  sw.style.background = swatchGradient(c);
  sw.title = `${c.name}: map color ${c.id}, vanilla ${c.constant}\nswatch shows the staircase tones`;
  return sw;
}

function renderFillerNotice() {
  const el = $("filler-notice");
  const none = ($("support-mode") as HTMLSelectElement).value === "none";
  const needy = [...enabled].filter((cid) => chosen(cid)?.support_mandatory);
  if (!none || !needy.length) { el.hidden = true; el.replaceChildren(); return; }

  const blocks = genResult
    ? needy.reduce((n, cid) => n + (genResult!.materials[String(cid)] ?? 0), 0)
    : 0;
  const stepped = ($("height-mode") as HTMLSelectElement).value === "stepped";
  const subject = blocks
    ? `${countText(blocks)} blocks`
    : `${needy.length} of your colors`;
  if (el.hidden) ($("filler-section") as HTMLDetailsElement).open = true;
  el.hidden = false;
  el.className = stepped ? "note warn-orange" : "note";
  el.replaceChildren(stepped
    ? `${subject} need something underneath and a staircase leaves air there, so they pop off. `
    : `${subject} need something underneath and rest directly on your canvas. `);

  if (!stepped) return;
  const addFiller = document.createElement("button");
  addFiller.className = "mini";
  addFiller.textContent = "add filler where needed";
  addFiller.onclick = () => {
    ($("support-mode") as HTMLSelectElement).value = "important";
    renderFillerNotice();
    syncFillerUi();
    persist();
    if (genResult) renderSummary();
  };
  const drop = document.createElement("button");
  drop.className = "mini";
  drop.textContent = "or keep those blocks out";
  drop.onclick = () => {
    setToggle("support_mandatory", false);
    void refreshSolver();
  };
  el.append(addFiller, " ", drop);
}

function applyTileSize() {
  const px = ($("tile-size") as HTMLSelectElement | null)?.value || "32";
  document.documentElement.style.setProperty("--tile-size", `${px}px`);
}

function renderPalette() {
  const view = ($("palette-view") as HTMLSelectElement).value;
  const div = $("palette");
  syncVersionNote();
  currentDrift = pickDrift();
  driftByColor = new Map(currentDrift.stale.map((d) => [d.cid, d]));
  div.innerHTML = "";
  div.className = view === "list" ? "view-list" : "view-tiles";
  if (view === "list") renderPaletteTable(div);
  else renderPaletteTiles(div);
  const off = colors.length - enabled.size;
  $("color-meta").textContent = off === 0
    ? `all ${colors.length} colors in play`
    : `${enabled.size} of ${colors.length} colors, ${off} turned off`;
  renderPickDrift();
  renderFillerNotice();
  syncPresetSelects();
  persist();
}

interface Column {
  key: string;
  label: string;
  help: string;
  width: string;
  num?: boolean;
  sortable?: boolean;
  imageOnly?: boolean;
}

const COLUMNS: Column[] = [
  { key: "color", label: "Color", width: "15rem", sortable: true,
    help: "the map color. A picture can only use these 61" },
  { key: "block", label: "Block", width: "17rem",
    help: "what gets placed for this color; click the row to change it" },
  { key: "cost", label: "Teardown", width: "9.5rem", sortable: true,
    help: "time to break one and get it back, with your tools" },
  { key: "count", label: "Blocks", width: "6rem", num: true, sortable: true, imageOnly: true,
    help: "how many this image needs" },
  { key: "impact", label: "Δ error", width: "6rem", num: true, sortable: true, imageOnly: true,
    help: "how much worse the picture gets if you drop this color" },
  { key: "flags", label: "Notes", width: "auto",
    help: "friction worth knowing before you build" },
];

function activeColumns(): Column[] {
  return COLUMNS.filter((c) => !c.imageOnly || genResult);
}

function cell(...kids: (Node | string)[]): HTMLElement {
  const d = document.createElement("div");
  d.className = "cell";
  d.append(...kids);
  return d;
}

function renderPaletteTable(root: HTMLElement) {
  const cols = activeColumns();
  const sortMode = ($("palette-sort") as HTMLSelectElement).value;
  const table = document.createElement("table");
  table.className = "palette-table";

  const colgroup = document.createElement("colgroup");
  for (const c of cols) {
    const col = document.createElement("col");
    if (c.width !== "auto") col.style.width = c.width;
    colgroup.append(col);
  }
  table.append(colgroup);

  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c.label;
    th.title = c.help;
    if (c.num) th.classList.add("num");
    if (c.sortable) {
      th.classList.add("sortable");
      const key = c.key === "color" ? "name" : c.key;
      if (sortMode === key) th.classList.add("sorted");
      th.onclick = () => {
        ($("palette-sort") as HTMLSelectElement).value = key;
        renderPalette();
      };
    }
    hrow.append(th);
  }
  thead.append(hrow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  let parity = 0;
  for (const c of sortedColors()) {
    const isOn = enabled.has(c.id);
    const cur = isOn ? chosen(c.id) : undefined;
    const tr = document.createElement("tr");
    tr.className = `prow ${parity++ % 2 ? "alt" : ""}${isOn ? "" : " off"}`
      + (driftByColor.has(c.id) ? " drifted" : "")
      + (isOn && !usable(c.id) ? " unusable" : "");

    for (const col of cols) {
      const td = document.createElement("td");
      if (col.num) td.classList.add("num");
      switch (col.key) {
        case "color": {
          const nm = document.createElement("span");
          nm.className = "cname";
          nm.textContent = c.name;
          nm.title = `map color ${c.id}, vanilla ${c.constant}`;
          td.append(cell(swatchEl(c, true), nm));
          break;
        }
        case "block": {
          const ranked = rankedByColor.get(c.id) ?? [];
          const sel = document.createElement("select");
          sel.className = "blocksel";
          sel.add(new Option("(not used)", ""));
          const cheapest = ranked[0];
          for (const r of [...ranked].sort((a, b) => a.display_name.localeCompare(b.display_name))) {
            const mark = cheapest && r.block_index === cheapest.block_index ? " · cheapest" : "";
            sel.add(new Option(`${r.display_name} · ${costText(r)}${mark}`, String(r.block_index)));
          }
          sel.value = cur ? String(cur.block_index) : "";
          sel.title = cur ? costTitle(cur) : "this color is not in your palette";
          sel.onchange = () => {
            if (!sel.value) {
              enabled.delete(c.id);
              renderPalette();
              scheduleGenerate();
              return;
            }
            const idx = Number(sel.value);
            const wasOff = !enabled.has(c.id);
            enabled.add(c.id);
            selectionOverride.set(c.id, idx);
            const top = rankedByColor.get(c.id)?.[0];
            if (top && idx !== top.block_index) deliberate.add(c.id);
            else deliberate.delete(c.id);
            renderPalette();
            if (wasOff) scheduleGenerate();
            else renderSummary();
          };
          td.append(cell(
            cur ? tileEl(cur.block_index, "tile small") : document.createElement("span"),
            sel,
          ));
          break;
        }
        case "cost": {
          if (!cur) { td.textContent = "none"; break; }
          const drift = driftChip(c.id);
          const time = document.createElement("span");
          time.className = "timecell";
          time.textContent = costText(cur);
          td.append(cell(time, ...(drift ? [drift] : [])));
          td.title = costTitle(cur);
          break;
        }
        case "count": {
          const n = genResult && isOn ? (genResult.materials[String(c.id)] ?? 0) : 0;
          td.textContent = n ? countText(n) : "0";
          if (n) td.title = countTitle(n);
          break;
        }
        case "impact":
          td.textContent = deltaText(c.id) || "none";
          td.title = "extra color error if this color is removed";
          break;
        case "flags":
          td.innerHTML = cur ? (flagsInline(cur) || '<span class="dim">none</span>')
            : '<span class="dim">none</span>';
          break;
      }
      tr.append(td);
    }

    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);
}

function renderPaletteTiles(root: HTMLElement) {
  for (const c of sortedColors()) {
    const isOn = enabled.has(c.id);
    const cur = isOn ? chosen(c.id) : undefined;
    const dead = isOn && !usable(c.id);
    const row = document.createElement("div");
    row.className = "palette-row" + (isOn ? "" : " off") + (dead ? " unusable" : "");
    if (dead) row.title = `${c.name} has no block your filters allow, so it places no blocks`;

    row.append(swatchEl(c));
    const label = document.createElement("span");
    label.className = "row-name";
    label.textContent = c.name;
    label.title = `map color ${c.id}, vanilla ${c.constant}`;
    row.append(label);
    row.append(noneTile(c, false));
    row.append(candidateStrip(c, cur, false, false));

    const badges = document.createElement("span");
    badges.className = "row-badges";
    const n = genResult && isOn ? (genResult.materials[String(c.id)] ?? 0) : 0;
    if (n) {
      const cnt = document.createElement("span");
      cnt.className = "dim num";
      cnt.textContent = countText(n);
      cnt.title = countTitle(n);
      badges.append(cnt);
    }
    const drift = driftChip(c.id);
    if (drift) badges.append(drift);
    const dt = deltaText(c.id);
    if (dt) {
      const d = document.createElement("span");
      d.className = "delta";
      d.textContent = dt;
      d.title = "extra color error if this color is removed";
      badges.append(d);
    }
    row.append(badges);
    root.append(row);
  }
}

function renderLoadoutMeta(s: AuditDto["summary"]) {
  const el = document.getElementById("loadout-meta");
  if (!el) return;
  const tools = `${loadout.length} tool${loadout.length === 1 ? "" : "s"}`;
  const parts = [tools, `${s.instamine_colors} of ${colors.length} instant`];
  if (s.no_recovery_colors) parts.push(`${s.no_recovery_colors} unrecoverable`);
  el.textContent = parts.join(" · ");
  el.title = "colors that break instantly, and colors whose cheapest block your tools "
    + "cannot recover";
  const empty = document.getElementById("loadout-empty");
  if (!empty) return;
  empty.textContent = s.empty_colors
    ? `${s.empty_colors} color${s.empty_colors === 1 ? "" : "s"} left with nothing`
    : "";
  empty.hidden = !s.empty_colors;
}

async function refreshSolver() {
  if (!colors.length) return;
  const audit = await rpc<AuditDto>(
    { cmd: "audit", loadout: { tools: toolsForWasm() }, config: solverConfig() });
  rankedByColor = new Map(audit.colors.map((c) => [c.color_id, c.ranked]));
  renderLoadoutMeta(audit.summary);
  renderPalette();
  if (genResult) renderSummary();
  else renderAuditSummary(audit);
}

function fmtBulk(n: number): string {
  if (n >= DC) return `${countText(n)} blocks · ${(n / DC).toFixed(1)} double chests`;
  if (n >= SHULKER) return `${countText(n)} blocks · ${(n / SHULKER).toFixed(1)} shulkers`;
  if (n >= STACK) return `${countText(n)} blocks · ${(n / STACK).toFixed(1)} stacks`;
  return `${countText(n)} blocks`;
}

function fmtDuration(ticks: number): string {
  const s = ticks / 20;
  if (s < 60) return `${s.toFixed(0)} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function unbuildableColors(): MapColor[] {
  if (!genResult) return [];
  return Object.keys(genResult.materials)
    .map(Number)
    .filter((cid) => !chosen(cid))
    .map((cid) => colors.find((c) => c.id === cid))
    .filter((c): c is MapColor => Boolean(c));
}

function materialsBasis(): { counts: Record<string, number>; scope: string | null } {
  const whole = { counts: genResult?.materials ?? {}, scope: null };
  const sel = $("materials-basis") as HTMLSelectElement | null;
  if (!genResult || !tileMaterials || !sel || sel.value === "build") return whole;
  const i = Number(sel.value);
  const tile = tileMaterials[i];
  if (!Number.isInteger(i) || !tile) return whole;
  return {
    counts: tile,
    scope: `panel ${i + 1} of ${tileMaterials.length}, ${panelTag(i)}`,
  };
}

function refreshSupportTotals() {
  const opts = genResult ? exportOpts(true) : null;
  if (!opts) {
    supportTotals = null;
    supportTotalsSig = null;
    return;
  }
  const sig = `${generateSeq}:${JSON.stringify(opts)}`;
  if (sig === supportTotalsSig || supportTotalsBusy) return;
  supportTotalsBusy = true;
  rpc<SupportTotals>({ cmd: "support_totals", opts })
    .then((t) => {
      supportTotals = t;
      supportTotalsSig = sig;
      supportTotalsBusy = false;
      renderSummary();
    })
    .catch(() => {
      supportTotals = null;
      supportTotalsSig = null;
      supportTotalsBusy = false;
    });
}

function fillerLabel(blockId: string): string {
  const b = blocks.find((x) => x.block_id === blockId);
  return `${b?.display_name ?? blockId} (filler)`;
}

const FILLER_MODE_SHORT: Record<string, string> = {
  none: "none",
  important: "where needed",
  all_optimized: "survival placement",
  all_double_optimized: "full layer",
};

function fillerId(): string {
  return ($("support-block") as HTMLInputElement).value.trim() || "netherrack";
}

function fillerEntry(id: string): { b: CandidateBlock; index: number } | null {
  const index = blocks.findIndex((x) => x.block_id === id);
  return index >= 0 ? { b: blocks[index], index } : null;
}

function fillerLegal(b: CandidateBlock): boolean {
  if (b.gravity || b.support_mandatory || b.fluid || b.constrained) return false;
  const v = versionIndex(b.since);
  return v === -1 || v <= versionIndex(gameVersion());
}

function paletteFillerEntries(): { b: CandidateBlock; index: number }[] {
  const out = new Map<string, { b: CandidateBlock; index: number }>();
  for (const cid of enabled) {
    const r = chosen(cid);
    const b = r ? blocks[r.block_index] : undefined;
    if (b && r && fillerLegal(b) && !out.has(b.block_id)) {
      out.set(b.block_id, { b, index: r.block_index });
    }
  }
  return [...out.values()]
    .sort((a, z) => a.b.display_name.localeCompare(z.b.display_name));
}

let fillerHot = -1;

function fillerRows(): HTMLElement[] {
  return [...$("filler-drop").querySelectorAll<HTMLElement>(".picker-row")];
}

function renderFillerDrop() {
  const drop = $("filler-drop");
  const cur = fillerEntry(fillerId());
  let q = ($("filler-search") as HTMLInputElement).value.trim().toLowerCase();
  if (cur && q === cur.b.display_name.toLowerCase()) q = "";
  const match = (b: CandidateBlock) =>
    !q || b.display_name.toLowerCase().includes(q) || b.block_id.includes(q);
  const pal = paletteFillerEntries().filter((e) => match(e.b));
  const palIds = new Set(pal.map((e) => e.b.block_id));
  const seen = new Set<string>();
  const rest: { b: CandidateBlock; index: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (palIds.has(b.block_id) || seen.has(b.block_id)) continue;
    if (!fillerLegal(b) || !match(b)) continue;
    seen.add(b.block_id);
    rest.push({ b, index: i });
  }
  rest.sort((a, z) => a.b.display_name.localeCompare(z.b.display_name));
  drop.innerHTML = "";
  let optIdx = 0;
  const group = (label: string, list: { b: CandidateBlock; index: number }[]) => {
    if (!list.length) return;
    const g = document.createElement("div");
    g.className = "picker-group";
    g.textContent = label;
    drop.append(g);
    for (const e of list) {
      const row = document.createElement("div");
      row.className = "picker-row";
      row.dataset.id = e.b.block_id;
      row.setAttribute("role", "option");
      row.id = `filler-opt-${optIdx}`;
      optIdx += 1;
      row.append(tileEl(e.index), document.createTextNode(e.b.display_name));
      row.onmousedown = (ev) => { ev.preventDefault(); commitFiller(e.b.block_id); };
      drop.append(row);
    }
  };
  group("in your palette", pal);
  group("all blocks", rest);
  if (!drop.childElementCount) {
    const none = document.createElement("div");
    none.className = "picker-empty";
    none.textContent = `nothing matches "${q}" in ${gameVersion()}`;
    drop.append(none);
  }
  fillerHot = -1;
  const input = $("filler-search") as HTMLInputElement;
  input.setAttribute("aria-expanded", "true");
  input.removeAttribute("aria-activedescendant");
  drop.hidden = false;
}

function closeFillerDrop() {
  ($("filler-drop") as HTMLElement).hidden = true;
  const input = $("filler-search") as HTMLInputElement;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  fillerHot = -1;
}

function commitFiller(id: string) {
  ($("support-block") as HTMLInputElement).value = id;
  closeFillerDrop();
  syncFillerUi();
  persist();
  if (genResult) renderSummary();
}

function syncFillerUi() {
  const id = fillerId();
  const e = fillerEntry(id);
  const input = $("filler-search") as HTMLInputElement;
  if (document.activeElement !== input) input.value = e ? e.b.display_name : id;
  const tile = $("filler-tile") as HTMLElement;
  tile.style.backgroundPosition = e ? tilePos(e.index) : "-9999px -9999px";
  const mode = ($("support-mode") as HTMLSelectElement).value;
  const late = e && versionIndex(e.b.since) > versionIndex(gameVersion())
    ? ` (needs ${e.b.since})` : "";
  $("filler-meta").textContent =
    `${FILLER_MODE_SHORT[mode] ?? mode} · ${e ? e.b.display_name : id}${late}`;
}

interface ChangelogBuild { id: string; date: string; line: string; notes: string[] }

interface Partner {
  id: string; name: string; url: string; logo: string;
  line: string; sub: string | null; caption: string | null;
}

async function initCommunities() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}partners.json`);
    if (!res.ok) return;
    const data = (await res.json()) as { partners: Partner[] };
    if (!data.partners?.length) return;
    const cards = $("communities-cards");
    cards.replaceChildren(...data.partners.map((c) => {
      const a = document.createElement("a");
      a.className = "community-card";
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const img = document.createElement("img");
      img.className = "community-logo";
      img.src = `${import.meta.env.BASE_URL}${c.logo}`;
      img.alt = c.name;
      const text = document.createElement("div");
      text.className = "community-text";
      const line = document.createElement("p");
      line.className = "community-line";
      line.textContent = c.line;
      text.append(line);
      if (c.caption) {
        const cap = document.createElement("p");
        cap.className = "community-caption";
        cap.textContent = c.caption;
        text.append(cap);
      }
      if (c.sub) {
        const sub = document.createElement("p");
        sub.className = "community-sub";
        sub.textContent = c.sub;
        text.append(sub);
      }
      a.append(img, text);
      return a;
    }));
    $("communities").hidden = false;
  } catch { void 0; }
}

async function initWhatsNew() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}changelog.json`);
    if (!res.ok) return;
    const log = (await res.json()) as { builds: ChangelogBuild[] };
    if (!log.builds?.length) return;
    const panel = $("whatsnew-panel");
    const renderPanel = () => {
      panel.replaceChildren(...log.builds.slice(0, 3).map((b) => {
        const d = document.createElement("div");
        const h = document.createElement("p");
        h.className = "whatsnew-head";
        h.textContent = `${b.date}: ${b.line}`;
        const ul = document.createElement("ul");
        for (const n of Array.isArray(b.notes) ? b.notes : []) {
          const li = document.createElement("li");
          li.textContent = n;
          ul.append(li);
        }
        d.append(h, ul);
        return d;
      }));
      const tip = document.createElement("p");
      tip.className = "whatsnew-tip";
      tip.textContent = "Arachne acting strangely after an update? A hard refresh"
        + " clears the old version: Ctrl+Shift+R, or Cmd+Shift+R on a Mac.";
      panel.append(tip);
    };
    const link = $("whatsnew-link") as HTMLButtonElement;
    link.onclick = () => {
      if (panel.hidden) renderPanel();
      panel.hidden = !panel.hidden;
      link.setAttribute("aria-expanded", String(!panel.hidden));
    };
  } catch { void 0; }
}

function syncMaterialsScope() {
  const sel = $("materials-basis") as HTMLSelectElement;
  const n = tileMaterials?.length ?? 0;
  $("materials-basis-label").hidden = n < 2;
  const sig = `${n}:${firstMapId()}`;
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  const keep = sel.value;
  sel.innerHTML = "";
  sel.add(new Option("the whole schematic", "build"));
  for (let i = 0; i < n; i++) {
    sel.add(new Option(`panel ${i + 1}: ${panelTag(i)}`, String(i)));
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "build";
}

function wearText(t: OwnedTool, breaks: number): string {
  if (t.unbreakable) return " (unbreakable, one is enough)";
  if (!breaks) return "";
  if (t.mending) return " (Mending, bring one and repair as you go)";
  const tiered = toolMeta[t.kind]?.tiered ?? true;
  const durability = tiered ? (tierMeta[t.tier]?.durability ?? 0) : 0;
  if (!durability) return " (wear unknown)";
  const uses = durability * ((t.unbreaking ?? 0) + 1);
  const worn = breaks / uses;
  const need = Math.max(1, Math.ceil(worn));
  return `, bring ${need}, ${worn < 0.05 ? "barely dented" : `${worn.toFixed(1)} worn through`}`;
}

function renderSummary() {
  const div = $("summary");
  if (!genResult) return;
  const unbuildable = unbuildableColors();
  let teardown = 0, instamined = 0, silkBurden = 0, placed = 0, unrecoverable = 0;
  const toolsUsed = new Set<number>();
  const wear = new Map<number, number>();
  const toolTicks = new Map<number, number>();
  const lines: { name: string; color: string; shown: number; r: RankedDto | null;
    totalTicks: number | null; title?: string }[] = [];
  syncMaterialsScope();
  refreshSupportTotals();
  const { counts, scope } = materialsBasis();
  for (const [cidStr, whole] of Object.entries(genResult.materials)) {
    const cid = Number(cidStr);
    const r = chosen(cid);
    if (!r) continue;
    const count = scope ? (counts[cidStr] ?? 0) : whole;
    const shown = count;
    if (!count) continue;
    placed += count;
    let totalTicks: number | null = null;
    if (r.recovery_ticks === null) unrecoverable += count;
    else {
      totalTicks = harvestTicks(r.recovery_ticks) * count;
      teardown += totalTicks;
      const fastest = r.recovery_ticks - (r.silk_penalty ?? 0);
      silkBurden += (harvestTicks(r.recovery_ticks) - harvestTicks(fastest)) * count;
      const bucket = r.recovery_tool !== null && r.recovery_tool >= 0 ? r.recovery_tool : -1;
      toolTicks.set(bucket, (toolTicks.get(bucket) ?? 0) + totalTicks);
      if (r.instamine) instamined += count;
      if (r.recovery_tool !== null && r.recovery_tool >= 0) {
        toolsUsed.add(r.recovery_tool);
        if ((blocks[r.block_index]?.hardness ?? 0) > 0) {
          wear.set(r.recovery_tool, (wear.get(r.recovery_tool) ?? 0) + count);
        }
      }
    }
    const b = blocks[r.block_index];
    const c = colors.find((x) => x.id === cid);
    lines.push({ name: b?.display_name ?? String(cid), color: c?.name ?? "",
      shown, r, totalTicks });
  }
  if (supportTotals) {
    const basisSel = $("materials-basis") as HTMLSelectElement | null;
    const fillerCount = scope && basisSel && basisSel.value !== "build"
      ? (supportTotals.panels[Number(basisSel.value)] ?? 0)
      : supportTotals.whole;
    if (fillerCount) {
      const id = ($("support-block") as HTMLInputElement).value.trim() || "netherrack";
      const perPanel = scope && basisSel && basisSel.value !== "build";
      const title = perPanel && !checked("borrow-edge")
        ? "includes the reference row this panel stands on when built alone"
        : undefined;
      lines.push({ name: fillerLabel(id), color: "", shown: fillerCount,
        r: null, totalTicks: null, title });
    }
  }
  lines.sort((a, b) =>
    (b.totalTicks ?? -1) - (a.totalTicks ?? -1) || b.shown - a.shown
    || a.name.localeCompare(b.name));
  const rows = lines.map((l) =>
    `<tr><td${l.title ? ` title="${l.title}"` : ""}>${l.name}</td>` +
    `<td class="dim">${l.color}</td>` +
    `<td class="num" title="${countTitle(l.shown)}">${countText(l.shown)}</td>` +
    `<td class="num">${(l.shown / SHULKER).toFixed(2)}</td>` +
    `<td class="num">${l.r ? costText(l.r) : ""}</td>` +
    `<td class="num">${l.totalTicks === null ? "" : ticksText(l.totalTicks)}</td></tr>`);
  const checklist = [...toolsUsed].sort((a, b) => a - b)
    .map((i) => {
      const t = loadout[i];
      return t ? esc(`${toolDetail(t)}${wearText(t, wear.get(i) ?? 0)}`) : `tool ${i}`;
    })
    .join(" · ") || "bare hands";
  const maps = scope
    ? `1 map of ${(genResult.width / 128) * (genResult.height / 128)}`
    : `${genResult.width / 128} × ${genResult.height / 128} maps`;
  const warning = unbuildable.length
    ? `<p class="warn-banner">${unbuildable.length} color${unbuildable.length > 1 ? "s" : ""}
       in this picture (${unbuildable.map((c) => c.name).join(", ")}) have no usable block
       under your current filters, so ${unbuildable.length > 1 ? "they are" : "it is"} left
       out of the totals and blocks export. Re-enable a filter, or drop the color from the
       palette to change the picture.</p>`
    : "";
  div.innerHTML = `
    ${warning}
    <dl>
      <dt>${scope ? "panel size" : "build size"}</dt><dd>${maps}, ${fmtBulk(placed)}</dd>
      <dt>time to take down</dt><dd>${fmtDuration(teardown)} of steady breaking, with the tools below${
        unrecoverable ? ` · <span class="flag">${countText(unrecoverable)} blocks can't be recovered</span>` : ""}</dd>
      <dt>breaks instantly</dt><dd>${placed ? Math.round((instamined / placed) * 100) : 0}% of blocks</dd>
      <dt>cost of silk touch</dt><dd>${fmtDuration(silkBurden)} extra vs. just smashing everything</dd>
      <dt>tools you need</dt><dd>${checklist}</dd>
    </dl>
    ${scope ? `<p class="note">Everything above and below is for ${scope}.</p>` : ""}
    <table class="materials">
      <thead><tr><th>block</th><th>color</th><th class="num">count</th>
        <th class="num" title="1728 blocks per shulker box">shulkers</th>
        <th class="num">each takes</th>
        <th class="num" title="count times each, with the pauses the total counts">all together</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <div class="row">
      <button id="copy-materials" class="mini"
        title="the same text the build sheet in the download carries">copy as text</button>
    </div>
    <p class="note">${checked("no-cooldown")
      ? "The takedown total counts no pause between breaks, since you run without the mining cooldown,"
      : "The takedown total counts the game's five-tick pause after every non-instant break,"}
      and prices instant blocks at your travel pace, about ${checked("flying") ? "ten" : "five"}
      a second ${checked("flying") ? "flying along" : "walking"}; the per-block column above
      shows the pure break time.</p>
    ${nerdDrawer(toolTicks, placed)}`;
  const copy = document.getElementById("copy-materials");
  if (copy) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(await buildSheet(exportName()));
        status("materials copied as text");
      } catch {
        status("your browser blocked the clipboard; the download's build sheet has the same text");
      }
    };
  }
}

function nerdDrawer(toolTicks: Map<number, number>, placed: number): string {
  const byTool = [...toolTicks.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([idx, ticks]) => {
      const t = loadout[idx];
      const label = idx === -1 ? "bare hands"
        : t ? esc(t.nick ?? autoToolName(t)) : `tool ${idx}`;
      return `${label} ${ticksText(ticks)}`;
    })
    .join(" · ") || "nothing to break";
  let drops = "every color is carrying its weight";
  if (marginalDeltas && marginalTotal >= 0) {
    const ranked = [...marginalDeltas.entries()]
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([cid, d]) => {
        const name = colors.find((c) => c.id === cid)?.name ?? `color ${cid}`;
        const cost = !Number.isFinite(d) ? "irreplaceable"
          : marginalTotal > 0 ? `+${Math.round((d / marginalTotal) * 100)}%`
          : `+${d.toFixed(2)}`;
        return `${name} ${cost}`;
      });
    if (ranked.length) drops = ranked.join(" · ");
  }
  const capRaw = ($("cliff-cap") as HTMLInputElement).value;
  const settings = [
    ($("dither") as HTMLSelectElement).selectedOptions[0]?.textContent ?? "",
    checked("dbs-refine") ? "refined for display" : "",
    `Minecraft ${($("game-version") as HTMLSelectElement).value}`,
    ($("height-mode") as HTMLSelectElement).value === "flat"
      ? "flat" : `staircased, max step ${capRaw || "any"}`,
  ].filter(Boolean).join(" · ");
  const err = marginalTotal > 0 && placed
    ? `${marginalTotal.toFixed(1)} summed, ${(marginalTotal / placed).toFixed(4)} per
       block (squared OKLab distance, whole picture)`
    : "none; every pixel is an exact palette color";
  return `
    <details class="nerd">
      <summary>more numbers</summary>
      <dl>
        <dt>time by tool</dt><dd>${byTool}</dd>
        <dt>color error carried</dt><dd>${err}</dd>
        <dt>costliest colors to lose</dt><dd>${drops}</dd>
        <dt>made with</dt><dd>${settings}</dd>
      </dl>
    </details>`;
}

function nColors(n: number): string {
  return `${n} color${n === 1 ? "" : "s"}`;
}

function renderAuditSummary(a: AuditDto) {
  const s = a.summary;
  const tc = Object.entries(s.tool_class)
    .filter(([k]) => k !== "none")
    .map(([k, v]) => `${v}× ${k}`).join(" · ");
  $("summary").innerHTML = `
    <p class="note">No image loaded. This is your standing palette: the best
      block for every color with the tools you own. Load an image to cost out a
      specific build.</p>
    <dl>
      <dt>tools it would need</dt><dd>${tc || "none"}</dd>
      <dt>breaks instantly</dt><dd>${s.instamine_colors} of 61 colors</dd>
      <dt>needs silk touch</dt><dd>${nColors(s.silk_gated_colors)}${
        s.silk_penalty_ticks ? `, ${fmtDuration(s.silk_penalty_ticks)} slower per full set` : ""}</dd>
      <dt>changes over time</dt><dd>${nColors(s.unstable_colors)} (grass, ice, unwaxed copper…)</dd>
      <dt>can't be recovered</dt><dd>${nColors(s.no_recovery_colors)}</dd>
    </dl>`;
}

let elWrap: HTMLElement;
let elCanvas: HTMLCanvasElement;
let elGrid: HTMLElement;
let lastPreview: ImageData | null = null;

let railWidth = 320;

function applyPreviewScale() {
  const panel = $("preview-panel");
  const inline = previewInline && !pipWindow;
  const zooming = !pipWindow && !inline && previewZoom > 1;
  if (!pipWindow && !inline && !zooming) {
    panel.classList.remove("zoomed");
    panel.style.setProperty("--zoom-left", "0px");
    panel.style.setProperty("--zoom-right", "0px");
    railWidth = $("preview-slot").clientWidth || railWidth;
  }
  let avail: number;
  let rightRoom = 0;
  if (pipWindow) {
    avail = Math.max(64, pipWindow.document.body.clientWidth - 16);
  } else if (inline) {
    avail = $("preview-slot").clientWidth || railWidth;
  } else if (zooming) {
    const mainEl = panel.parentElement as HTMLElement;
    rightRoom = Math.max(0, Math.round(window.innerWidth - mainEl.getBoundingClientRect().right - 16));
    const room = mainEl.clientWidth - 48 + rightRoom;
    const aspect = elCanvas.width / Math.max(1, elCanvas.height);
    const byHeight = Math.round((window.innerHeight - 160) * aspect);
    avail = Math.max(railWidth, Math.min(room, byHeight));
  } else {
    avail = railWidth;
  }
  const target = pipWindow ? avail : Math.min(railWidth * previewZoom, avail);
  const extra = zooming ? Math.max(0, Math.ceil(target) - railWidth) : 0;
  const right = Math.min(rightRoom, extra);
  panel.classList.toggle("zoomed", extra > 0);
  panel.style.setProperty("--zoom-left", `${extra - right}px`);
  panel.style.setProperty("--zoom-right", `${right}px`);
  const scale = target / elCanvas.width;
  const w = Math.max(1, Math.round(elCanvas.width * scale));
  const h = Math.max(1, Math.round(elCanvas.height * scale));
  elCanvas.style.width = `${w}px`;
  elCanvas.style.height = `${h}px`;
  const cell = 128 * scale;
  elGrid.style.display = checked("grid-overlay") ? "" : "none";
  elGrid.style.width = `${w}px`;
  elGrid.style.height = `${h}px`;
  elGrid.style.backgroundSize = `${cell}px ${cell}px`;
  renderGridNames(cell);
}

function renderGridNames(cell: number) {
  elGrid.querySelectorAll(".grid-name").forEach((n) => n.remove());
  if (!genResult || !checked("grid-overlay") || cell < 56) return;
  const tw = genResult.width / 128;
  const th = genResult.height / 128;
  for (let i = 0; i < tw * th; i++) {
    const { x, z, id } = panelCoords(i);
    const s = document.createElement("span");
    s.className = "grid-name";
    s.style.left = `${x * cell}px`;
    s.style.top = `${z * cell}px`;
    s.textContent = `x${x} z${z} · map ${id}`;
    elGrid.append(s);
  }
}

function syncPlacement() {
  document.body.classList.toggle("preview-inline", previewInline);
  const b = $("preview-place") as HTMLButtonElement;
  b.textContent = previewInline ? "back to the rail" : "into the page";
  b.title = previewInline
    ? "return the preview to the rail, where it follows as you scroll"
    : "sit the preview in the page under Source instead of the scrolling rail";
}

function syncZoomControls() {
  const out = Boolean(pipWindow);
  for (const id of ["zoom-in", "zoom-out", "zoom-fit"]) {
    const b = $(id) as HTMLButtonElement;
    b.disabled = out;
    b.title = out ? "the pop-out fits its window, so resize the window instead" : "";
  }
  ($("preview-place") as HTMLButtonElement).disabled = out;
}

function syncHasteNote() {
  $("haste-note").hidden = num("haste", 0) <= 2;
}

function wireCollapsibles() {
  for (const id of COLLAPSIBLE) {
    const h2 = document.querySelector(`#${id} > h2`);
    if (!h2) continue;
    const tools = document.createElement("span");
    tools.className = "section-tools";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini";
    tools.append(btn);
    h2.append(tools);
    const sync = () => {
      const on = collapsedSections.has(id);
      $(id).classList.toggle("collapsed", on);
      btn.textContent = on ? "show" : "hide";
      btn.title = on
        ? "expand this section"
        : "collapse this section; the heading keeps its counts";
    };
    btn.onclick = () => {
      if (collapsedSections.has(id)) collapsedSections.delete(id);
      else collapsedSections.add(id);
      sync();
      persist();
    };
    sync();
  }
}

function setPreviewHidden(hidden: boolean) {
  $("preview-panel").classList.toggle("hidden-preview", hidden);
  const btn = $("preview-toggle") as HTMLButtonElement;
  btn.textContent = hidden ? "show preview" : "hide";
  btn.title = hidden ? "bring the preview back" : "collapse the preview panel";
  if (!hidden) applyPreviewScale();
}

function paintPreview(img: ImageData) {
  lastPreview = img;
  elCanvas.width = img.width;
  elCanvas.height = img.height;
  elCanvas.getContext("2d")!.putImageData(img, 0, 0);
  applyPreviewScale();
}

let pipWindow: Window | null = null;

function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
      const style = target.createElement("style");
      style.textContent = css;
      target.head.append(style);
    } catch {
      const node = sheet.ownerNode;
      if (node) target.head.append(node.cloneNode(true));
    }
  }
}

async function openPreviewWindow(width: number, height: number): Promise<Window | null> {
  const dpip = window.documentPictureInPicture;
  if (dpip) return dpip.requestWindow({ width, height });
  return window.open("", "arachne-preview", `popup=yes,width=${width},height=${height}`);
}

async function popOutPreview() {
  if (pipWindow) return;
  const pad = 32;
  const shown = elCanvas.getBoundingClientRect();
  const fit = (n: number, avail: number) =>
    Math.max(260, Math.min(Math.round(n) + pad, Math.round(avail * 0.9)));
  pipWindow = await openPreviewWindow(
    fit(shown.width, screen.availWidth),
    fit(shown.height, screen.availHeight),
  );
  if (!pipWindow) {
    status("your browser blocked the pop-out window. Allow popups for this page");
    return;
  }
  copyStyles(pipWindow.document);
  pipWindow.document.title = "Arachne preview";
  pipWindow.document.body.className = "pip-body";
  pipWindow.document.body.append(elWrap);
  if (lastPreview) paintPreview(lastPreview);
  $("preview-away").hidden = false;
  ($("preview-popout") as HTMLButtonElement).hidden = true;
  syncZoomControls();
  pipWindow.addEventListener("pagehide", reclaimPreview);
  pipWindow.addEventListener("resize", () => applyPreviewScale());
}

function reclaimPreview() {
  const w = pipWindow;
  if (!w) return;
  pipWindow = null;
  $("preview-slot").append(elWrap);
  $("preview-away").hidden = true;
  ($("preview-popout") as HTMLButtonElement).hidden = false;
  syncZoomControls();
  if (lastPreview) paintPreview(lastPreview);
  w.close();
}

function updatePreviewMeta() {
  const meta = $("preview-meta");
  $("preview-empty").hidden = Boolean(source);
  if (!source) { meta.textContent = ""; return; }
  const { width: w, height: h } = source.bmp;
  const aImg = w / h;
  const aOut = num("maps-w", 1) / num("maps-h", 1);
  const mismatch = 1 - Math.min(aImg, aOut) / Math.max(aImg, aOut);
  const out = genResult ? ` → ${genResult.width}×${genResult.height}` : "";
  meta.textContent = `${w}×${h}${out}`;
  meta.className = "dim";
  if (fitMode() === "manual") {
    const { sw, sh } = manualWindow(source.bmp);
    meta.textContent = `${w}×${h} → framing ${sw}×${sh}${out}`;
    $("ratio-hint").textContent = "";
    return;
  }
  if (mismatch >= 0.01) {
    const mode = fitMode();
    meta.textContent += mode === "stretch"
      ? ` (stretches ~${(mismatch * 100).toFixed(0)}%)`
      : mode === "cover"
        ? ` (crops ~${(mismatch * 100).toFixed(0)}%)`
        : ` (pads ~${(mismatch * 100).toFixed(0)}%)`;
    meta.className = mode === "stretch" ? "warn-red" : "warn-orange";
  }
  $("ratio-hint").textContent = "";
}

type FitMode = "cover" | "manual" | "contain" | "stretch";

function fitMode(): FitMode {
  return ($("fit") as HTMLSelectElement).value as FitMode;
}

function manualWindow(bmp: ImageBitmap): { sx: number; sy: number; sw: number; sh: number } {
  const mapsW = maps("maps-w"), mapsH = maps("maps-h");
  const zoom = Math.min(5, Math.max(1, num("crop-zoom", 1)));
  const px = Math.min(100, Math.max(0, num("crop-x", 50)));
  const py = Math.min(100, Math.max(0, num("crop-y", 50)));
  let sw: number, sh: number;
  if (bmp.width * mapsH > bmp.height * mapsW) {
    sw = Math.floor((bmp.height * mapsW) / (mapsH * zoom));
    sh = Math.floor(bmp.height / zoom);
  } else {
    sw = Math.floor(bmp.width / zoom);
    sh = Math.floor((bmp.width * mapsH) / (mapsW * zoom));
  }
  sw = Math.max(1, Math.min(bmp.width, sw));
  sh = Math.max(1, Math.min(bmp.height, sh));
  return {
    sx: Math.floor((px * (bmp.width - sw)) / 100),
    sy: Math.floor((py * (bmp.height - sh)) / 100),
    sw,
    sh,
  };
}

const ADJUST_DEFS: [string, number][] = [
  ["adj-brightness", 0], ["adj-contrast", 0], ["adj-saturation", 100],
  ["adj-temperature", 0], ["adj-tint", 0],
];

let sourceHasAlpha = false;
let mapsTouched = false;
let honorAlphaUser: boolean | null = null;

function bgApplies(): boolean {
  return sourceHasAlpha || fitMode() === "contain";
}

function backgroundOpts(): GenerateOpts["background"] {
  const mode = ($("bg-mode") as HTMLSelectElement).value as "off" | "smooth" | "dithered";
  if (!bgApplies() || mode === "off") return undefined;
  const hex = ($("bg-color") as HTMLInputElement).value;
  const n = parseInt(hex.slice(1), 16);
  return { mode, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
}

function syncBackgroundControls() {
  const applies = bgApplies();
  $("background-row").hidden = !applies;
  if (!applies) return;
  const honor = $("honor-alpha") as HTMLInputElement;
  const contain = fitMode() === "contain";
  if (honorAlphaUser === null) honorAlphaUser = honor.checked;
  honor.disabled = contain;
  honor.checked = contain || honorAlphaUser;
  const mode = ($("bg-mode") as HTMLSelectElement).value;
  const honored = honor.checked;
  $("alpha-threshold-row").hidden = mode !== "off" || !honored;
  const why = sourceHasAlpha ? "your picture has see-through parts" : "padding leaves see-through bars";
  $("bg-note").textContent = mode !== "off"
    ? mode === "smooth"
      ? "filled with the closest color a map can make, so it stays one flat block"
      : "filled with your color, dithered like the rest of the picture"
    : honored
      ? `${why}, so they place no blocks`
      : `${why}, and with transparency off they match like solid pixels and mostly come out dark. Turn it on or pick a fill`;
}

function adjustOpts(): Adjust | undefined {
  if (!checked("adjust-on")) return undefined;
  const v = (id: string) => num(id, 0) / 100;
  return {
    brightness: v("adj-brightness"),
    contrast: v("adj-contrast"),
    saturation: num("adj-saturation", 100) / 100,
    temperature: v("adj-temperature"),
    tint: v("adj-tint"),
  };
}

function adjustIsNeutral(): boolean {
  return ADJUST_DEFS.every(([id, dflt]) => Math.round(num(id, dflt)) === dflt);
}

function syncAdjustControls() {
  const on = checked("adjust-on");
  $("adjust-controls").hidden = !on;
  ($("adjust-reset") as HTMLButtonElement).hidden = !on;
  for (const [id] of ADJUST_DEFS) {
    ($(`${id}-num`) as HTMLInputElement).value = ($(id) as HTMLInputElement).value;
  }
  const chip = $("adjust-state");
  const active = on && !adjustIsNeutral();
  chip.hidden = !active;
  if (active) {
    const parts = ADJUST_DEFS
      .filter(([id, dflt]) => Math.round(num(id, dflt)) !== dflt)
      .map(([id]) => id.replace("adj-", ""));
    chip.textContent = `adjusted: ${parts.join(", ")}`;
    chip.title = "the picture is being changed before it is matched; "
      + "exported settings carry these, a shared palette link does not";
  }
}

const CROP_PAIRS: [string, string][] = [
  ["crop-zoom", "crop-zoom-num"], ["crop-x", "crop-x-num"], ["crop-y", "crop-y-num"],
];

function syncCropControls() {
  $("crop-controls").hidden = $("crop-position").hidden = fitMode() !== "manual";
  for (const [range, field] of CROP_PAIRS) {
    ($(field) as HTMLInputElement).value = ($(range) as HTMLInputElement).value;
  }
}

function suggestRatio() {
  if (!source) return;
  const { width: w, height: h } = source.bmp;
  const mapsW = num("maps-w", 1);
  const mapsH = Math.min(16, Math.max(1, Math.round((mapsW * h) / w)));
  ($("maps-h") as HTMLInputElement).value = String(mapsH);
}

function fittedRgba(): { data: Uint8ClampedArray; width: number; height: number } {
  const bmp = source!.bmp;
  const aOut = num("maps-w", 1) / num("maps-h", 1);
  let cw = bmp.width, ch = bmp.height, sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  let dx = 0, dy = 0;
  const mode = fitMode();
  if (mode === "manual") {
    ({ sx, sy, sw, sh } = manualWindow(bmp));
    cw = sw; ch = sh;
  } else if (mode === "cover") {
    sw = Math.min(bmp.width, Math.round(bmp.height * aOut));
    sh = Math.min(bmp.height, Math.round(bmp.width / aOut));
    sx = Math.floor((bmp.width - sw) / 2);
    sy = Math.floor((bmp.height - sh) / 2);
    cw = sw; ch = sh;
  } else if (mode === "contain") {
    cw = Math.max(bmp.width, Math.round(bmp.height * aOut));
    ch = Math.max(bmp.height, Math.round(bmp.width / aOut));
    dx = Math.floor((cw - bmp.width) / 2);
    dy = Math.floor((ch - bmp.height) / 2);
  }
  const cv = new OffscreenCanvas(cw, ch);
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(bmp, sx, sy, sw, sh, dx, dy, sw, sh);
  const img = ctx.getImageData(0, 0, cw, ch);
  return { data: img.data, width: img.width, height: img.height };
}

const DITHER_MODES: { value: string; name: string; desc: string; adv: boolean }[] = [
  { value: "none", name: "none",
    desc: "every pixel snaps to its closest map color. Sharp edges, banded gradients", adv: false },
  { value: "floyd_steinberg", name: "Floyd-Steinberg",
    desc: "smooth error diffusion, the usual default", adv: false },
  { value: "atkinson", name: "Atkinson",
    desc: "lighter diffusion that keeps highlights clean", adv: false },
  { value: "yliluoma_bayer4", name: "Yliluoma 4×4",
    desc: "mixes the closest colors in a fixed grid. Truest color at display distance; the grid shows up close", adv: false },
  { value: "yliluoma_blue16", name: "Yliluoma blue noise",
    desc: "the same color mixing as irregular grain. Reads organic, like film", adv: false },
  { value: "min_avg_err", name: "Jarvis",
    desc: "error diffusion with a wider spread; close to Floyd-Steinberg", adv: true },
  { value: "burkes", name: "Burkes",
    desc: "error diffusion variant; close to Floyd-Steinberg", adv: true },
  { value: "sierra_lite", name: "Sierra Lite",
    desc: "error diffusion variant; close to Floyd-Steinberg", adv: true },
  { value: "stucki", name: "Stucki",
    desc: "error diffusion variant; close to Floyd-Steinberg", adv: true },
  { value: "bayer2", name: "Ordered 2×2",
    desc: "classic threshold pattern, no color mixing. Weak on smooth gradients", adv: true },
  { value: "ordered3", name: "Ordered 3×3",
    desc: "classic threshold pattern, no color mixing. Weak on smooth gradients", adv: true },
  { value: "bayer4", name: "Ordered 4×4",
    desc: "classic threshold pattern, no color mixing. Weak on smooth gradients", adv: true },
  { value: "yliluoma_bayer2", name: "Yliluoma 2×2",
    desc: "color mixing on the smallest pattern; coarser mixes than the 4×4", adv: true },
  { value: "yliluoma_ordered3", name: "Yliluoma 3×3",
    desc: "color mixing on a 3×3 pattern", adv: true },
];
const DITHER_SAMPLE_W = 72;
const DITHER_SAMPLE_H = 24;
const ditherChips = new Map<string, ImageData>();
let ditherSampleKey = "";
let ditherSampleBusy = false;
let ditherHot = -1;

function ditherSel(): HTMLSelectElement {
  return $("dither") as HTMLSelectElement;
}

function paintChip(cv: HTMLCanvasElement, img: ImageData | undefined) {
  if (img) cv.getContext("2d")!.putImageData(img, 0, 0);
}

function paintDitherChips() {
  paintChip($("dither-btn-chip") as HTMLCanvasElement, ditherChips.get(ditherSel().value));
  for (const cv of $("dither-drop").querySelectorAll<HTMLCanvasElement>("canvas[data-mode]")) {
    paintChip(cv, ditherChips.get(cv.dataset.mode!));
  }
}

async function refreshDitherSamples() {
  const ids = usableIds();
  if (!ids.length || ditherSampleBusy) return;
  const key = JSON.stringify([ids, tonesFor()]);
  if (key === ditherSampleKey) {
    paintDitherChips();
    return;
  }
  ditherSampleBusy = true;
  try {
    const buf = await rpc<ArrayBuffer>({
      cmd: "dither_samples",
      opts: {
        modes: DITHER_MODES.map((m) => m.value),
        enabled_color_ids: ids,
        tones: tonesFor(),
        width: DITHER_SAMPLE_W,
        height: DITHER_SAMPLE_H,
      },
    });
    const bytes = new Uint8ClampedArray(buf);
    const per = DITHER_SAMPLE_W * DITHER_SAMPLE_H * 4;
    DITHER_MODES.forEach((m, i) => {
      ditherChips.set(
        m.value,
        new ImageData(bytes.slice(i * per, (i + 1) * per), DITHER_SAMPLE_W, DITHER_SAMPLE_H));
    });
    ditherSampleKey = key;
    paintDitherChips();
  } catch {
    /* a starved palette has no samples; chips keep their last paint */
  } finally {
    ditherSampleBusy = false;
  }
}

function ditherRows(): HTMLElement[] {
  return [...$("dither-drop").querySelectorAll<HTMLElement>(".picker-row")];
}

function syncDitherButton() {
  const m = DITHER_MODES.find((x) => x.value === ditherSel().value);
  $("dither-btn-name").textContent = m?.name ?? ditherSel().value;
  paintChip($("dither-btn-chip") as HTMLCanvasElement, ditherChips.get(ditherSel().value));
  for (const row of ditherRows()) {
    row.setAttribute("aria-selected", String(row.dataset.value === ditherSel().value));
  }
}

function buildDitherDrop() {
  const drop = $("dither-drop");
  if (drop.childElementCount) return;
  let advDone = false;
  for (const m of DITHER_MODES) {
    if (m.adv && !advDone) {
      const g = document.createElement("div");
      g.className = "picker-group";
      g.textContent = "advanced";
      drop.append(g);
      advDone = true;
    }
    const row = document.createElement("div");
    row.className = "picker-row dither-row";
    row.setAttribute("role", "option");
    row.dataset.value = m.value;
    const cv = document.createElement("canvas");
    cv.className = "dither-chip";
    cv.width = DITHER_SAMPLE_W;
    cv.height = DITHER_SAMPLE_H;
    cv.dataset.mode = m.value;
    const name = document.createElement("span");
    name.className = "dither-name";
    name.textContent = m.name;
    const desc = document.createElement("span");
    desc.className = "dither-desc";
    desc.textContent = m.desc;
    row.append(cv, name, desc);
    row.onclick = () => pickDither(m.value);
    drop.append(row);
  }
}

function highlightDither() {
  ditherRows().forEach((r, i) => r.classList.toggle("hot", i === ditherHot));
  if (ditherHot >= 0) ditherRows()[ditherHot]?.scrollIntoView({ block: "nearest" });
}

function openDitherDrop() {
  buildDitherDrop();
  $("dither-drop").hidden = false;
  $("dither-btn").setAttribute("aria-expanded", "true");
  ditherHot = ditherRows().findIndex((r) => r.dataset.value === ditherSel().value);
  highlightDither();
  syncDitherButton();
  void refreshDitherSamples();
}

function closeDitherDrop() {
  $("dither-drop").hidden = true;
  $("dither-btn").setAttribute("aria-expanded", "false");
}

function pickDither(value: string) {
  ditherSel().value = value;
  ditherSel().dispatchEvent(new Event("change", { bubbles: true }));
  closeDitherDrop();
  ($("dither-btn") as HTMLButtonElement).focus();
}

let heightCap: HeightCapResult | null = null;

function maxHeightValue(): number | null {
  if (($("height-mode") as HTMLSelectElement).value === "flat") return null;
  const raw = ($("max-height") as HTMLInputElement).value;
  if (raw === "") return null;
  return Math.max(0, Math.round(Number(raw)));
}

function renderCapNote() {
  const el = $("max-height-note");
  if (!heightCap || ($("height-mode") as HTMLSelectElement).value === "flat") {
    el.textContent = "";
    return;
  }
  const cap = maxHeightValue();
  const peak = heightCap.natural_peak;
  if (cap === null) {
    el.textContent = `staircases up to ${peak} tall on its own`;
    return;
  }
  if (cap >= peak || heightCap.edited_cells === 0) {
    el.textContent = `already fits: this picture staircases ${peak} tall`;
    return;
  }
  const pct = heightCap.de_base > 0
    ? (heightCap.de_capped / heightCap.de_base - 1) * 100
    : 0;
  const cost = pct < 0.5
    ? "no visible cost from a few blocks back"
    : `picture error up about ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  const flatHint = cap === 0
    ? ". A cap of 0 is a flat build; the flat height mode makes a better flat version"
    : "";
  el.textContent =
    `recolored ${heightCap.edited_cells} blocks to fit under ${cap}; ${cost}${flatHint}`;
}

function syncHeightControls() {
  const flat = ($("height-mode") as HTMLSelectElement).value === "flat";
  $("max-height-label").hidden = flat;
  $("cliff-cap-label").hidden = flat;
  renderCapNote();
}

async function applyHeightCap(repaint: boolean) {
  if (!genResult) return;
  const capRaw = ($("cliff-cap") as HTMLInputElement).value;
  const opts: HeightCapOpts = {
    max_height: maxHeightValue(),
    cliff_cap: capRaw ? Number(capRaw) : null,
    enabled_color_ids: usableIds(),
    tones: tonesFor(),
  };
  if (repaint) status("fitting the height cap");
  try {
    heightCap = await rpc<HeightCapResult>({ cmd: "height_cap", opts });
  } catch {
    heightCap = null;
    renderCapNote();
    if (repaint && source) status(source.name);
    return;
  }
  ($("max-height") as HTMLInputElement).max = String(heightCap.natural_peak);
  supportTotalsSig = null;
  renderCapNote();
  if (repaint && genResult) {
    const preview = await rpc<ArrayBuffer>({ cmd: "preview" });
    paintPreview(
      new ImageData(new Uint8ClampedArray(preview), genResult.width, genResult.height));
    renderSummary();
    if (source) status(source.name);
  }
}

let genTimer: ReturnType<typeof setTimeout> | undefined;
let generating = false;
let queued = false;

function scheduleGenerate() {
  if (!source) return;
  clearTimeout(genTimer);
  genTimer = setTimeout(() => void generate(), 250);
}

async function generate() {
  if (!source) return;
  if (generating) { queued = true; return; }
  generating = true;
  showProgress(0);
  try {
    const src = fittedRgba();
    const hadAlpha = sourceHasAlpha;
    sourceHasAlpha = false;
    for (let i = 3; i < src.data.length; i += 4) {
      if (src.data[i] < 255) { sourceHasAlpha = true; break; }
    }
    if (sourceHasAlpha !== hadAlpha) syncBackgroundControls();
    const honorAlpha = checked("honor-alpha") || fitMode() === "contain";
    const opts: GenerateOpts = {
      maps_w: maps("maps-w"),
      maps_h: maps("maps-h"),
      adjust: adjustOpts(),
      background: backgroundOpts(),
      enabled_color_ids: usableIds(),
      tones: tonesFor(),
      dither: ($("dither") as HTMLSelectElement).value,
      serpentine: true,
      refine: ($("dbs-refine") as HTMLInputElement).checked,
      transparency_threshold: honorAlpha
        ? Math.min(99, Math.max(1, num("alpha-threshold", 50))) / 100
        : undefined,
    };
    const buf = src.data.buffer as ArrayBuffer;
    genResult = await rpc<GenerateResult>(
      { cmd: "generate", rgba: buf, width: src.width, height: src.height, opts },
      [buf],
    );
    generateSeq += 1;
    await applyHeightCap(false);
    const preview = await rpc<ArrayBuffer>({ cmd: "preview" });
    paintPreview(
      new ImageData(new Uint8ClampedArray(preview), genResult.width, genResult.height));
    ($("export-download") as HTMLButtonElement).disabled = false;
    ($("view-build") as HTMLButtonElement).disabled = false;
    ($("view-build-export") as HTMLButtonElement).disabled = false;
    status(source.name);
    updatePreviewMeta();
    await refreshSolver();
    const marginal = await rpc<MarginalErrors>(
      { cmd: "marginal", enabled: opts.enabled_color_ids, tones: opts.tones });
    marginalDeltas = new Map(marginal.per_color);
    marginalTotal = marginal.total;
    tileMaterials = await rpc<Record<string, number>[]>({ cmd: "materials_split" });
    renderSummary();
    renderPalette();
  } catch (e) {
    genResult = null;
    marginalDeltas = null;
    marginalTotal = 0;
    tileMaterials = null;
    supportTotals = null;
    supportTotalsSig = null;
    ($("export-download") as HTMLButtonElement).disabled = true;
    ($("view-build") as HTMLButtonElement).disabled = true;
    ($("view-build-export") as HTMLButtonElement).disabled = true;
    renderPalette();
    status(String(e).replace(/^Error:\s*/, ""));
  } finally {
    showProgress(null);
    generating = false;
    if (queued) { queued = false; scheduleGenerate(); }
  }
}

function tonesFor(): string[] {
  return ($("height-mode") as HTMLSelectElement).value === "flat"
    ? ["normal"]
    : ["dark", "normal", "light"];
}

async function loadFile(f: File) {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(f);
  } catch {
    status(`${f.name} does not read as an image this browser can open`);
    return;
  }
  source = { bmp, name: f.name };
  if (!mapsTouched) suggestRatio();
  updatePreviewMeta();
  status(`${f.name}: ${bmp.width}×${bmp.height}`);
  scheduleGenerate();
}

function download(name: string, bytes: ArrayBuffer) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportOpts(quiet = false): ExportOpts | null {
  if (!genResult) return null;
  const fillerBlockId = fillerId();
  const fe = fillerEntry(fillerBlockId);
  if (!fe) {
    if (!quiet) status(`filler block "${fillerBlockId}" is not a block this tool knows; pick one from the filler section`);
    return null;
  }
  if (!fillerLegal(fe.b)) {
    if (!quiet) status(versionIndex(fe.b.since) > versionIndex(gameVersion())
      ? `your filler block ${fe.b.display_name} needs ${fe.b.since}; pick another or raise the game version`
      : `${fe.b.display_name} cannot serve as filler; pick another in the filler section`);
    return null;
  }
  const selection: Record<string, number> = {};
  const blocked = unbuildableColors();
  if (blocked.length) {
    if (!quiet) status(`can't export: ${blocked.map((c) => c.name).join(", ")} `
      + "have no usable block under your current filters");
    return null;
  }
  for (const cid of Object.keys(genResult.materials).map(Number)) {
    const r = chosen(cid);
    if (!r) {
      if (!quiet) status(`color ${cid}: no candidate under current filters`);
      return null;
    }
    selection[String(cid)] = r.block_index;
  }
  const capRaw = ($("cliff-cap") as HTMLInputElement).value;
  if (capRaw && (!Number.isInteger(Number(capRaw)) || Number(capRaw) < 1)) {
    if (!quiet) status("max step must be a whole number, 1 or more (leave it blank for no limit)");
    return null;
  }
  return {
    height_mode: ($("height-mode") as HTMLSelectElement).value as "flat" | "stepped",
    cliff_cap: capRaw ? Number(capRaw) : null,
    support_mode: ($("support-mode") as HTMLSelectElement).value as ExportOpts["support_mode"],
    support_block_id: ($("support-block") as HTMLInputElement).value.trim() || "netherrack",
    borrow_north_edge: checked("borrow-edge"),
    selection,
    version: gameVersion(),
  };
}

async function viewBuild() {
  if (!genResult) return;
  const opts = exportOpts();
  if (!opts) return;
  const split = checked("split-export");
  const panels = split ? maps("maps-w") * maps("maps-h") : 1;
  try {
    await openView2D({
      atlasUrl,
      atlasCols,
      atlasTile,
      panelCount: panels,
      stepped: opts.height_mode === "stepped",
      panelLabel: (i) => panelTag(i),
      load: (panel) => rpc<ViewModel>({ cmd: "view", opts, panel: split ? panel : -1 }),
      onError: (m) => status(m),
    });
  } catch (e) {
    status(String(e).replace(/^Error:\s*/, ""));
  }
}

async function buildSheet(name: string): Promise<string> {
  const lines: string[] = [];
  lines.push(name);
  lines.push(`Made with Arachne · build ${__BUILD_ID__} · ${__BUILD_DATE__} · Minecraft ${gameVersion()}`);
  if (genResult) {
    const w = genResult.width / 128, h = genResult.height / 128;
    let placed = 0;
    for (const n of Object.values(genResult.materials)) placed += n;
    lines.push(`${w} x ${h} maps · ${fmtBulk(placed)}`);
  }
  lines.push("");

  const palette = sharePalette(true);
  if (palette) {
    try {
      const code = await rpc<string>({ cmd: "share_code", palette });
      const web = location.protocol === "http:" || location.protocol === "https:";
      if (web) {
        lines.push("Reopen this palette in Arachne:");
        lines.push(`  ${location.origin}${location.pathname}#p=${code}`);
      } else {
        lines.push("Reopen this palette by pasting this into Arachne's import box:");
        lines.push(`  ${code}`);
      }
      lines.push("");
    } catch {
      lines.push("");
    }
  }

  if (genResult) {
    lines.push("Materials");
    const rows: [string, number][] = [];
    for (const [cidStr, count] of Object.entries(genResult.materials)) {
      if (!count) continue;
      const r = chosen(Number(cidStr));
      const b = r ? blocks[r.block_index] : undefined;
      rows.push([b?.display_name ?? `color ${cidStr}`, count]);
    }
    const opts = exportOpts(true);
    if (opts) {
      try {
        const sig = `${generateSeq}:${JSON.stringify(opts)}`;
        const t = sig === supportTotalsSig && supportTotals
          ? supportTotals
          : await rpc<SupportTotals>({ cmd: "support_totals", opts });
        if (t.whole) rows.push([fillerLabel(opts.support_block_id), t.whole]);
      } catch {
        void 0;
      }
    }
    rows.sort((a, b) => b[1] - a[1]);
    const pad = rows.reduce((n, [nm]) => Math.max(n, nm.length), 0);
    for (const [nm, count] of rows) {
      lines.push(`  ${nm.padEnd(pad)}  ${countText(count).padStart(9)}  `
        + `${(count / SHULKER).toFixed(2).padStart(7)} shulkers`);
    }
  }
  return lines.join("\n") + "\n";
}

async function exportDownload() {
  if (!genResult) return;
  const opts = exportOpts();
  if (!opts) return;
  const name = exportName();
  try {
    const entries: ZipEntry[] = [];
    if (checked("split-export")) {
      const framed = await rpc<ArrayBuffer>({ cmd: "schem_split", opts });
      unframe(framed).forEach((bytes, i) =>
        entries.push({ name: `${name}_${panelTag(i)}.nbt`, bytes }));
    } else {
      const buf = await rpc<ArrayBuffer>({ cmd: "schem", opts });
      entries.push({ name: `${name}.nbt`, bytes: new Uint8Array(buf) });
    }
    if (checked("mapdat-on")) {
      const tw = genResult.width / 128, th = genResult.height / 128;
      const base = firstMapId();
      for (let tz = 0; tz < th; tz++) {
        for (let tx = 0; tx < tw; tx++) {
          const buf = await rpc<ArrayBuffer>({ cmd: "mapdat", tx, tz, version: gameVersion() });
          entries.push({ name: `map_${base + tz * tw + tx}.dat`, bytes: new Uint8Array(buf) });
        }
      }
    }
    if (checked("sheet-on")) {
      entries.push({
        name: `${name}.txt`,
        bytes: new TextEncoder().encode(await buildSheet(name)),
      });
    }
    if (entries.length === 1) {
      const only = entries[0];
      download(only.name, only.bytes.slice().buffer as ArrayBuffer);
      status(`downloaded ${only.name}`);
      return;
    }
    download(`${name}.zip`, zip(entries).buffer as ArrayBuffer);
    status(`${entries.length} files in ${name}.zip`);
  } catch (e) {
    status(String(e).replace(/^Error:\s*/, ""));
  }
}

function exportName(): string {
  const raw = ($("export-name") as HTMLInputElement).value.trim() || "arachne";
  return raw.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60) || "arachne";
}

function firstMapId(): number {
  return Math.max(0, Math.round(num("first-map-id", 0)));
}

function panelCoords(i: number): { x: number; z: number; id: number } {
  const w = genResult ? genResult.width / 128 : maps("maps-w");
  return { x: i % w, z: Math.floor(i / w), id: firstMapId() + i };
}

function panelTag(i: number): string {
  const { x, z, id } = panelCoords(i);
  return `x${x}_z${z}_map_${id}`;
}

function syncMapdatControls() {
  const on = checked("mapdat-on");
  $("mapdat-note").hidden = !on;
  const id = String(firstMapId());
  for (const el of ["mapdat-example", "mapdat-example-old"]) {
    const node = document.getElementById(el);
    if (node) node.textContent = id;
  }
}

async function boot() {
  elWrap = $("preview-wrap");
  elCanvas = $("preview") as HTMLCanvasElement;
  elGrid = $("grid-lines");
  const [init, atlasMeta] = await Promise.all([
    rpc<{ colors: MapColor[]; blocks: CandidateBlock[]; dataVersion: number;
          versions: string[];
          tools: Record<string, ToolMeta>;
          tiers: Record<string, TierMeta> }>({ cmd: "init" }),
    fetch(`${import.meta.env.BASE_URL}atlas.json`)
      .then((r) => r.json() as Promise<{ cols: number; tile: number; count: number; hash?: string }>),
  ]);
  colors = init.colors;
  versions = init.versions ?? [];
  dataVersion = init.dataVersion;
  const stamp = $("build-id");
  stamp.textContent = `${__BUILD_ID__} · ${__BUILD_DATE__} · data ${dataVersion}`;
  ($("build-source") as HTMLAnchorElement).href =
    `${import.meta.env.BASE_URL}source/arachne-${__BUILD_ID__}.tar.gz`;
  stamp.onclick = async () => {
    try {
      await navigator.clipboard.writeText(stamp.textContent ?? "");
      status("build id copied, paste it with your report");
    } catch {
      const r = document.createRange();
      r.selectNodeContents(stamp);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    }
  };

  blocks = init.blocks;
  atlasCols = atlasMeta.cols;
  atlasTile = atlasMeta.tile ?? 16;
  toolMeta = init.tools ?? {};
  tierMeta = init.tiers ?? {};
  const vsel = $("game-version") as HTMLSelectElement;
  for (const v of versions) vsel.add(new Option(v, v));
  vsel.value = versions[versions.length - 1] ?? "";
  blockIndex = buildBlockIndex(blocks);
  document.documentElement.style.setProperty("--atlas-cols", String(atlasMeta.cols));
  atlasUrl = `${import.meta.env.BASE_URL}atlas.png`
    + (atlasMeta.hash ? `?v=${atlasMeta.hash}` : "");
  document.documentElement.style.setProperty("--atlas-url", `url("${atlasUrl}")`);

  factoryFields = fieldValues();
  const saved = loadWorkspace();
  if (saved) {
    applyFields(saved.fields);
    for (const [k, v] of Object.entries(saved.toggles ?? {})) if (k in toggles) toggles[k] = v;
    const restored = sanitizeTools(saved.tools);
    if (restored.length) loadout = restored;
    for (const id of saved.enabled ?? []) if (colors.some((c) => c.id === id)) enabled.add(id);
    applyPicks(saved.picks, saved.deliberate);
    previewZoom = Math.min(8, Math.max(0.25, saved.previewZoom || 1));
    previewHidden = Boolean(saved.previewHidden);
    previewInline = Boolean(saved.previewInline);
    dismissedStale = saved.dismissedStale ?? "";
    for (const id of saved.collapsed ?? []) {
      if (COLLAPSIBLE.includes(id)) collapsedSections.add(id);
    }
  } else {
    for (const c of colors) if (!fluidOnly(c.id)) enabled.add(c.id);
  }

  wireCollapsibles();
  renderLoadout();
  renderToggles();
  syncHasteNote();
  applyTileSize();
  syncCropControls();
  syncAdjustControls();
  syncBackgroundControls();
  syncHeightControls();
  syncDitherButton();
  void refreshDitherSamples();
  syncMapdatControls();
  syncFillerUi();
  setPreviewHidden(previewHidden);
  syncPlacement();
  applyPreviewScale();
  const restored = saved ? " · your saved palette restored" : "";
  const nostore = persistenceAvailable ? "" : " · settings can't be saved in this browser";
  status(`ready: Minecraft 26.2, ${blocks.length} blocks` + restored + nostore);
  void initWhatsNew();
  void initCommunities();
  await refreshSolver();

  await consumeShareHash();
  window.addEventListener("hashchange", () => void consumeShareHash());

  bufferNumberFields();

  const runImport = (text: string, name: string) =>
    void importText(text, name).catch((e) => ioResult(String(e).replace(/^Error:\s*/, ""), true));
  $("import-open").onclick = () => $("import-file").click();
  $("import-file").onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void f.text().then((t) => runImport(t, f.name));
  };
  $("import-apply").onclick = () => {
    const box = $("import-paste") as HTMLInputElement;
    if (box.value.trim()) runImport(box.value, "pasted text");
  };
  ($("import-paste") as HTMLInputElement).onkeydown = (e) => {
    if (e.key === "Enter") $("import-apply").click();
  };
  $("export-settings").onclick = () => exportSettings();
  $("share-link").onclick = () => void copyShareLink();

  $("file").onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
  };
  elWrap.onclick = () => { if (!pipWindow) $("file").click(); };
  const popout = $("preview-popout") as HTMLButtonElement;
  popout.hidden = false;
  popout.title = window.documentPictureInPicture
    ? "open the preview in its own window, kept on top of other apps"
    : "open the preview in its own window (your browser can't keep it on top)";
  popout.onclick = () => void popOutPreview();
  window.addEventListener("pagehide", () => pipWindow?.close());
  $("preview-return").onclick = () => reclaimPreview();
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f?.type.startsWith("image/")) void loadFile(f);
  });
  document.addEventListener("paste", (e) => {
    const f = e.clipboardData?.files?.[0];
    if (f?.type.startsWith("image/")) void loadFile(f);
  });

  $("maps-w").onchange = () => {
    mapsTouched = true;
    suggestRatio(); updatePreviewMeta(); persist(); scheduleGenerate();
  };
  $("maps-h").onchange = () => {
    mapsTouched = true;
    updatePreviewMeta(); persist(); scheduleGenerate();
  };
  $("fit").onchange = () => {
    syncCropControls(); syncBackgroundControls(); updatePreviewMeta();
    persist(); scheduleGenerate();
  };
  const cropChanged = () => {
    updatePreviewMeta(); persist(); scheduleGenerate();
  };
  for (const [rangeId, fieldId] of CROP_PAIRS) {
    const range = $(rangeId) as HTMLInputElement;
    const field = $(fieldId) as HTMLInputElement;
    range.oninput = () => { field.value = range.value; cropChanged(); };
    field.oninput = () => { range.value = field.value; cropChanged(); };
    field.onchange = () => { range.value = field.value; syncCropControls(); cropChanged(); };
  }
  $("crop-reset").onclick = () => {
    for (const [rangeId, dflt] of [["crop-zoom", "1"], ["crop-x", "50"], ["crop-y", "50"]] as const) {
      ($(rangeId) as HTMLInputElement).value = dflt;
    }
    syncCropControls(); cropChanged();
  };
  $("bg-mode").onchange = $("bg-color").onchange = () => {
    syncBackgroundControls(); persist(); scheduleGenerate();
  };
  $("adjust-on").onchange = () => { syncAdjustControls(); persist(); scheduleGenerate(); };
  for (const [rangeId] of ADJUST_DEFS) {
    const range = $(rangeId) as HTMLInputElement;
    const field = $(`${rangeId}-num`) as HTMLInputElement;
    range.oninput = () => { field.value = range.value; syncAdjustControls(); };
    range.onchange = () => { syncAdjustControls(); persist(); scheduleGenerate(); };
    field.oninput = () => { range.value = field.value; };
    field.onchange = () => {
      clampNumberField(field);
      range.value = field.value;
      syncAdjustControls(); persist(); scheduleGenerate();
    };
  }
  $("adjust-reset").onclick = () => {
    for (const [id, dflt] of ADJUST_DEFS) ($(id) as HTMLInputElement).value = String(dflt);
    syncAdjustControls(); persist(); scheduleGenerate();
  };
  $("honor-alpha").onchange = () => {
    honorAlphaUser = checked("honor-alpha");
    const bg = $("bg-mode") as HTMLSelectElement;
    if (checked("honor-alpha") && bg.value !== "off") {
      bg.value = "off";
    }
    syncBackgroundControls();
    persist();
    scheduleGenerate();
  };
  {
    const range = $("alpha-threshold") as HTMLInputElement;
    const field = $("alpha-threshold-num") as HTMLInputElement;
    field.value = range.value;
    range.oninput = () => { field.value = range.value; };
    range.onchange = () => { persist(); scheduleGenerate(); };
    field.oninput = () => { range.value = field.value; };
    field.onchange = () => {
      clampNumberField(field);
      range.value = field.value;
      persist(); scheduleGenerate();
    };
  }
  $("dither").onchange = $("dbs-refine").onchange =
    () => { persist(); syncDitherButton(); scheduleGenerate(); };
  const dbtn = $("dither-btn") as HTMLButtonElement;
  dbtn.onclick = () => {
    if ($("dither-drop").hidden) openDitherDrop();
    else closeDitherDrop();
  };
  dbtn.onkeydown = (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if ($("dither-drop").hidden) {
        openDitherDrop();
        return;
      }
      const n = ditherRows().length;
      ditherHot = ev.key === "ArrowDown" ? (ditherHot + 1) % n : (ditherHot - 1 + n) % n;
      highlightDither();
    } else if (ev.key === "Enter" && !$("dither-drop").hidden) {
      ev.preventDefault();
      const row = ditherRows()[ditherHot];
      if (row?.dataset.value) pickDither(row.dataset.value);
    } else if (ev.key === "Escape") {
      closeDitherDrop();
    }
  };
  document.addEventListener("click", (ev) => {
    if (!$("dither-drop").hidden && !(ev.target as Element).closest?.(".dither-picker")) {
      closeDitherDrop();
    }
  });
  $("game-version").onchange = () => { persist(); syncFillerUi(); refreshSolver(); };
  $("height-mode").onchange = () => { renderPalette(); syncHeightControls(); scheduleGenerate(); };
  $("max-height").onchange = () => {
    const el = $("max-height") as HTMLInputElement;
    if (el.value !== "") clampNumberField(el);
    persist();
    void applyHeightCap(true);
  };
  $("support-mode").onchange = () => {
    renderFillerNotice();
    syncFillerUi();
    persist();
    if (genResult) renderSummary();
  };
  $("cliff-cap").onchange = () => { persist(); void applyHeightCap(true); };
  $("borrow-edge").onchange = () => { persist(); if (genResult) renderSummary(); };
  $("split-export").onchange = $("export-name").onchange = () => persist();
  const fillerSearch = $("filler-search") as HTMLInputElement;
  fillerSearch.onfocus = () => { fillerSearch.select(); renderFillerDrop(); };
  fillerSearch.oninput = () => renderFillerDrop();
  fillerSearch.onblur = () => { closeFillerDrop(); syncFillerUi(); };
  fillerSearch.onkeydown = (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (($("filler-drop") as HTMLElement).hidden) renderFillerDrop();
      const rows = fillerRows();
      if (!rows.length) return;
      fillerHot = ev.key === "ArrowDown"
        ? (fillerHot + 1) % rows.length
        : (fillerHot - 1 + rows.length) % rows.length;
      rows.forEach((r, i) => {
        r.classList.toggle("hot", i === fillerHot);
        r.setAttribute("aria-selected", String(i === fillerHot));
      });
      fillerSearch.setAttribute("aria-activedescendant", rows[fillerHot].id);
      rows[fillerHot].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const rows = fillerRows();
      const hot = fillerHot >= 0 ? rows[fillerHot] : rows[0];
      if (hot?.dataset.id) commitFiller(hot.dataset.id);
      fillerSearch.blur();
    } else if (ev.key === "Escape") {
      closeFillerDrop();
      syncFillerUi();
    }
  };
  $("mapdat-on").onchange = $("first-map-id").onchange = () => {
    syncMapdatControls();
    applyPreviewScale();
    persist();
  };
  $("zoom-in").onclick = () => {
    previewZoom = Math.min(8, previewZoom * 2); applyPreviewScale(); persist();
  };
  $("zoom-out").onclick = () => {
    previewZoom = Math.max(0.25, previewZoom / 2); applyPreviewScale(); persist();
  };
  $("zoom-fit").onclick = () => { previewZoom = 1; applyPreviewScale(); persist(); };
  $("preview-toggle").onclick = () => {
    previewHidden = !previewHidden;
    setPreviewHidden(previewHidden);
    persist();
  };
  window.addEventListener("resize", () => applyPreviewScale());
  $("grid-overlay").onchange = () => { applyPreviewScale(); persist(); };
  $("preview-place").onclick = () => {
    previewInline = !previewInline;
    syncPlacement();
    applyPreviewScale();
    persist();
  };
  $("export-download").onclick = () => void exportDownload();
  $("view-build").onclick = $("view-build-export").onclick = () => void viewBuild();
  $("colors-all").onclick = () => { colors.forEach((c) => enabled.add(c.id)); renderPalette(); scheduleGenerate(); };
  $("colors-none").onclick = () => { enabled.clear(); renderPalette(); scheduleGenerate(); };
  $("haste").onchange = () => { syncHasteNote(); void refreshSolver(); };
  $("flying").onchange = () => void refreshSolver();
  $("no-cooldown").onchange = () => {
    persist();
    syncPresetSelects();
    if (genResult) renderSummary();
  };
  $("tool-add").onclick = () => {
    loadout.push({ kind: "pickaxe", tier: "netherite", efficiency: 0, silk: false });
    renderLoadout();
    void refreshSolver();
  };
  $("materials-basis").onchange = () => { renderSummary(); persist(); };
  $("palette-view").onchange = () => renderPalette();
  $("palette-sort").onchange = () => renderPalette();
  $("tile-size").onchange = () => { applyTileSize(); persist(); };

  wirePresetBar<PalettePreset>(
    "palette", KEY_PALETTE_PRESETS, palettePresets,
    (name, id) => ({ id, name, ...currentPalette() }),
    applyPalettePreset,
  );
  wirePresetBar<LoadoutPreset>(
    "loadout", KEY_LOADOUT_PRESETS, loadoutPresets,
    (name, id) => ({
      id, name,
      tools: structuredClone(loadout),
      toggles: pickToggles(LOADOUT_FILTER_KEYS, toggles),
      fields: fieldValues(LOADOUT_FIELDS),
    }),
    applyLoadoutPreset,
  );

  $("reset-default").onclick = () => {
    if (!confirm("Reset palette, loadout and settings to defaults? Saved presets are kept.")) return;
    clearWorkspace();
    applyFields(factoryFields);
    loadout = structuredClone(DEFAULT_LOADOUT);
    for (const [key, dflt] of TOGGLE_DEFS) setToggle(key, dflt);
    selectionOverride.clear();
    deliberate.clear();
    enabled.clear();
    for (const c of colors) enabled.add(c.id);
    previewZoom = 1;
    dismissedStale = "";
    renderLoadout();
    syncMapdatControls();
    syncFillerUi();
    syncCropControls();
    if (source) {
      suggestRatio();
      updatePreviewMeta();
    }
    applyPreviewScale();
    void refreshSolver();
    scheduleGenerate();
  };
}

void boot().catch((e) => status(`init failed: ${e}`));
