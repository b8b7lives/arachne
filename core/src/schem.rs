use crate::data::CandidateBlock;
use crate::nbt::Tag;
use crate::palette::Tone;
use crate::quantize::Grid;
use crate::staircase::{HeightMode, column_heights};
use crate::support::{ColBlock, SupportMode, support_counts};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct SchemConfig<'a> {
    pub height_mode: HeightMode,
    pub support_mode: SupportMode,
    pub support_block_id: String,
    pub selection: BTreeMap<u8, &'a CandidateBlock>,
    pub data_version: i32,
    pub author: String,
}

#[derive(Debug, Clone)]
pub struct Schem {
    pub blocks: Vec<(i32, i32, i32, u32)>,
    pub palette_colors: Vec<u8>,
    pub size: [i32; 3],
    pub materials: BTreeMap<u8, u32>,
    pub support_count: u32,
}

pub fn missing_selection(grid: &Grid, cfg: &SchemConfig) -> Vec<u8> {
    let mut missing: Vec<u8> = grid
        .cells
        .iter()
        .flatten()
        .map(|(cid, _)| *cid)
        .filter(|cid| !cfg.selection.contains_key(cid))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    missing
}

pub fn build_schem(grid: &Grid, cfg: &SchemConfig) -> Schem {
    let (w, h) = (grid.width, grid.height);
    let mut materials: BTreeMap<u8, u32> = BTreeMap::new();
    for (cid, _) in grid.cells.iter().flatten() {
        *materials.entry(*cid).or_insert(0) += 1;
    }
    let palette_colors: Vec<u8> = materials.keys().copied().collect();
    let pal_index: BTreeMap<u8, u32> = palette_colors
        .iter()
        .enumerate()
        .map(|(i, &c)| (c, i as u32))
        .collect();
    let support_index = palette_colors.len() as u32;

    let mut blocks = Vec::new();
    let mut support_count = 0u32;
    let mut anchor_count = 0u32;
    let mut max_y = 0i32;
    for x in 0..w {
        let mut column: Vec<(i32, i32, i32, u32)> = Vec::new();
        let mut z0 = 0usize;
        while z0 < h {
            if grid.cell(x, z0).is_none() {
                z0 += 1;
                continue;
            }
            let mut z1 = z0;
            while z1 < h && grid.cell(x, z1).is_some() {
                z1 += 1;
            }
            let run: Vec<(u8, Tone)> = (z0..z1).map(|z| grid.cell(x, z).unwrap()).collect();
            let tones: Vec<Tone> = run.iter().map(|c| c.1).collect();
            let anchored = z0 == 0;
            let heights: Vec<i32> = if anchored {
                column_heights(&tones, cfg.height_mode)
            } else {
                std::iter::once(0)
                    .chain(column_heights(&tones[1..], cfg.height_mode))
                    .collect()
            };
            let col: Vec<ColBlock> = run
                .iter()
                .map(|(cid, tone)| ColBlock {
                    tone: *tone,
                    mandatory: cfg.selection[cid].support_mandatory,
                })
                .collect();
            let supports = support_counts(&col, cfg.support_mode);

            let first = usize::from(!anchored);
            for i in first..=run.len() {
                let y = heights[i];
                let idx = if i == 0 {
                    support_index
                } else {
                    pal_index[&run[i - 1].0]
                };
                column.push((x as i32, y, (z0 + i) as i32, idx));
                for k in 1..=supports[i] {
                    column.push((x as i32, y - k as i32, (z0 + i) as i32, support_index));
                    support_count += 1;
                }
            }
            anchor_count += u32::from(anchored);
            z0 = z1;
        }
        if column.is_empty() {
            continue;
        }
        let min_y = column.iter().map(|b| b.1).min().unwrap();
        if min_y < 0 {
            for b in &mut column {
                b.1 -= min_y;
            }
        }
        max_y = max_y.max(column.iter().map(|b| b.1).max().unwrap());
        blocks.extend(column);
    }
    support_count += anchor_count;

    Schem {
        blocks,
        palette_colors,
        size: [w as i32, max_y + 1, h as i32 + 1],
        materials,
        support_count,
    }
}

// Heights realize the tone grid; the grid is the color truth (minecraft#59).
// OnePiece: one noobline, one solve. Panels: every 128x128 window solved on
// its own noobline, built anywhere. Continued: the one-piece solve sliced,
// absolute heights kept, panels pasted at one Y so seams shade correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildMode {
    OnePiece,
    Panels,
    Continued,
}

