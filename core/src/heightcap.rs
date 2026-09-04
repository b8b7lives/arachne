use crate::color::{OkLab, linear_to_oklab, oklab_dist2, srgb_to_linear};
use crate::data::BlockData;
use crate::palette::Tone;
use crate::quantize::Grid;
use crate::staircase::{HeightMode, capped_heights, column_heights};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CapReport {
    pub edited_cells: u32,
    pub edited_columns: u32,
    pub infeasible_columns: u32,
}

const CLASSES: [Tone; 3] = [Tone::Dark, Tone::Normal, Tone::Light];

fn class_index(t: Tone) -> usize {
    match t {
        Tone::Dark => 0,
        Tone::Light => 2,
        _ => 1,
    }
}

fn tone_oklabs(data: &BlockData, cid: u8, cache: &mut HashMap<u8, [OkLab; 3]>) -> [OkLab; 3] {
    *cache.entry(cid).or_insert_with(|| {
        let c = data.color(cid).expect("grid colors exist in data");
        [c.tones.dark, c.tones.normal, c.tones.light]
            .map(|srgb| linear_to_oklab(srgb_to_linear(srgb)))
    })
}

pub fn natural_peak(grid: &Grid, cliff_cap: Option<u32>) -> u32 {
    let (w, h) = (grid.width, grid.height);
    let mut peak = 0i32;
    for x in 0..w {
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
            let skip = usize::from(z0 != 0);
            let tones: Vec<Tone> = (z0 + skip..z1)
                .map(|z| grid.cell(x, z).unwrap().1)
                .collect();
            if !tones.is_empty() {
                let heights = column_heights(&tones, HeightMode::Stepped { cliff_cap });
                peak = peak.max(*heights.iter().max().unwrap());
            }
            z0 = z1;
        }
    }
    peak as u32
}

pub fn apply_height_cap(
    grid: &Grid,
    data: &BlockData,
    allowed_tones: &[Tone],
    cliff_cap: Option<u32>,
    max_height: u32,
) -> (Grid, CapReport) {
    let (w, h) = (grid.width, grid.height);
    let mut out = grid.clone();
    let mut report = CapReport::default();
    let mut cache: HashMap<u8, [OkLab; 3]> = HashMap::new();
    let allowed = |t: Tone| allowed_tones.contains(&t);

    for x in 0..w {
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
            let anchored = z0 == 0;
            let skip = usize::from(!anchored);
            let tones: Vec<Tone> = run.iter().skip(skip).map(|c| c.1).collect();
            if tones.is_empty() {
                z0 = z1;
                continue;
            }
            let greedy = column_heights(&tones, HeightMode::Stepped { cliff_cap });
            if *greedy.iter().max().unwrap() as u32 <= max_height {
                z0 = z1;
                continue;
            }
            let costs: Vec<[Option<f32>; 3]> = run
                .iter()
                .skip(skip)
                .map(|(cid, t0)| {
                    let mut row = [None, None, None];
                    if *t0 == Tone::Unobtainable {
                        row[1] = Some(0.0);
                        return row;
                    }
                    let labs = tone_oklabs(data, *cid, &mut cache);
                    let own = class_index(*t0);
                    for (i, class) in CLASSES.iter().enumerate() {
                        if i == own {
                            row[i] = Some(0.0);
                        } else if allowed(*class) {
                            row[i] = Some(oklab_dist2(labs[i], labs[own]));
                        }
                    }
                    row
                })
                .collect();
            match capped_heights(&costs, cliff_cap, max_height) {
                None => report.infeasible_columns += 1,
                Some((_, classes, _)) => {
                    let mut edits = 0u32;
                    for (i, class) in classes.iter().enumerate() {
                        let z = z0 + skip + i;
                        let (cid, t0) = grid.cell(x, z).unwrap();
                        if t0 != Tone::Unobtainable && class_index(t0) != class_index(*class) {
                            out.cells[z * w + x] = Some((cid, *class));
                            edits += 1;
                        }
                    }
                    if edits > 0 {
                        report.edited_cells += edits;
                        report.edited_columns += 1;
                    }
                }
            }
            z0 = z1;
        }
    }
    (out, report)
}

