use arachne_core::adjust::{Adjust, apply as apply_adjust};
use arachne_core::audit::{PaletteAudit, audit};
use arachne_core::color::srgb_to_linear;
use arachne_core::cost::Loadout;
use arachne_core::data::BlockData;
use arachne_core::dbs::{DbsConfig, refine_with_progress};
use arachne_core::hints::marginal_errors;
use arachne_core::image::LinImage;
use arachne_core::mapdat::mapdat_to_nbt;
use arachne_core::nbt::{read_root, write_root};
use arachne_core::palette::{Palette, Tone};
use arachne_core::quantize::{
    ATKINSON, BURKES, Dither, FLOYD_STEINBERG, Grid, Kernel, MIN_AVG_ERR, OrderedMatrix,
    YLILUOMA_CANDIDATES,
    SIERRA_LITE, STUCKI, Transparency, bayer2, bayer4, ordered3, quantize_with_progress,
};
use arachne_core::schem::{
    SchemConfig, SplitEdge, build_schem, missing_selection, schem_to_nbt, split_schem,
};
use arachne_core::share::{SharedPalette, decode as share_decode, encode as share_encode};
use arachne_core::solver::{RankedCandidate, SolverConfig, rank_color};
use arachne_core::staircase::HeightMode;
use arachne_core::support::SupportMode;
use arachne_core::view::view_model;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct GenerateOpts {
    maps_w: usize,
    maps_h: usize,
    enabled_color_ids: Vec<u8>,
    tones: Vec<Tone>,
    dither: String,
    #[serde(default)]
    serpentine: Option<bool>,
    #[serde(default)]
    transparency_threshold: Option<f32>,
    #[serde(default)]
    adjust: Adjust,
    #[serde(default)]
    background: Option<BackgroundOpt>,
    #[serde(default)]
    refine: Option<bool>,
}

#[derive(Deserialize)]
struct BackgroundOpt {
    mode: String,
    rgb: [u8; 3],
}

#[derive(Deserialize)]
struct ExportOpts {
    height_mode: String,
    #[serde(default)]
    cliff_cap: Option<u32>,
    support_mode: String,
    support_block_id: String,
    selection: BTreeMap<String, usize>,
    #[serde(default)]
    borrow_north_edge: bool,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Serialize)]
struct GenerateResult {
    width: usize,
    height: usize,
    materials: BTreeMap<u8, u32>,
}

#[derive(Serialize)]
struct RankedDto {
    block_index: usize,
    block_id: String,
    display_name: String,
    recovery_ticks: Option<u32>,
    recovery_tool: Option<i32>,
    fastest_ticks: Option<u32>,
    instamine: bool,
    silk_penalty: Option<u32>,
    gravity: bool,
    support_mandatory: bool,
    silk_gated: bool,
    unstable: bool,
    constrained: bool,
    flammable: bool,
}

#[derive(Serialize)]
struct ColorAuditDto {
    color_id: u8,
    name: String,
    rgb: [u8; 3],
    ranked: Vec<RankedDto>,
}

fn kernel_of(name: &str) -> Option<Kernel> {
    Some(match name {
        "floyd_steinberg" => FLOYD_STEINBERG,
        "min_avg_err" => MIN_AVG_ERR,
        "burkes" => BURKES,
        "sierra_lite" => SIERRA_LITE,
        "stucki" => STUCKI,
        "atkinson" => ATKINSON,
        _ => return None,
    })
}

fn ordered_of(name: &str) -> Option<OrderedMatrix> {
    Some(match name {
        "bayer2" => bayer2(),
        "bayer4" => bayer4(),
        "ordered3" => ordered3(),
        _ => return None,
    })
}

fn dither_of(name: &str, serpentine: bool) -> Result<Dither, String> {
    if name == "none" {
        return Ok(Dither::None);
    }
    if let Some(m) = name.strip_prefix("yliluoma_").and_then(ordered_of) {
        return Ok(Dither::Yliluoma {
            matrix: m,
            candidates: YLILUOMA_CANDIDATES,
        });
    }
    if let Some(m) = ordered_of(name) {
        return Ok(Dither::Ordered(m));
    }
    if let Some(kernel) = kernel_of(name) {
        return Ok(Dither::Diffusion { kernel, serpentine });
    }
    Err(format!("unknown dither: {name}"))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes).expect("in-memory gzip");
    enc.finish().expect("in-memory gzip")
}

fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn json<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

#[wasm_bindgen]
pub struct Session {
    data: BlockData,
    img: Option<LinImage>,
    grid: Option<Grid>,
    threshold: Option<f32>,
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(constructor)]
    pub fn new(blocks_json: &str) -> Result<Session, String> {
        let data = BlockData::from_json(blocks_json).map_err(|e| e.to_string())?;
        Ok(Session {
            data,
            img: None,
            grid: None,
            threshold: None,
        })
    }

    pub fn colors(&self) -> Result<String, String> {
        json(&self.data.colors)
    }

    pub fn blocks(&self) -> Result<String, String> {
        json(&self.data.blocks)
    }

    pub fn versions(&self) -> Result<String, String> {
        json(&self.data.meta.versions)
    }

    pub fn data_version(&self) -> i32 {
        self.data.meta.data_version
    }

    pub fn tool_meta(&self) -> Result<String, String> {
        json(&self.data.meta.tools)
    }

    pub fn tier_meta(&self) -> Result<String, String> {
        json(&self.data.meta.tiers)
    }

    pub fn generate(
        &mut self,
        rgba: &[u8],
        width: usize,
        height: usize,
        opts_json: &str,
        on_progress: Option<js_sys::Function>,
    ) -> Result<String, String> {
        let opts: GenerateOpts = serde_json::from_str(opts_json).map_err(|e| e.to_string())?;
        let (out_w, out_h) = (opts.maps_w * 128, opts.maps_h * 128);
        if out_w == 0 || out_h == 0 {
            return Err("maps_w/maps_h must be >= 1".to_string());
        }
        let mut img = LinImage::from_srgb_rgba(width, height, rgba).resize_area(out_w, out_h);
        apply_adjust(&mut img, &opts.adjust);
        let palette = Palette::build(&self.data, &opts.enabled_color_ids, &opts.tones);
        if palette.entries.is_empty() {
            return Err("no enabled colors".to_string());
        }
        let filled = match &opts.background {
            Some(bg) if bg.mode != "off" => {
                let lin = srgb_to_linear(bg.rgb);
                let lin = if bg.mode == "smooth" {
                    palette.nearest(lin).linear
                } else {
                    lin
                };
                img.composite_over(lin);
                true
            }
            _ => false,
        };
        let dither = dither_of(&opts.dither, opts.serpentine.unwrap_or(true))?;
        let edge = Palette::build(&self.data, &opts.enabled_color_ids, &[Tone::Light]);
        let transparency = opts
            .transparency_threshold
            .filter(|_| !filled)
            .map(|threshold| Transparency {
                threshold,
                edge: &edge,
            });
        let will_refine = opts.refine.unwrap_or(false);
        let report = |f: f32| {
            if let Some(cb) = &on_progress {
                let _ = cb.call1(&JsValue::NULL, &JsValue::from_f64(f64::from(f)));
            }
        };
        let split = if will_refine { 0.35 } else { 1.0 };
        let grid = quantize_with_progress(&img, &palette, &dither, transparency, &mut |f| {
            report(f * split);
        });
        let grid = if will_refine {
            let edge_pal = transparency.map(|t| t.edge);
            refine_with_progress(
                &img,
                &palette,
                edge_pal,
                &grid,
                &DbsConfig::default(),
                &mut |f| {
                    report(split + f * (1.0 - split));
                },
            )
            .0
        } else {
            grid
        };
        report(1.0);
        let mut materials: BTreeMap<u8, u32> = BTreeMap::new();
        for cell in grid.cells.iter().flatten() {
            *materials.entry(cell.0).or_insert(0) += 1;
        }
        let result = GenerateResult {
            width: out_w,
            height: out_h,
            materials,
        };
        self.img = Some(img);
        self.grid = Some(grid);
        self.threshold = opts.transparency_threshold;
        json(&result)
    }

    pub fn preview_rgba(&self) -> Result<Vec<u8>, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let mut out = Vec::with_capacity(grid.cells.len() * 4);
        for cell in &grid.cells {
            match cell {
                None => out.extend_from_slice(&[0, 0, 0, 0]),
                Some((cid, tone)) => {
                    let c = self
                        .data
                        .color(*cid)
                        .ok_or_else(|| "grid color missing from data".to_string())?;
                    let rgb = match tone {
                        Tone::Dark => c.tones.dark,
                        Tone::Normal => c.tones.normal,
                        Tone::Light => c.tones.light,
                        Tone::Unobtainable => c.tones.unobtainable,
                    };
                    out.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                }
            }
        }
        Ok(out)
    }

    pub fn export_mapdat(&self, tx: usize, tz: usize, version: Option<String>) -> Result<Vec<u8>, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        if (tx + 1) * 128 > grid.width || (tz + 1) * 128 > grid.height {
            return Err("tile out of range".to_string());
        }
        let mut cells = Vec::with_capacity(128 * 128);
        for z in 0..128 {
            for x in 0..128 {
                cells.push(grid.cell(tx * 128 + x, tz * 128 + z));
            }
        }
        let tile = Grid {
            width: 128,
            height: 128,
            cells,
        };
        let tag = mapdat_to_nbt(&tile, self.data.data_version_for(version.as_deref()));
        Ok(gzip(&write_root("", &tag)))
    }

    pub fn export_schem(&self, opts_json: &str) -> Result<Vec<u8>, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let opts: ExportOpts = serde_json::from_str(opts_json).map_err(|e| e.to_string())?;
        let cfg = self.schem_config(opts)?;
        let missing = missing_selection(grid, &cfg);
        if !missing.is_empty() {
            return Err(self.missing_message(&missing));
        }
        let schem = build_schem(grid, &cfg);
        let tag = schem_to_nbt(&schem, &cfg);
        Ok(gzip(&write_root("", &tag)))
    }

    pub fn export_schem_split(&self, opts_json: &str) -> Result<Vec<u8>, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let opts: ExportOpts = serde_json::from_str(opts_json).map_err(|e| e.to_string())?;
        let edge = if opts.borrow_north_edge {
            SplitEdge::Neighbor
        } else {
            SplitEdge::Filler
        };
        let cfg = self.schem_config(opts)?;
        let missing = missing_selection(grid, &cfg);
        if !missing.is_empty() {
            return Err(self.missing_message(&missing));
        }
        let joined = build_schem(grid, &cfg);
        let parts = split_schem(&joined, grid.width / 128, grid.height / 128, edge);
        let payloads: Vec<Vec<u8>> = parts
            .iter()
            .map(|p| gzip(&write_root("", &schem_to_nbt(p, &cfg))))
            .collect();
        let total: usize = payloads.iter().map(Vec::len).sum();
        let mut out = Vec::with_capacity(4 + 4 * payloads.len() + total);
        out.extend_from_slice(&u32::try_from(payloads.len()).unwrap_or(0).to_le_bytes());
        for p in &payloads {
            out.extend_from_slice(&u32::try_from(p.len()).unwrap_or(0).to_le_bytes());
        }
        for p in payloads {
            out.extend_from_slice(&p);
        }
        Ok(out)
    }

    pub fn share_code(&self, palette_json: &str) -> Result<String, String> {
        let palette: SharedPalette =
            serde_json::from_str(palette_json).map_err(|e| e.to_string())?;
        share_encode(&self.data, &palette)
    }

    pub fn read_share_code(&self, code: &str) -> Result<String, String> {
        json(&share_decode(&self.data, code)?)
    }

    pub fn view(&self, opts_json: &str, panel: i32) -> Result<String, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let opts: ExportOpts = serde_json::from_str(opts_json).map_err(|e| e.to_string())?;
        let edge = if opts.borrow_north_edge {
            SplitEdge::Neighbor
        } else {
            SplitEdge::Filler
        };
        let cfg = self.schem_config(opts)?;
        let missing = missing_selection(grid, &cfg);
        if !missing.is_empty() {
            return Err(self.missing_message(&missing));
        }
        let joined = build_schem(grid, &cfg);
        let schem = if panel < 0 {
            joined
        } else {
            let parts = split_schem(&joined, grid.width / 128, grid.height / 128, edge);
            let i = panel as usize;
            if i >= parts.len() {
                return Err(format!("no panel {i}"));
            }
            parts.into_iter().nth(i).ok_or("no such panel")?
        };
        let raw = gunzip(&gzip(&write_root("", &schem_to_nbt(&schem, &cfg))))?;
        let (_, root) = read_root(&raw)?;
        json(&view_model(&root, &self.data)?)
    }

    pub fn materials_split(&self) -> Result<String, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let (mw, mh) = (grid.width / 128, grid.height / 128);
        let mut tiles: Vec<BTreeMap<u8, u32>> = Vec::with_capacity(mw * mh);
        for tz in 0..mh {
            for tx in 0..mw {
                let mut counts: BTreeMap<u8, u32> = BTreeMap::new();
                for z in 0..128 {
                    for x in 0..128 {
                        if let Some((cid, _)) = grid.cell(tx * 128 + x, tz * 128 + z) {
                            *counts.entry(cid).or_insert(0) += 1;
                        }
                    }
                }
                tiles.push(counts);
            }
        }
        json(&tiles)
    }

    pub fn support_totals(&self, opts_json: &str) -> Result<String, String> {
        let grid = self
            .grid
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let opts: ExportOpts = serde_json::from_str(opts_json).map_err(|e| e.to_string())?;
        let edge = if opts.borrow_north_edge {
            SplitEdge::Neighbor
        } else {
            SplitEdge::Filler
        };
        let cfg = self.schem_config(opts)?;
        let missing = missing_selection(grid, &cfg);
        if !missing.is_empty() {
            return Err(self.missing_message(&missing));
        }
        let joined = build_schem(grid, &cfg);
        let panels: Vec<u32> = split_schem(&joined, grid.width / 128, grid.height / 128, edge)
            .iter()
            .map(|s| s.support_count)
            .collect();
        #[derive(Serialize)]
        struct SupportTotals {
            whole: u32,
            panels: Vec<u32>,
        }
        json(&SupportTotals {
            whole: joined.support_count,
            panels,
        })
    }

    pub fn rank(
        &self,
        color_id: u8,
        loadout_json: &str,
        config_json: &str,
    ) -> Result<String, String> {
        let (loadout, cfg) = parse_solver_inputs(loadout_json, config_json)?;
        let ranked = rank_color(&self.data, color_id, &loadout, &cfg);
        json(&self.ranked_dtos(&ranked))
    }

    pub fn audit(&self, loadout_json: &str, config_json: &str) -> Result<String, String> {
        let (loadout, cfg) = parse_solver_inputs(loadout_json, config_json)?;
        let a: PaletteAudit = audit(&self.data, &loadout, &cfg);
        #[derive(Serialize)]
        struct AuditDto {
            colors: Vec<ColorAuditDto>,
            summary: serde_json::Value,
        }
        let colors = a
            .colors
            .iter()
            .map(|c| {
                let mc = self.data.color(c.color_id).expect("audit colors exist");
                ColorAuditDto {
                    color_id: c.color_id,
                    name: mc.name.clone(),
                    rgb: mc.rgb,
                    ranked: self.ranked_dtos(&c.ranked),
                }
            })
            .collect();
        let summary = serde_json::json!({
            "tool_class": a.summary.tool_class.iter()
                .map(|(t, n)| (format!("{t:?}").to_lowercase(), n)).collect::<BTreeMap<_, _>>(),
            "instamine_colors": a.summary.instamine_colors,
            "silk_gated_colors": a.summary.silk_gated_colors,
            "silk_penalty_ticks": a.summary.silk_penalty_ticks,
            "no_recovery_colors": a.summary.no_recovery_colors,
            "unstable_colors": a.summary.unstable_colors,
            "empty_colors": a.summary.empty_colors,
        });
        json(&AuditDto { colors, summary })
    }

    pub fn marginal(&self, enabled_json: &str, tones_json: &str) -> Result<String, String> {
        let img = self
            .img
            .as_ref()
            .ok_or_else(|| "generate first".to_string())?;
        let ids: Vec<u8> = serde_json::from_str(enabled_json).map_err(|e| e.to_string())?;
        let tones: Vec<Tone> = serde_json::from_str(tones_json).map_err(|e| e.to_string())?;
        let palette = Palette::build(&self.data, &ids, &tones);
        if palette.entries.is_empty() {
            return Err("no enabled colors".to_string());
        }
        let edge = Palette::build(&self.data, &ids, &[Tone::Light]);
        let transparency = self.threshold.map(|threshold| Transparency {
            threshold,
            edge: &edge,
        });
        json(&marginal_errors(img, &palette, transparency))
    }
}