pub fn build_panels(grid: &Grid, cfg: &SchemConfig, mode: BuildMode) -> Vec<Schem> {
    match mode {
        BuildMode::OnePiece => vec![build_schem(grid, cfg)],
        BuildMode::Panels => grid
            .panel_windows()
            .into_iter()
            .map(|(x0, z0)| build_schem(&grid.window(x0, z0, 128, 128), cfg))
            .collect(),
        BuildMode::Continued => {
            let joined = build_schem(grid, cfg);
            split_continued(&joined, grid.width.div_ceil(128), grid.height.div_ceil(128))
        }
    }
}

// Every panel keeps the joined build's heights and carries the row north of
// it (the joined noobline or the previous panel's last row) for placement.
pub fn split_continued(s: &Schem, maps_w: usize, maps_h: usize) -> Vec<Schem> {
    let support_index = s.palette_colors.len() as u32;
    let mut out = Vec::with_capacity(maps_w * maps_h);
    for tz in 0..maps_h {
        let z_lo = tz as i32 * 128;
        let z_hi = z_lo + 129;
        for tx in 0..maps_w {
            let x_lo = tx as i32 * 128;
            let x_hi = x_lo + 128;
            let blocks: Vec<(i32, i32, i32, u32)> = s
                .blocks
                .iter()
                .filter(|b| b.0 >= x_lo && b.0 < x_hi && b.2 >= z_lo && b.2 < z_hi)
                .map(|b| (b.0 - x_lo, b.1, b.2 - z_lo, b.3))
                .collect();
            let max_y = blocks.iter().map(|b| b.1).max().unwrap_or(0);
            let mut materials: BTreeMap<u8, u32> = BTreeMap::new();
            let mut support_count = 0u32;
            for b in &blocks {
                if tz > 0 && b.2 == 0 {
                    continue;
                }
                if b.3 == support_index {
                    support_count += 1;
                } else {
                    *materials.entry(s.palette_colors[b.3 as usize]).or_insert(0) += 1;
                }
            }
            out.push(Schem {
                blocks,
                palette_colors: s.palette_colors.clone(),
                size: [
                    (s.size[0] - x_lo).min(128),
                    max_y + 1,
                    (s.size[2] - z_lo).min(129),
                ],
                materials,
                support_count,
            });
        }
    }
    out
}