// Panels mode (minecraft#59): each 128x128 window is built on its own
// noobline, so its peak and its cap are its own. A window's row 0 is
// anchored here exactly as build_schem anchors it, which lets the cap
// recolor a forced-light edge cell; the result only shades right when
// built in Panels mode. Callers re-run the cap from the base grid on
// every mode change.
pub fn natural_peak_panels(grid: &Grid, cliff_cap: Option<u32>) -> u32 {
    grid.panel_windows()
        .into_iter()
        .map(|(x0, z0)| natural_peak(&grid.window(x0, z0, 128, 128), cliff_cap))
        .max()
        .unwrap_or(0)
}

pub fn apply_height_cap_panels(
    grid: &Grid,
    data: &BlockData,
    allowed_tones: &[Tone],
    cliff_cap: Option<u32>,
    max_height: u32,
) -> (Grid, CapReport) {
    let mut out = grid.clone();
    let mut report = CapReport::default();
    for (x0, z0) in grid.panel_windows() {
        let win = grid.window(x0, z0, 128, 128);
        if natural_peak(&win, cliff_cap) <= max_height {
            continue;
        }
        let (capped, r) = apply_height_cap(&win, data, allowed_tones, cliff_cap, max_height);
        for z in 0..win.height {
            for x in 0..win.width {
                out.cells[(z0 + z) * grid.width + x0 + x] = capped.cells[z * win.width + x];
            }
        }
        report.edited_cells += r.edited_cells;
        report.edited_columns += r.edited_columns;
        report.infeasible_columns += r.infeasible_columns;
    }
    (out, report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    const ALL: [Tone; 3] = [Tone::Dark, Tone::Normal, Tone::Light];

    fn column_grid(tones: &[Tone]) -> Grid {
        Grid {
            width: 1,
            height: tones.len(),
            cells: tones.iter().map(|t| Some((8u8, *t))).collect(),
        }
    }

    fn peak(grid: &Grid, cliff_cap: Option<u32>) -> i32 {
        let tones: Vec<Tone> = grid.cells.iter().flatten().map(|c| c.1).collect();
        *column_heights(&tones, HeightMode::Stepped { cliff_cap })
            .iter()
            .max()
            .unwrap()
    }

    #[test]
    fn a_fitting_grid_is_untouched() {
        let g = column_grid(&[Tone::Light, Tone::Dark, Tone::Normal]);
        let (out, report) = apply_height_cap(&g, &data(), &ALL, None, 4);
        assert_eq!(out.cells, g.cells);
        assert_eq!(report, CapReport::default());
    }

    #[test]
    fn a_tall_ascent_is_cut_to_fit_and_keeps_its_colors() {
        let g = column_grid(&[Tone::Light; 9]);
        let d = data();
        assert_eq!(peak(&g, None), 9);
        let (out, report) = apply_height_cap(&g, &d, &ALL, None, 3);
        assert!(peak(&out, None) <= 3, "greedy on edited tones fits the cap");
        assert!(report.edited_cells > 0);
        assert_eq!(report.edited_columns, 1);
        assert_eq!(report.infeasible_columns, 0);
        for (a, b) in out.cells.iter().zip(g.cells.iter()) {
            assert_eq!(a.unwrap().0, b.unwrap().0, "the cap never changes colors");
        }
    }

    #[test]
    fn restricted_tones_can_make_a_column_infeasible() {
        let g = column_grid(&[Tone::Light; 6]);
        let d = data();
        let (out, report) = apply_height_cap(&g, &d, &[Tone::Light], None, 2);
        assert_eq!(report.infeasible_columns, 1);
        assert_eq!(report.edited_cells, 0);
        assert_eq!(out.cells, g.cells, "infeasible columns are left alone");
    }

    #[test]
    fn transparency_splits_runs_and_frees_the_second_start() {
        let mut cells: Vec<Option<(u8, Tone)>> = vec![Some((8, Tone::Light)); 12];
        cells[5] = None;
        let g = Grid {
            width: 1,
            height: 12,
            cells,
        };
        let d = data();
        let (out, report) = apply_height_cap(&g, &d, &ALL, None, 3);
        assert!(report.edited_cells > 0);
        assert_eq!(
            out.cells[5], None,
            "transparency survives the cap untouched"
        );
        let first: Vec<Tone> = (0..5).map(|z| out.cell(0, z).unwrap().1).collect();
        assert!(
            *column_heights(&first, HeightMode::Stepped { cliff_cap: None })
                .iter()
                .max()
                .unwrap()
                <= 3
        );
    }

    #[test]
    fn unobtainable_cells_are_never_edited() {
        let g = Grid {
            width: 1,
            height: 8,
            cells: (0..8)
                .map(|i| {
                    Some((
                        8u8,
                        if i == 3 {
                            Tone::Unobtainable
                        } else {
                            Tone::Light
                        },
                    ))
                })
                .collect(),
        };
        let (out, _) = apply_height_cap(&g, &data(), &ALL, None, 2);
        assert_eq!(out.cell(0, 3), Some((8, Tone::Unobtainable)));
    }

    #[test]
    fn the_cap_composes_with_the_cliff_cap() {
        let g = column_grid(&[Tone::Light; 10]);
        let d = data();
        let (out, report) = apply_height_cap(&g, &d, &ALL, Some(1), 4);
        assert!(peak(&out, Some(1)) <= 4);
        assert!(report.edited_cells > 0);
    }

    fn two_panel_column(top: &[Tone], bottom: &[Tone]) -> Grid {
        let mut cells: Vec<Option<(u8, Tone)>> = Vec::with_capacity(256);
        for z in 0..128 {
            cells.push(Some((8u8, top[z % top.len()])));
        }
        for z in 0..128 {
            cells.push(Some((8u8, bottom[z % bottom.len()])));
        }
        Grid {
            width: 1,
            height: 256,
            cells,
        }
    }

    #[test]
    fn panel_peak_is_the_tallest_panel_not_the_whole_column() {
        let dark64 = [[Tone::Dark; 64].as_slice(), [Tone::Normal; 64].as_slice()].concat();
        let grid = two_panel_column(&dark64, &dark64);
        assert_eq!(natural_peak(&grid, None), 128);
        assert_eq!(natural_peak_panels(&grid, None), 64);
    }

    #[test]
    fn panel_cap_leaves_panels_that_already_fit_alone() {
        let d = data();
        let dark64 = [[Tone::Dark; 64].as_slice(), [Tone::Normal; 64].as_slice()].concat();
        let grid = two_panel_column(&dark64, &dark64);
        let (same, r) = apply_height_cap_panels(&grid, &d, &ALL, None, 100);
        assert_eq!(
            r.edited_cells, 0,
            "each panel is 64 tall, nothing to recolor"
        );
        assert_eq!(same.cells, grid.cells);
        let (_, global) = apply_height_cap(&grid, &d, &ALL, None, 100);
        assert!(
            global.edited_cells > 0,
            "the one-piece cap would have recolored"
        );

        let (capped, r) = apply_height_cap_panels(&grid, &d, &ALL, None, 10);
        assert!(r.edited_cells > 0);
        assert!(natural_peak_panels(&capped, None) <= 10);
        let untouched = capped.cells[64..128] == grid.cells[64..128]
            && capped.cells[192..256] == grid.cells[192..256];
        assert!(untouched, "rows that were already flat stay as they were");
    }
}