impl Session {
    fn ranked_dtos(&self, ranked: &[RankedCandidate<'_>]) -> Vec<RankedDto> {
        ranked
            .iter()
            .map(|r| {
                let recovery = r.cost.recovery();
                RankedDto {
                    block_index: r.index,
                    block_id: r.block.block_id.clone(),
                    display_name: r.block.display_name.clone(),
                    recovery_ticks: recovery.map(|p| p.ticks),
                    recovery_tool: recovery.map(|p| p.tool.map_or(-1, |i| i as i32)),
                    fastest_ticks: r.cost.fastest.map(|p| p.ticks),
                    instamine: recovery.is_some_and(|p| p.instamine()),
                    silk_penalty: r.cost.recovery_penalty(),
                    gravity: r.block.gravity,
                    support_mandatory: r.block.support_mandatory,
                    silk_gated: r.block.recoverability
                        == arachne_core::data::Recoverability::SilkGated,
                    unstable: r.block.unstable,
                    constrained: r.block.constrained,
                    flammable: r.block.flammable,
                }
            })
            .collect()
    }
}

fn parse_solver_inputs(
    loadout_json: &str,
    config_json: &str,
) -> Result<(Loadout, SolverConfig), String> {
    let loadout: Loadout = serde_json::from_str(loadout_json).map_err(|e| e.to_string())?;
    let cfg: SolverConfig = serde_json::from_str(config_json).map_err(|e| e.to_string())?;
    Ok((loadout, cfg))
}

impl Session {
    fn schem_config(&self, opts: ExportOpts) -> Result<SchemConfig<'_>, String> {
        let height_mode = match opts.height_mode.as_str() {
            "flat" => HeightMode::Flat,
            "stepped" => HeightMode::Stepped {
                cliff_cap: match opts.cliff_cap {
                    Some(0) => return Err("max step must be at least 1".to_string()),
                    c => c,
                },
            },
            m => return Err(format!("unknown height_mode: {m}")),
        };
        let support_mode = match opts.support_mode.as_str() {
            "none" => SupportMode::None,
            "important" => SupportMode::Important,
            "all_optimized" => SupportMode::AllOptimized,
            "all_double_optimized" => SupportMode::AllDoubleOptimized,
            m => return Err(format!("unknown support_mode: {m}")),
        };
        let mut selection = BTreeMap::new();
        for (cid, idx) in &opts.selection {
            let cid: u8 = cid
                .parse()
                .map_err(|_| "selection keys are color ids".to_string())?;
            let block = self
                .data
                .blocks
                .get(*idx)
                .ok_or_else(|| "selection block index out of range".to_string())?;
            if block.color_id != cid {
                return Err("selection block does not match color".to_string());
            }
            selection.insert(cid, block);
        }
        if !self
            .data
            .blocks
            .iter()
            .any(|b| b.block_id == opts.support_block_id)
        {
            return Err(format!(
                "unknown filler block: {}",
                opts.support_block_id
            ));
        }
        Ok(SchemConfig {
            height_mode,
            support_mode,
            support_block_id: opts.support_block_id,
            selection,
            data_version: self.data.data_version_for(opts.version.as_deref()),
            author: "arachne".into(),
        })
    }

