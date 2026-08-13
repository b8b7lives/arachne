export interface PresetTable {
  sets: Record<string, number>;
  blocks: Record<string, string>;
}

export function extractPreset(text: string): string | null {
  const inUrl = text.match(/[?&]preset=([0-9A-Za-z]+)/);
  if (inUrl) return inUrl[1];
  const bare = text.trim();
  return bare.length > 1 && /^[0-9a-zQ-ZA-P]+$/.test(bare) ? bare : null;
}

const DIGITS = "QRSTUVWXYZ";

export interface PresetEntry {
  setId: string;
  index: number;
}

export function decodePreset(preset: string): PresetEntry[] {
  const out: PresetEntry[] = [];
  const re = /([0-9a-z]+)([A-Z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(preset)) !== null) {
    const digits = m[2].replace(/[Q-Z]/g, (c) => String(DIGITS.indexOf(c))).toLowerCase();
    const index = parseInt(digits, 26);
    if (Number.isNaN(index)) continue;
    out.push({ setId: parseInt(m[1], 36).toString(), index });
  }
  return out;
}

export interface ImportedPalette {
  enabled: number[];
  picks: Record<string, string>;
  skipped: number;
}

export function presetToPalette(
  preset: string,
  table: PresetTable,
  known: (key: string) => boolean,
): ImportedPalette {
  const enabled: number[] = [];
  const picks: Record<string, string> = {};
  let skipped = 0;
  for (const { setId, index } of decodePreset(preset)) {
    const colorId = table.sets[setId];
    const key = table.blocks[`${setId}:${index}`];
    if (colorId === undefined || !key || !known(key)) {
      skipped++;
      continue;
    }
    enabled.push(colorId);
    picks[String(colorId)] = key;
  }
  return { enabled, picks, skipped };
}
