// One-bit glyph sheets for the hinted letter style, written by
// data-pipeline/build-hinted.py (format in data-pipeline/README.md).

export interface HintedGlyph {
  adv: number;
  left: number;
  top: number;
  w: number;
  h: number;
  rows: Uint8Array;
}

export interface HintedBand {
  ascent: number;
  descent: number;
  glyphs: Map<number, HintedGlyph>;
}

// Kerning as the font stores it: a left class and a right class per code
// point, and a matrix of font units.
export interface HintedKern {
  left: Map<number, number>;
  right: Map<number, number>;
  cols: number;
  matrix: Int16Array;
}

export interface HintedSheet {
  ftVersion: string;
  upem: number;
  weights: number[];
  sizes: number[];
  hinting: "own" | "auto";
  bands: Map<string, HintedBand>;
  kern: HintedKern;
}

export interface HintedLine {
  placed: { g: HintedGlyph; x: number }[];
  width: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const MAGIC = "AHNT";
const FORMAT = 1;

export const bandKey = (weight: number, size: number): string => `${weight}:${size}`;

export async function fetchSheet(url: string): Promise<HintedSheet> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`hinted sheet: HTTP ${res.status}`);
  const inflated = res.body.pipeThrough(new DecompressionStream("gzip"));
  return parseSheet(new Uint8Array(await new Response(inflated).arrayBuffer()));
}

export function parseSheet(b: Uint8Array): HintedSheet {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.subarray(0, 4)) !== MAGIC)
    throw new Error("hinted sheet: bad magic");
  let p = 4;
  const format = b[p++];
  if (format !== FORMAT) throw new Error(`hinted sheet: format ${format}`);
  const ftVersion = `${b[p]}.${b[p + 1]}.${b[p + 2]}`;
  p += 3;
  const upem = dv.getUint16(p, true);
  p += 2;
  const nWeights = b[p++];
  const nSizes = b[p++];
  const flags = b[p++];
  const weights: number[] = [];
  for (let i = 0; i < nWeights; i++) {
    weights.push(dv.getUint16(p, true));
    p += 2;
  }
  const sizes = [...b.subarray(p, p + nSizes)];
  p += nSizes;
  const bands = new Map<string, HintedBand>();
  for (const w of weights) {
    for (const s of sizes) {
      const ascent = dv.getInt8(p);
      const descent = dv.getInt8(p + 1);
      const n = dv.getUint16(p + 2, true);
      p += 4;
      const glyphs = new Map<number, HintedGlyph>();
      for (let i = 0; i < n; i++) {
        const cp = dv.getUint16(p, true);
        const g: HintedGlyph = {
          adv: b[p + 2],
          left: dv.getInt8(p + 3),
          top: dv.getInt8(p + 4),
          w: b[p + 5],
          h: b[p + 6],
          rows: new Uint8Array(0),
        };
        p += 7;
        const bytes = ((g.w + 7) >> 3) * g.h;
        g.rows = b.subarray(p, p + bytes);
        p += bytes;
        glyphs.set(cp, g);
      }
      bands.set(bandKey(w, s), { ascent, descent, glyphs });
    }
  }
  const rows = dv.getUint16(p, true);
  const cols = dv.getUint16(p + 2, true);
  const nLeft = dv.getUint16(p + 4, true);
  const nRight = dv.getUint16(p + 6, true);
  p += 8;
  const left = new Map<number, number>();
  for (let i = 0; i < nLeft; i++) {
    left.set(dv.getUint16(p, true), dv.getUint16(p + 2, true));
    p += 4;
  }
  const right = new Map<number, number>();
  for (let i = 0; i < nRight; i++) {
    right.set(dv.getUint16(p, true), dv.getUint16(p + 2, true));
    p += 4;
  }
  const matrix = new Int16Array(rows * cols);
  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = dv.getInt16(p, true);
    p += 2;
  }
  if (p !== b.length) throw new Error("hinted sheet: trailing bytes");
  const kern = { left, right, cols, matrix };
  return { ftVersion, upem, weights, sizes, hinting: flags & 1 ? "own" : "auto", bands, kern };
}

export function kernOf(kern: HintedKern, left: number, right: number): number {
  const a = kern.left.get(left);
  const b = kern.right.get(right);
  return a === undefined || b === undefined ? 0 : kern.matrix[a * kern.cols + b];
}

export function missingFrom(band: HintedBand, text: string): string[] {
  const out: string[] = [];
  for (const ch of new Set([...text])) {
    if (ch === "\n" || ch === "\r") continue;
    if (!band.glyphs.has(ch.codePointAt(0)!)) out.push(ch);
  }
  return out;
}

// Pen positions from the band's advances, the sheet's kern pairs scaled to
// the size and rounded to whole blocks, and letter spacing rounded the same
// way. embolden draws each glyph twice one block apart (FreeType's bitmap
// embolden), for a family that ships no bold.
export function layoutLine(
  sheet: HintedSheet,
  band: HintedBand,
  text: string,
  size: number,
  tracking: number,
  embolden: boolean,
): HintedLine {
  const placed: { g: HintedGlyph; x: number }[] = [];
  let pen = 0;
  let prev = -1;
  const extra = embolden ? 1 : 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const g = band.glyphs.get(cp);
    if (!g) continue;
    if (prev >= 0) {
      const k = kernOf(sheet.kern, prev, cp);
      if (k) pen += Math.round((k * size) / sheet.upem);
      pen += Math.round(tracking);
    }
    placed.push({ g, x: pen });
    pen += g.adv + extra;
    prev = cp;
  }
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { g, x } of placed) {
    if (!g.w || !g.h) continue;
    left = Math.min(left, x + g.left);
    right = Math.max(right, x + g.left + g.w + extra);
    top = Math.min(top, -g.top);
    bottom = Math.max(bottom, -g.top + g.h);
  }
  if (left === Number.POSITIVE_INFINITY) left = right = top = bottom = 0;
  return { placed, width: pen, left, right, top, bottom };
}

// One byte per pixel, 1 where ink, over the line's ink box.
export function maskOf(line: HintedLine, embolden: boolean): Uint8Array {
  const w = line.right - line.left;
  const h = line.bottom - line.top;
  const mask = new Uint8Array(Math.max(0, w * h));
  for (const { g, x } of line.placed) {
    const stride = (g.w + 7) >> 3;
    for (let y = 0; y < g.h; y++) {
      const my = y - g.top - line.top;
      for (let gx = 0; gx < g.w; gx++) {
        if (!(g.rows[y * stride + (gx >> 3)] & (0x80 >> (gx & 7)))) continue;
        const mx = x + g.left + gx - line.left;
        mask[my * w + mx] = 1;
        if (embolden) mask[my * w + mx + 1] = 1;
      }
    }
  }
  return mask;
}

// The mask grown by one block in every direction, one block larger on each side.
export function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const dw = w + 2;
  const out = new Uint8Array(dw * (h + 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = 0; dy <= 2; dy++) {
        const row = (y + dy) * dw + x;
        out[row] = out[row + 1] = out[row + 2] = 1;
      }
    }
  }
  return out;
}

export function paintMask(
  mask: Uint8Array,
  w: number,
  h: number,
  rgb: [number, number, number],
): ImageData {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    d[o] = rgb[0];
    d[o + 1] = rgb[1];
    d[o + 2] = rgb[2];
    d[o + 3] = 255;
  }
  return img;
}
