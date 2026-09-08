import type { CandidateBlock, OwnedTool, TextItem } from "./types";

const SCHEMA = 1;
const KEY_WORKSPACE = "arachne.workspace";
export const KEY_PALETTE_PRESETS = "arachne.presets.palette";
export const KEY_LOADOUT_PRESETS = "arachne.presets.loadout";

function openStore(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = "arachne.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

const store = openStore();
export const persistenceAvailable = store !== null;

function readJson<T>(key: string): T | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {}
}

export function blockKey(b: CandidateBlock): string {
  const props = Object.keys(b.properties)
    .sort()
    .map((k) => `${k}=${b.properties[k]}`)
    .join(",");
  return props ? `${b.block_id}[${props}]` : b.block_id;
}

export interface BlockIndex {
  keyOf(index: number): string | undefined;
  indexOf(key: string): number | undefined;
}

export function buildBlockIndex(blocks: CandidateBlock[]): BlockIndex {
  const keys = blocks.map(blockKey);
  const byKey = new Map<string, number>();
  keys.forEach((k, i) => {
    if (!byKey.has(k)) byKey.set(k, i);
  });
  return {
    keyOf: (i) => keys[i],
    indexOf: (k) => byKey.get(k),
  };
}

export interface PalettePreset {
  id: string;
  name: string;
  builtin?: boolean;
  enabled: number[];
  picks: Record<string, string>;
  deliberate?: number[];
  toggles?: Record<string, boolean>;
}

export interface LoadoutPreset {
  id: string;
  name: string;
  builtin?: boolean;
  tools: OwnedTool[];
  toggles: Record<string, boolean>;
  fields: Record<string, string | boolean>;
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `p${String(store?.length ?? 0)}-${performance.now().toString(36).replace(".", "")}`;
}

export function loadPresets<T>(key: string): T[] {
  const list = readJson<T[]>(key);
  return Array.isArray(list) ? list : [];
}

export function savePresets<T>(key: string, list: T[]): void {
  writeJson(key, list);
}

export interface Workspace {
  v: number;
  enabled: number[];
  picks: Record<string, string>;
  deliberate: number[];
  tools: OwnedTool[];
  toggles: Record<string, boolean>;
  fields: Record<string, string | boolean>;
  previewZoom: number;
  previewHidden: boolean;
  previewInline?: boolean;
  dismissedStale: string;
  collapsed?: string[];
  collapsedSubs?: string[];
  text?: TextItem[];
  textOn?: boolean;
}

export function loadWorkspace(): Partial<Workspace> | null {
  const w = readJson<Record<string, unknown>>(KEY_WORKSPACE);
  if (!w || typeof w !== "object" || w.v !== SCHEMA) return null;
  const list = <T>(v: unknown, keep: (x: unknown) => boolean): T[] | undefined =>
    Array.isArray(v) ? (v.filter(keep) as T[]) : undefined;
  const record = <T>(v: unknown): T | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as T) : undefined;
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const isStr = (x: unknown) => typeof x === "string";
  return {
    v: SCHEMA,
    enabled: list<number>(w.enabled, isNum),
    picks: record<Record<string, string>>(w.picks),
    deliberate: list<number>(w.deliberate, isNum),
    tools: list<OwnedTool>(w.tools, (x) => !!x && typeof x === "object"),
    toggles: record<Record<string, boolean>>(w.toggles),
    fields: record<Record<string, string | boolean>>(w.fields),
    previewZoom: isNum(w.previewZoom) ? (w.previewZoom as number) : undefined,
    previewHidden: bool(w.previewHidden),
    previewInline: bool(w.previewInline),
    dismissedStale: isStr(w.dismissedStale) ? (w.dismissedStale as string) : undefined,
    collapsed: list<string>(w.collapsed, isStr),
    collapsedSubs: list<string>(w.collapsedSubs, isStr),
    text: list<TextItem>(w.text, (x) => !!x && typeof x === "object"),
    textOn: bool(w.textOn),
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function saveWorkspace(w: Omit<Workspace, "v">): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(KEY_WORKSPACE, { v: SCHEMA, ...w }), 400);
}

export function clearWorkspace(): void {
  clearTimeout(saveTimer);
  if (!store) return;
  try {
    store.removeItem(KEY_WORKSPACE);
  } catch {}
}