    fn missing_message(&self, missing: &[u8]) -> String {
        format!(
            "no block chosen for map color{} {}",
            if missing.len() > 1 { "s" } else { "" },
            missing
                .iter()
                .map(|c| self
                    .data
                    .color(*c)
                    .map_or(c.to_string(), |m| m.name.clone()))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        Session::new(&json).unwrap()
    }

    fn silk_kit_json() -> &'static str {
        r#"{"tools":[
            {"kind":"pickaxe","tier":"netherite","efficiency":10,"silk":true},
            {"kind":"axe","tier":"netherite","efficiency":10,"silk":true},
            {"kind":"shovel","tier":"netherite","efficiency":10,"silk":true},
            {"kind":"hoe","tier":"netherite","efficiency":10,"silk":true}]}"#
    }

    #[test]
    fn full_pipeline_roundtrip() {
        let mut s = session();
        let rgba: Vec<u8> = (0..256u32 * 256)
            .flat_map(|i| {
                let v = (i % 256) as u8;
                [v, (255 - v), 128, 255]
            })
            .collect();
        let opts = r#"{"maps_w":1,"maps_h":1,
            "enabled_color_ids":[8,29,28,25,18],
            "tones":["dark","normal","light"],
            "dither":"floyd_steinberg"}"#;
        let res = s.generate(&rgba, 256, 256, opts, None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["width"], 128);
        let total: u64 = v["materials"]
            .as_object()
            .unwrap()
            .values()
            .map(|n| n.as_u64().unwrap())
            .sum();
        assert_eq!(total, 128 * 128);

        assert_eq!(s.preview_rgba().unwrap().len(), 128 * 128 * 4);

        let dat = s.export_mapdat(0, 0, None).unwrap();
        assert_eq!(&dat[..2], &[0x1f, 0x8b], "gzip magic");
        assert!(s.export_mapdat(1, 0, None).is_err());

        let cfg = r#"{}"#;
        let mut selection = serde_json::Map::new();
        for cid in [8u8, 29, 28, 25, 18] {
            let ranked: serde_json::Value =
                serde_json::from_str(&s.rank(cid, silk_kit_json(), cfg).unwrap()).unwrap();
            selection.insert(
                cid.to_string(),
                ranked[0]["block_index"].as_u64().unwrap().into(),
            );
        }
        let export = serde_json::json!({
            "height_mode": "stepped", "cliff_cap": 1,
            "support_mode": "important", "support_block_id": "netherrack",
            "selection": selection,
        });
        let schem = s.export_schem(&export.to_string()).unwrap();
        assert_eq!(&schem[..2], &[0x1f, 0x8b], "gzip magic");

        let data_version_of = |bytes: &[u8]| {
            let raw = gunzip(bytes).unwrap();
            let (_, tag) = read_root(&raw).unwrap();
            match tag.get("DataVersion") {
                Some(arachne_core::nbt::Tag::Int(v)) => *v,
                other => panic!("DataVersion missing: {other:?}"),
            }
        };
        assert_eq!(data_version_of(&schem), 4903, "no version means the newest");
        let mut stamped = serde_json::from_str::<serde_json::Value>(&export.to_string()).unwrap();
        stamped["version"] = serde_json::json!("1.16");
        let old = s.export_schem(&stamped.to_string()).unwrap();
        assert_eq!(
            data_version_of(&old),
            2566,
            "the picked release rides into the schematic"
        );
        let dat = s.export_mapdat(0, 0, Some("1.16".to_string())).unwrap();
        assert_eq!(data_version_of(&dat), 2566, "and into the map data file");

        let m: serde_json::Value = serde_json::from_str(
            &s.marginal("[8,29,28,25,18]", r#"["dark","normal","light"]"#)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(m["per_color"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn audit_dto_shape() {
        let s = session();
        let a: serde_json::Value =
            serde_json::from_str(&s.audit(silk_kit_json(), r#"{}"#).unwrap()).unwrap();
        assert_eq!(a["colors"].as_array().unwrap().len(), 61);
        assert_eq!(a["summary"]["no_recovery_colors"], 1);
        let top = &a["colors"][0]["ranked"][0];
        assert!(top["block_index"].is_number());
        assert!(top["recovery_ticks"].is_number());
    }

    #[test]
    fn selection_mismatch_rejected() {
        let mut s = session();
        let rgba = vec![255u8; 4 * 4 * 4];
        s.generate(
            &rgba,
            4,
            4,
            r#"{"maps_w":1,"maps_h":1,"enabled_color_ids":[8],"tones":["normal"],"dither":"none"}"#,
            None,
        )
        .unwrap();
        let bad = r#"{"height_mode":"flat","support_mode":"none",
            "support_block_id":"netherrack","selection":{"8":0}}"#;
        assert!(s.export_schem(bad).is_err());
    }
}
