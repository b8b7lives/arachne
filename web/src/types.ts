export interface MapColor {
  id: number;
  name: string;
  since: string;
  constant: string;
  rgb: [number, number, number];
  tones: {
    dark: [number, number, number];
    normal: [number, number, number];
    light: [number, number, number];
    unobtainable: [number, number, number];
  };
}

export interface CandidateBlock {
  color_id: number;
  block_id: string;
  display_name: string;
  since: string;
  properties: Record<string, string>;
  hardness: number;
  tool: string;
  min_tier: string;
  requires_tool: boolean;
  recoverability: string;
  gate: "none" | "silk" | "shears" | "silk_or_shears";
  shears_speed: number | null;
  gravity: boolean;
  support_mandatory: boolean;
  flammable: boolean;
  unstable: boolean;
  constrained: boolean;
}

export interface OwnedTool {
  kind: "pickaxe" | "axe" | "shovel" | "hoe" | "shears";
  tier: "wood" | "stone" | "copper" | "iron" | "diamond" | "netherite" | "gold";
  custom_speed?: number | null;
  efficiency: number;
  silk: boolean;
  unbreaking?: number;
  mending?: boolean;
  unbreakable?: boolean;
  nick?: string;
}

export interface TierMeta {
  speed: number;
  gate: string;
  durability: number;
}

export interface ToolMeta {
  efficiency: boolean;
  silk_touch: boolean;
  tiered: boolean;
}

export interface SolverConfig {
  env?: { haste?: number; flying?: boolean };
  version?: string;
  toggles?: Partial<{
    gravity: boolean;
    support_mandatory: boolean;
    silk_gated: boolean;
    flammable: boolean;
    unrecoverable: boolean;
    unstable: boolean;
    constrained: boolean;
    class_match_only: boolean;
  }>;
}

export interface RankedDto {
  block_index: number;
  block_id: string;
  display_name: string;
  recovery_ticks: number | null;
  recovery_tool: number | null;
  fastest_ticks: number | null;
  instamine: boolean;
  silk_penalty: number | null;
  gravity: boolean;
  support_mandatory: boolean;
  silk_gated: boolean;
  unstable: boolean;
  constrained: boolean;
  flammable: boolean;
}

export interface ColorAuditDto {
  color_id: number;
  name: string;
  rgb: [number, number, number];
  ranked: RankedDto[];
}

export interface AuditDto {
  colors: ColorAuditDto[];
  summary: {
    tool_class: Record<string, number>;
    instamine_colors: number;
    silk_gated_colors: number;
    silk_penalty_ticks: number;
    no_recovery_colors: number;
    unstable_colors: number;
    empty_colors: number;
  };
}

export interface GenerateResult {
  width: number;
  height: number;
  materials: Record<string, number>;
}

export interface MarginalErrors {
  total: number;
  per_color: [number, number][];
}

export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export interface GenerateOpts {
  maps_w: number;
  maps_h: number;
  enabled_color_ids: number[];
  tones: string[];
  dither: string;
  serpentine?: boolean;
  transparency_threshold?: number;
  adjust?: Adjust;
  background?: { mode: "off" | "smooth" | "dithered"; rgb: [number, number, number] };
  refine?: boolean;
}

export interface ExportOpts {
  height_mode: "flat" | "stepped";
  cliff_cap?: number | null;
  support_mode: "none" | "important" | "full_layer";
  support_block_id: string;
  selection: Record<string, number>;
  build_mode: BuildMode;
  version?: string;
  format?: SchemFormat;
  name?: string;
  names?: string[];
}

export type BuildMode = "one_piece" | "panels" | "continued";
export type SchemFormat = "litematic" | "nbt";

export interface SupportTotals {
  whole: number;
  panels: number[];
}

export interface DitherSampleOpts {
  modes: string[];
  enabled_color_ids: number[];
  tones: string[];
  width: number;
  height: number;
}

export interface HeightCapOpts {
  max_height: number | null;
  cliff_cap: number | null;
  enabled_color_ids: number[];
  tones: string[];
  build_mode: BuildMode;
}

export interface HeightCapResult {
  natural_peak: number;
  per_panel: boolean;
  edited_cells: number;
  edited_columns: number;
  infeasible_columns: number;
  de_base: number;
  de_capped: number;
}

export interface SharedPalette {
  enabled: number[];
  picks: Record<string, string>;
  version?: string;
}

export interface ViewPaletteEntry {
  block: number | null;
  block_id: string;
  display_name: string;
}

export interface ViewModel {
  size: [number, number, number];
  w: number;
  d: number;
  support: number;
  palette: ViewPaletteEntry[];
  cells: number[];
  heights: number[];
}

export type WorkerRequest =
  | { id: number; cmd: "init" }
  | {
      id: number;
      cmd: "generate";
      rgba: ArrayBuffer;
      width: number;
      height: number;
      opts: GenerateOpts;
    }
  | { id: number; cmd: "preview" }
  | { id: number; cmd: "mapdat"; tx: number; tz: number; version?: string }
  | { id: number; cmd: "schem"; opts: ExportOpts }
  | { id: number; cmd: "schem_split"; opts: ExportOpts }
  | { id: number; cmd: "view"; opts: ExportOpts; panel: number }
  | { id: number; cmd: "share_code"; palette: SharedPalette }
  | { id: number; cmd: "read_share_code"; code: string }
  | { id: number; cmd: "materials_split" }
  | { id: number; cmd: "support_totals"; opts: ExportOpts }
  | {
      id: number;
      cmd: "rank";
      colorId: number;
      loadout: { tools: OwnedTool[] };
      config: SolverConfig;
    }
  | { id: number; cmd: "audit"; loadout: { tools: OwnedTool[] }; config: SolverConfig }
  | { id: number; cmd: "marginal"; enabled: number[]; tones: string[] }
  | { id: number; cmd: "height_cap"; opts: HeightCapOpts }
  | { id: number; cmd: "dither_samples"; opts: DitherSampleOpts };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: number };