pub fn schem_to_nbt(s: &Schem, cfg: &SchemConfig) -> Tag {
    let blocks: Vec<Tag> = s
        .blocks
        .iter()
        .map(|&(x, y, z, idx)| {
            Tag::compound(vec![
                (
                    "pos",
                    Tag::list_of(3, vec![Tag::Int(x), Tag::Int(y), Tag::Int(z)]),
                ),
                ("state", Tag::Int(idx as i32)),
            ])
        })
        .collect();

    let mut palette: Vec<Tag> = s
        .palette_colors
        .iter()
        .map(|cid| {
            let b = cfg.selection[cid];
            let mut pairs = vec![(
                "Name".to_string(),
                Tag::String(format!("minecraft:{}", b.block_id)),
            )];
            if !b.properties.is_empty() {
                let props: Vec<(String, Tag)> = {
                    let mut p: Vec<_> = b.properties.iter().collect();
                    p.sort();
                    p.into_iter()
                        .map(|(k, v)| (k.clone(), Tag::String(v.clone())))
                        .collect()
                };
                pairs.push(("Properties".to_string(), Tag::Compound(props)));
            }
            Tag::Compound(pairs)
        })
        .collect();
    palette.push(Tag::compound(vec![(
        "Name",
        Tag::String(format!("minecraft:{}", cfg.support_block_id)),
    )]));

    Tag::compound(vec![
        ("blocks", Tag::list_of(10, blocks)),
        ("entities", Tag::list_of(10, vec![])),
        ("palette", Tag::list_of(10, palette)),
        (
            "size",
            Tag::list_of(
                3,
                vec![
                    Tag::Int(s.size[0]),
                    Tag::Int(s.size[1]),
                    Tag::Int(s.size[2]),
                ],
            ),
        ),
        ("author", Tag::String(cfg.author.clone())),
        ("DataVersion", Tag::Int(cfg.data_version)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::BlockData;
    use crate::heightcap::natural_peak;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    fn setup() -> (BlockData, Grid) {
        let d = data();
        let cells = vec![
            Some((8u8, Tone::Normal)),
            Some((29u8, Tone::Light)),
            Some((8u8, Tone::Dark)),
            Some((29u8, Tone::Normal)),
        ];
        let grid = Grid {
            width: 2,
            height: 2,
            cells,
        };
        (d, grid)
    }

    fn cfg<'a>(
        d: &'a BlockData,
        height_mode: HeightMode,
        support_mode: SupportMode,
    ) -> SchemConfig<'a> {
        let mut selection = BTreeMap::new();
        for cid in [8u8, 29] {
            selection.insert(cid, d.candidates_for(cid).next().unwrap());
        }
        SchemConfig {
            height_mode,
            support_mode,
            support_block_id: "cobblestone".into(),
            selection,
            data_version: d.meta.data_version,
            author: "arachne".into(),
        }
    }

    fn carpet_cfg(d: &BlockData, cliff_cap: Option<u32>, support_mode: SupportMode) -> SchemConfig<'_> {
        let mut c = cfg(d, HeightMode::Stepped { cliff_cap }, support_mode);
        let carpet = d
            .candidates_for(8)
            .find(|b| b.support_mandatory)
            .expect("color 8 has a support-mandatory candidate");
        c.selection.insert(8, carpet);
        c
    }

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 33) as u32
        }
        fn chance(&mut self, num: u32, den: u32) -> bool {
            self.next() % den < num
        }
    }

    // Random tone grid honoring the pipeline invariant: a cell whose north
    // neighbor is transparent is Light (the jar renders it light regardless).
    fn random_grid(seed: u64, w: usize, h: usize) -> Grid {
        let mut rng = Lcg(seed);
        let band = 120 + (rng.next() % 16) as usize;
        let mut cells: Vec<Option<(u8, Tone)>> = vec![None; w * h];
        for z in 0..h {
            for x in 0..w {
                let hole = rng.chance(2, 25)
                    || (z >= band && z < band + 3 && x % 4 == 0)
                    || (x >= w / 3 && x < w / 3 + 5 && z > h / 2);
                if hole {
                    continue;
                }
                let cid = if rng.chance(1, 3) { 29u8 } else { 8u8 };
                let north_gone = z > 0 && cells[(z - 1) * w + x].is_none();
                let tone = if north_gone {
                    Tone::Light
                } else {
                    match rng.next() % 3 {
                        0 => Tone::Dark,
                        1 => Tone::Normal,
                        _ => Tone::Light,
                    }
                };
                cells[z * w + x] = Some((cid, tone));
            }
        }
        Grid {
            width: w,
            height: h,
            cells,
        }
    }

    // Flat pictures carry Normal everywhere except the forced-light edge.
    fn flat_grid(seed: u64, w: usize, h: usize) -> Grid {
        let mut g = random_grid(seed, w, h);
        for z in 0..h {
            for x in 0..w {
                if let Some((cid, _)) = g.cells[z * w + x] {
                    let north_gone = z > 0 && g.cells[(z - 1) * w + x].is_none();
                    g.cells[z * w + x] = Some((cid, if north_gone { Tone::Light } else { Tone::Normal }));
                }
            }
        }
        g
    }

    // The jar rule: a pixel's tone is the sign of its top block's height
    // against the top block one row north; no block north renders light.
    // Returns tones keyed by picture cell (x, z-1) for every non-filler top.
    fn shade(blocks: &[(i32, i32, i32, u32)], support_index: u32) -> BTreeMap<(i32, i32), Tone> {
        let mut tops: BTreeMap<(i32, i32), (i32, u32)> = BTreeMap::new();
        for b in blocks {
            let e = tops.entry((b.0, b.2)).or_insert((b.1, b.3));
            if b.1 > e.0 {
                *e = (b.1, b.3);
            }
        }
        let mut out = BTreeMap::new();
        for (&(x, z), &(y, idx)) in &tops {
            if idx == support_index {
                continue;
            }
            let tone = match tops.get(&(x, z - 1)) {
                None => Tone::Light,
                Some(&(ny, _)) => match y.cmp(&ny) {
                    std::cmp::Ordering::Greater => Tone::Light,
                    std::cmp::Ordering::Equal => Tone::Normal,
                    std::cmp::Ordering::Less => Tone::Dark,
                },
            };
            out.insert((x, z - 1), tone);
        }
        out
    }

    fn assert_shades_match(grid: &Grid, shaded: &BTreeMap<(i32, i32), Tone>, label: &str) {
        let mut seen = 0usize;
        for z in 0..grid.height {
            for x in 0..grid.width {
                let Some((_, tone)) = grid.cell(x, z) else {
                    assert!(
                        !shaded.contains_key(&(x as i32, z as i32)),
                        "{label}: a block sits on transparent cell ({x}, {z})"
                    );
                    continue;
                };
                let got = shaded
                    .get(&(x as i32, z as i32))
                    .unwrap_or_else(|| panic!("{label}: cell ({x}, {z}) has no block"));
                assert_eq!(*got, tone, "{label}: cell ({x}, {z}) shades wrong");
                seen += 1;
            }
        }
        assert_eq!(seen, grid.cells.iter().flatten().count(), "{label}: every cell checked");
    }

    fn placed_union(parts: &[Schem], maps_w: usize) -> Vec<(i32, i32, i32, u32)> {
        let mut union = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            let (tx, tz) = (i % maps_w, i / maps_w);
            for b in &part.blocks {
                union.push((b.0 + tx as i32 * 128, b.1, b.2 + tz as i32 * 128, b.3));
            }
        }
        union.sort_unstable();
        union.dedup();
        union
    }

    #[test]
    fn flat_no_supports() {
        let (d, grid) = setup();
        let c = cfg(&d, HeightMode::Flat, SupportMode::None);
        let s = build_schem(&grid, &c);
        assert_eq!(s.blocks.len(), 6);
        let ys: Vec<(i32, i32, i32)> = s.blocks.iter().map(|b| (b.0, b.2, b.1)).collect();
        assert_eq!(
            ys,
            vec![(0, 0, 2), (0, 1, 2), (0, 2, 2), (1, 0, 1), (1, 1, 2), (1, 2, 2)],
            "flat sits at one level; the light top row of column 1 drops its reference row"
        );
        assert_eq!(s.size, [2, 3, 3]);
        assert_eq!(s.materials.get(&8), Some(&2));
        assert_eq!(s.materials.get(&29), Some(&2));
        assert_eq!(s.support_count, 2);
    }

    #[test]
    fn stepped_heights_follow_tones() {
        let (d, grid) = setup();
        let c = cfg(
            &d,
            HeightMode::Stepped { cliff_cap: None },
            SupportMode::None,
        );
        let s = build_schem(&grid, &c);
        let col0: Vec<_> = s.blocks.iter().filter(|b| b.0 == 0).collect();
        assert_eq!(
            col0.iter().map(|b| (b.2, b.1)).collect::<Vec<_>>(),
            vec![(0, 1), (1, 1), (2, 0)]
        );
        let col1: Vec<_> = s.blocks.iter().filter(|b| b.0 == 1).collect();
        assert_eq!(
            col1.iter().map(|b| (b.2, b.1)).collect::<Vec<_>>(),
            vec![(0, 0), (1, 1), (2, 1)]
        );
    }

    #[test]
    fn every_mode_counts_nooblines_where_the_builder_places_them() {
        let (d, _) = setup();
        let cells = vec![Some((8u8, Tone::Normal)); 256 * 256];
        let grid = Grid {
            width: 256,
            height: 256,
            cells,
        };
        let c = cfg(&d, HeightMode::Flat, SupportMode::None);
        let one = build_panels(&grid, &c, BuildMode::OnePiece);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].support_count, 256);
        let counts: Vec<u32> = build_panels(&grid, &c, BuildMode::Panels)
            .iter()
            .map(|p| p.support_count)
            .collect();
        assert_eq!(counts, vec![128, 128, 128, 128], "every panel places its own noobline");
        let counts: Vec<u32> = build_panels(&grid, &c, BuildMode::Continued)
            .iter()
            .map(|p| p.support_count)
            .collect();
        assert_eq!(counts, vec![128, 128, 0, 0], "southern panels stand on the row above");
    }

    #[test]
    fn only_a_run_on_the_north_border_gets_an_anchor() {
        let (d, _) = setup();
        let grid = Grid {
            width: 1,
            height: 4,
            cells: vec![
                Some((8u8, Tone::Normal)),
                None,
                Some((29u8, Tone::Light)),
                Some((8u8, Tone::Dark)),
            ],
        };
        let c = cfg(&d, HeightMode::Flat, SupportMode::None);
        let s = build_schem(&grid, &c);
        assert_eq!(s.blocks.len(), 4);
        assert_eq!(s.materials.get(&8), Some(&2));
        assert_eq!(s.materials.get(&29), Some(&1));
        assert_eq!(s.support_count, 1, "only the noobline run is anchored");
        let zs: Vec<i32> = s.blocks.iter().map(|b| b.2).collect();
        assert_eq!(zs, vec![0, 1, 3, 4], "nothing lands on the transparent row");
        let support_index = s.palette_colors.len() as u32;
        assert_eq!(s.blocks[0].3, support_index);
        assert!(
            s.blocks[1..].iter().all(|b| b.3 != support_index),
            "the only filler is the noobline"
        );
        let c = cfg(
            &d,
            HeightMode::Stepped { cliff_cap: None },
            SupportMode::None,
        );
        let s = build_schem(&grid, &c);
        let col: Vec<(i32, i32)> = s.blocks.iter().map(|b| (b.2, b.1)).collect();
        assert_eq!(col, vec![(0, 0), (1, 0), (3, 1), (4, 0)]);
    }

    #[test]
    fn no_filler_ever_lands_inside_the_view() {
        let d = data();
        let (w, h) = (128usize, 256usize);
        let cells: Vec<Option<(u8, Tone)>> = (0..w * h)
            .map(|i| {
                let (x, z) = (i % w, i / w);
                let dx = x as i32 - 64;
                let dz = z as i32 - 128;
                let solid = dx * dx + dz * dz <= 3600 || (20..40).contains(&x) && z < 100;
                if !solid || (x % 23 == 5 && z % 19 == 7) {
                    return None;
                }
                let tone = match (i / 3) % 3 {
                    0 => Tone::Dark,
                    1 => Tone::Normal,
                    _ => Tone::Light,
                };
                Some((8u8, tone))
            })
            .collect();
        let grid = Grid {
            width: w,
            height: h,
            cells,
        };
        let c = cfg(
            &d,
            HeightMode::Stepped { cliff_cap: None },
            SupportMode::Important,
        );
        let top = |blocks: &[(i32, i32, i32, u32)], x: i32, z: i32| {
            blocks
                .iter()
                .filter(|b| b.0 == x && b.2 == z)
                .max_by_key(|b| b.1)
                .map(|b| b.3)
        };
        for mode in [BuildMode::OnePiece, BuildMode::Panels, BuildMode::Continued] {
            for (i, part) in build_panels(&grid, &c, mode).iter().enumerate() {
                let support_index = part.palette_colors.len() as u32;
                for x in 0..part.size[0] {
                    for z in 1..part.size[2] {
                        if let Some(idx) = top(&part.blocks, x, z) {
                            assert_ne!(
                                idx,
                                support_index,
                                "{mode:?}: panel {i} filler paints ({x}, {})",
                                z - 1
                            );
                        }
                    }
                    if mode == BuildMode::Panels && top(&part.blocks, x, 0).is_some() {
                        assert!(
                            top(&part.blocks, x, 1).is_some(),
                            "panel {i} noobline at {x} references nothing"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn panels_mode_gives_every_panel_its_own_noobline_from_the_ground() {
        let d = data();
        let (mw, mh) = (1usize, 2usize);
        let (w, h) = (mw * 128, mh * 128);
        let cells: Vec<Option<(u8, Tone)>> = (0..w * h)
            .map(|i| {
                let tone = match (i / 5) % 3 {
                    0 => Tone::Dark,
                    1 => Tone::Normal,
                    _ => Tone::Light,
                };
                Some((8u8, tone))
            })
            .collect();
        let grid = Grid {
            width: w,
            height: h,
            cells,
        };
        let c = carpet_cfg(&d, None, SupportMode::Important);
        let parts = build_panels(&grid, &c, BuildMode::Panels);
        let support_index = parts[0].palette_colors.len() as u32;

        for (i, part) in parts.iter().enumerate() {
            let edge: Vec<_> = part.blocks.iter().filter(|b| b.2 == 0).collect();
            assert_eq!(edge.len(), 128, "panel {i}: one reference block per column");
            assert!(
                edge.iter().all(|b| b.3 == support_index),
                "panel {i}: the reference row is filler, not picture blocks"
            );
            for x in 0..128 {
                let min = part.blocks.iter().filter(|b| b.0 == x).map(|b| b.1).min().unwrap();
                assert_eq!(min, 0, "panel {i} column {x} does not start on the ground");
            }
            let picture: u32 = part.materials.values().sum();
            assert_eq!(picture, 128 * 128);
            let filler_blocks = part
                .blocks
                .iter()
                .filter(|b| b.3 == support_index)
                .count() as u32;
            assert_eq!(
                part.support_count, filler_blocks,
                "the count is every filler the panel builder places"
            );
        }
    }

    #[test]
    fn panels_mode_peaks_at_each_panels_own_natural_peak() {
        let d = data();
        for seed in [3u64, 11, 42] {
            let grid = random_grid(seed, 256, 256);
            for cliff_cap in [None, Some(1), Some(3)] {
                let c = cfg(&d, HeightMode::Stepped { cliff_cap }, SupportMode::None);
                let parts = build_panels(&grid, &c, BuildMode::Panels);
                for (i, (x0, z0)) in grid.panel_windows().into_iter().enumerate() {
                    let win = grid.window(x0, z0, 128, 128);
                    let peak = natural_peak(&win, cliff_cap) as i32;
                    assert_eq!(parts[i].size[1], peak + 1, "seed {seed} cap {cliff_cap:?} panel {i}");
                }
                let joined = build_schem(&grid, &c);
                let tallest = parts.iter().map(|p| p.size[1]).max().unwrap();
                assert!(tallest <= joined.size[1], "a panel never needs more than the whole");
            }
        }
    }

    #[test]
    fn shading_matches_the_tone_grid_in_every_mode() {
        let d = data();
        for seed in [1u64, 7, 99] {
            let grid = random_grid(seed, 256, 256);
            for cliff_cap in [None, Some(1)] {
                for support in [SupportMode::None, SupportMode::Important, SupportMode::FullLayer] {
                    let c = carpet_cfg(&d, cliff_cap, support);
                    let label = |m: &str| format!("seed {seed} cap {cliff_cap:?} {support:?} {m}");

                    let one = build_schem(&grid, &c);
                    let si = one.palette_colors.len() as u32;
                    assert_shades_match(&grid, &shade(&one.blocks, si), &label("one piece"));

                    let parts = build_panels(&grid, &c, BuildMode::Panels);
                    for (i, (x0, z0)) in grid.panel_windows().into_iter().enumerate() {
                        let win = grid.window(x0, z0, 128, 128);
                        let si = parts[i].palette_colors.len() as u32;
                        assert_shades_match(&win, &shade(&parts[i].blocks, si), &label(&format!("panel {i} alone")));
                    }

                    let parts = build_panels(&grid, &c, BuildMode::Continued);
                    let union = placed_union(&parts, 2);
                    let si = parts[0].palette_colors.len() as u32;
                    assert_shades_match(&grid, &shade(&union, si), &label("continued, pasted at one Y"));
                }
            }
        }
    }

    #[test]
    fn flat_shading_matches_the_tone_grid_in_every_mode() {
        let d = data();
        for seed in [2u64, 8] {
            let grid = flat_grid(seed, 256, 256);
            assert!(
                grid.cells.iter().flatten().any(|c| c.1 == Tone::Light),
                "seed {seed} carries forced-light edges"
            );
            for support in [SupportMode::None, SupportMode::Important, SupportMode::FullLayer] {
                let mut c = cfg(&d, HeightMode::Flat, support);
                let carpet = d.candidates_for(8).find(|b| b.support_mandatory).unwrap();
                c.selection.insert(8, carpet);
                let label = |m: &str| format!("flat seed {seed} {support:?} {m}");

                let one = build_schem(&grid, &c);
                let si = one.palette_colors.len() as u32;
                assert_shades_match(&grid, &shade(&one.blocks, si), &label("one piece"));

                let parts = build_panels(&grid, &c, BuildMode::Panels);
                for (i, (x0, z0)) in grid.panel_windows().into_iter().enumerate() {
                    let win = grid.window(x0, z0, 128, 128);
                    let si = parts[i].palette_colors.len() as u32;
                    assert_shades_match(&win, &shade(&parts[i].blocks, si), &label(&format!("panel {i} alone")));
                }

                let parts = build_panels(&grid, &c, BuildMode::Continued);
                let union = placed_union(&parts, 2);
                let si = parts[0].palette_colors.len() as u32;
                assert_shades_match(&grid, &shade(&union, si), &label("continued"));
            }
        }
    }

    #[test]
    fn continued_seams_step_the_way_the_tone_says() {
        let d = data();
        let grid = random_grid(5, 128, 256);
        let c = cfg(&d, HeightMode::Stepped { cliff_cap: None }, SupportMode::None);
        let parts = build_panels(&grid, &c, BuildMode::Continued);
        let support_index = parts[0].palette_colors.len() as u32;
        let top = |part: &Schem, x: i32, z: i32| {
            part.blocks
                .iter()
                .filter(|b| b.0 == x && b.2 == z && b.3 != support_index)
                .map(|b| b.1)
                .max()
        };
        let mut checked = 0;
        for x in 0..128 {
            let (Some(north), Some(south)) = (top(&parts[0], x, 128), top(&parts[1], x, 1)) else {
                continue;
            };
            let (_, tone) = grid.cell(x as usize, 128).unwrap();
            let expect = match south.cmp(&north) {
                std::cmp::Ordering::Greater => Tone::Light,
                std::cmp::Ordering::Equal => Tone::Normal,
                std::cmp::Ordering::Less => Tone::Dark,
            };
            assert_eq!(expect, tone, "column {x} seam");
            checked += 1;
        }
        assert!(checked > 100, "seam columns compared: {checked}");
    }

    #[test]
    fn materials_are_identical_across_modes() {
        let d = data();
        let grid = random_grid(13, 256, 256);
        let c = carpet_cfg(&d, None, SupportMode::Important);
        let one = build_schem(&grid, &c);
        for mode in [BuildMode::Panels, BuildMode::Continued] {
            let mut summed: BTreeMap<u8, u32> = BTreeMap::new();
            for part in build_panels(&grid, &c, mode) {
                for (cid, n) in &part.materials {
                    *summed.entry(*cid).or_insert(0) += n;
                }
            }
            assert_eq!(summed, one.materials, "{mode:?}");
        }
    }

    #[test]
    fn continued_partitions_the_joined_build() {
        let d = data();
        let (mw, mh) = (2usize, 2usize);
        let (w, h) = (mw * 128, mh * 128);
        let cells: Vec<Option<(u8, Tone)>> = (0..w * h)
            .map(|i| {
                let tone = match (i / 7) % 3 {
                    0 => Tone::Dark,
                    1 => Tone::Normal,
                    _ => Tone::Light,
                };
                Some((if (i / 13) % 2 == 0 { 8u8 } else { 29u8 }, tone))
            })
            .collect();
        let grid = Grid {
            width: w,
            height: h,
            cells,
        };
        let c = cfg(
            &d,
            HeightMode::Stepped { cliff_cap: None },
            SupportMode::Important,
        );
        let joined = build_schem(&grid, &c);
        let parts = build_panels(&grid, &c, BuildMode::Continued);
        assert_eq!(parts.len(), mw * mh);
        for part in &parts {
            assert_eq!(part.size[2], 129);
        }

        let mut rebuilt: Vec<(i32, i32, i32, u32)> = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            let (tx, tz) = (i % mw, i / mw);
            for b in &part.blocks {
                rebuilt.push((b.0 + tx as i32 * 128, b.1, b.2 + tz as i32 * 128, b.3));
            }
        }
        let mut union = rebuilt.clone();
        union.sort_unstable();
        let repeats = union.len() - {
            let mut u = union.clone();
            u.dedup();
            u.len()
        };
        union.dedup();
        let mut joined_blocks = joined.blocks.clone();
        joined_blocks.sort_unstable();
        assert_eq!(union, joined_blocks, "panels must cover the joined build exactly");
        assert!(repeats > 0, "southern panels should repeat the reference row");

        let mut supports = 0u32;
        for part in &parts {
            supports += part.support_count;
        }
        assert_eq!(supports, joined.support_count);
    }

    #[test]
    fn every_picture_block_belongs_to_one_panel_with_transparency() {
        let d = data();
        let (mw, mh) = (2usize, 2usize);
        let (w, h) = (mw * 128, mh * 128);
        let cells: Vec<Option<(u8, Tone)>> = (0..w * h)
            .map(|i| {
                let (x, z) = (i % w, i / w);
                if ((120..136).contains(&z) && x % 5 == 0) || (x % 17 == 3 && z % 11 == 4) {
                    return None;
                }
                let tone = match (i / 3) % 3 {
                    0 => Tone::Dark,
                    1 => Tone::Normal,
                    _ => Tone::Light,
                };
                Some((8u8, tone))
            })
            .collect();
        let grid = Grid {
            width: w,
            height: h,
            cells,
        };
        let c = cfg(
            &d,
            HeightMode::Stepped { cliff_cap: None },
            SupportMode::Important,
        );
        let joined = build_schem(&grid, &c);
        let support_index = joined.palette_colors.len() as u32;
        let total = joined.blocks.iter().filter(|b| b.3 != support_index).count();

        for mode in [BuildMode::Panels, BuildMode::Continued] {
            let parts = build_panels(&grid, &c, mode);
            let owned: usize = parts
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let tz = i / mw;
                    p.blocks
                        .iter()
                        .filter(|b| !(tz > 0 && b.2 == 0))
                        .filter(|b| b.3 != support_index)
                        .count()
                })
                .sum();
            assert_eq!(owned, total, "{mode:?}: every picture block belongs to one panel");
        }

        let parts = build_panels(&grid, &c, BuildMode::Continued);
        let union = placed_union(&parts, mw);
        let seam = |z: i32| z % 128 == 0 && z > 0;
        let a: Vec<_> = union.iter().filter(|b| !seam(b.2)).copied().collect();
        let mut e: Vec<_> = joined.blocks.iter().filter(|b| !seam(b.2)).copied().collect();
        e.sort_unstable();
        assert_eq!(a, e, "continued panels cover the joined build off-seam");
    }

    #[test]
    fn one_panel_is_the_joined_build_in_every_mode() {
        let d = data();
        let cells: Vec<Option<(u8, Tone)>> = (0..128 * 128)
            .map(|i| Some((8u8, if i % 2 == 0 { Tone::Dark } else { Tone::Light })))
            .collect();
        let grid = Grid {
            width: 128,
            height: 128,
            cells,
        };
        let c = cfg(
            &d,
            HeightMode::Stepped { cliff_cap: None },
            SupportMode::Important,
        );
        let joined = build_schem(&grid, &c);
        for mode in [BuildMode::OnePiece, BuildMode::Panels, BuildMode::Continued] {
            let parts = build_panels(&grid, &c, mode);
            assert_eq!(parts.len(), 1);
            let mut a = parts[0].blocks.clone();
            let mut e = joined.blocks.clone();
            a.sort_unstable();
            e.sort_unstable();
            assert_eq!(a, e, "{mode:?}");
            assert_eq!(parts[0].materials, joined.materials);
            assert_eq!(parts[0].support_count, joined.support_count);
        }
    }

    #[test]
    fn fully_transparent_column_is_empty() {
        let (d, _) = setup();
        let grid = Grid {
            width: 2,
            height: 1,
            cells: vec![None, Some((8u8, Tone::Normal))],
        };
        let c = cfg(&d, HeightMode::Flat, SupportMode::None);
        let s = build_schem(&grid, &c);
        assert!(s.blocks.iter().all(|b| b.0 == 1), "x=0 places nothing");
        assert_eq!(s.support_count, 1);
    }

    #[test]
    fn missing_selection_is_reported_not_panicked() {
        let (d, grid) = setup();
        let mut c = cfg(&d, HeightMode::Flat, SupportMode::None);
        assert!(missing_selection(&grid, &c).is_empty());
        c.selection.remove(&29);
        assert_eq!(missing_selection(&grid, &c), vec![29]);
        let sparse = Grid {
            width: 2,
            height: 2,
            cells: vec![Some((8u8, Tone::Normal)), None, None, None],
        };
        c.selection.remove(&8);
        assert_eq!(missing_selection(&sparse, &c), vec![8]);
    }

    #[test]
    fn cliff_cap_zero_behaves_as_one() {
        let (d, grid) = setup();
        let zero = build_schem(
            &grid,
            &cfg(
                &d,
                HeightMode::Stepped { cliff_cap: Some(0) },
                SupportMode::None,
            ),
        );
        let one = build_schem(
            &grid,
            &cfg(
                &d,
                HeightMode::Stepped { cliff_cap: Some(1) },
                SupportMode::None,
            ),
        );
        assert_eq!(
            zero.blocks, one.blocks,
            "cap 0 must not panic or differ from cap 1"
        );
    }

    #[test]
    fn nbt_round_trips_and_has_expected_shape() {
        let (d, grid) = setup();
        let c = cfg(&d, HeightMode::Flat, SupportMode::None);
        let s = build_schem(&grid, &c);
        let tag = schem_to_nbt(&s, &c);
        let bytes = crate::nbt::write_root("", &tag);
        let (_, parsed) = crate::nbt::read_root(&bytes).unwrap();
        assert_eq!(parsed, tag);
        let Some(Tag::List(_, palette)) = parsed.get("palette") else {
            panic!("palette missing")
        };
        assert_eq!(palette.len(), 3);
        assert_eq!(
            parsed.get("DataVersion"),
            Some(&Tag::Int(d.meta.data_version))
        );
    }
}
