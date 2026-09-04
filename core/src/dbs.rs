use crate::color::{linear_to_oklab, oklab_dist2};
use crate::image::LinImage;
use crate::metric::{Viewing, opponent_kernels, opponent_of};
use crate::palette::Palette;
use crate::quantize::{Grid, edge_forced};

#[derive(Debug, Clone, Copy)]
pub struct DbsConfig {
    pub view: Viewing,
    pub candidates: usize,
    pub max_passes: usize,
    pub filter_radius: usize,
    pub channel_weights: [f32; 3],
}

pub const LAB_CHANNEL_WEIGHTS: [f32; 3] = [0.017_7, 1.0, 0.107_6];

impl Default for DbsConfig {
    fn default() -> Self {
        Self {
            view: Viewing::framed(5.0),
            candidates: 8,
            max_passes: 8,
            filter_radius: 12,
            channel_weights: LAB_CHANNEL_WEIGHTS,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DbsReport {
    pub passes: usize,
    pub swaps: usize,
    pub start_cost: f64,
    pub end_cost: f64,
}

fn autocorr(k: &[f32]) -> Vec<f32> {
    let n = k.len() as isize;
    let r = n - 1;
    let mut out = vec![0.0f32; (2 * r + 1) as usize];
    for i in 0..n {
        for j in 0..n {
            out[(r + i - j) as usize] += k[i as usize] * k[j as usize];
        }
    }
    out
}

fn convolve_zero(plane: &[f32], w: usize, h: usize, k: &[f32]) -> Vec<f32> {
    let r = (k.len() / 2) as isize;
    let mut mid = vec![0.0f32; w * h];
    for z in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (i, &kv) in k.iter().enumerate() {
                let sx = x as isize + i as isize - r;
                if sx >= 0 && (sx as usize) < w {
                    acc += kv * plane[z * w + sx as usize];
                }
            }
            mid[z * w + x] = acc;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for z in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (i, &kv) in k.iter().enumerate() {
                let sz = z as isize + i as isize - r;
                if sz >= 0 && (sz as usize) < h {
                    acc += kv * mid[sz as usize * w + x];
                }
            }
            out[z * w + x] = acc;
        }
    }
    out
}

fn shortlist(target: [f32; 3], palette: &Palette, k: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..palette.entries.len()).collect();
    if k >= idx.len() {
        return idx;
    }
    idx.select_nth_unstable_by(k, |a, b| {
        oklab_dist2(palette.entries[*a].oklab, target)
            .partial_cmp(&oklab_dist2(palette.entries[*b].oklab, target))
            .expect("finite distances")
    });
    idx.truncate(k);
    idx
}

pub fn refine(
    img: &LinImage,
    palette: &Palette,
    edge: Option<&Palette>,
    start: &Grid,
    cfg: &DbsConfig,
) -> (Grid, DbsReport) {
    refine_with_progress(img, palette, edge, start, cfg, &mut |_| {})
}

pub fn refine_with_progress(
    img: &LinImage,
    palette: &Palette,
    edge: Option<&Palette>,
    start: &Grid,
    cfg: &DbsConfig,
    progress: &mut dyn FnMut(f32),
) -> (Grid, DbsReport) {
    let (w, h) = (img.width, img.height);
    assert_eq!((start.width, start.height), (w, h), "grid matches image");

    let mut entries = palette.entries.clone();
    if let Some(e) = edge {
        entries.extend(e.entries.iter().copied());
    }
    let frozen: Vec<bool> = (0..w * h)
        .map(|i| edge.is_some() && edge_forced(&start.cells, w, i))
        .collect();

    let kernels = opponent_kernels(cfg.view, cfg.filter_radius);
    let cff: Vec<Vec<f32>> = kernels.iter().map(|k| autocorr(k)).collect();
    let cff0: Vec<f32> = cff.iter().map(|c| c[c.len() / 2].powi(2)).collect();
    let crs: Vec<isize> = cff.iter().map(|c| (c.len() / 2) as isize).collect();

    let entry_opp: Vec<[f32; 3]> = entries.iter().map(|e| opponent_of(e.linear)).collect();

    let mut assign: Vec<Option<usize>> = Vec::with_capacity(w * h);
    for cell in &start.cells {
        assign.push(cell.and_then(|(cid, tone)| {
            entries
                .iter()
                .position(|e| e.color_id == cid && e.tone == tone)
        }));
    }

    let src_opp: Vec<[f32; 3]> = img
        .pixels
        .iter()
        .map(|p| opponent_of([p[0], p[1], p[2]]))
        .collect();

    let mut err = [
        vec![0.0f32; w * h],
        vec![0.0f32; w * h],
        vec![0.0f32; w * h],
    ];
    for (i, a) in assign.iter().enumerate() {
        let Some(idx) = a else { continue };
        for c in 0..3 {
            err[c][i] = entry_opp[*idx][c] - src_opp[i][c];
        }
    }

    let mut ce: Vec<Vec<f32>> = (0..3)
        .map(|c| convolve_zero(&err[c], w, h, &cff[c]))
        .collect();

    let wts = cfg.channel_weights;
    let cost = |ce: &[Vec<f32>], err: &[Vec<f32>]| -> f64 {
        let mut t = 0.0f64;
        for c in 0..3 {
            let mut ct = 0.0f64;
            for i in 0..w * h {
                ct += f64::from(err[c][i]) * f64::from(ce[c][i]);
            }
            t += f64::from(wts[c]) * ct;
        }
        t
    };
    let start_cost = cost(&ce, &err);

    let candidates: Vec<Vec<usize>> = (0..w * h)
        .map(|i| {
            if frozen[i] {
                return Vec::new();
            }
            let lab = linear_to_oklab({
                let p = img.pixels[i];
                [p[0], p[1], p[2]]
            });
            shortlist(lab, palette, cfg.candidates)
        })
        .collect();

    let mut swaps = 0usize;
    let mut passes = 0usize;
    for pass in 0..cfg.max_passes {
        passes += 1;
        progress(pass as f32 / cfg.max_passes as f32);
        let mut changed = 0usize;
        for p in 0..w * h {
            let Some(current) = assign[p] else { continue };
            if frozen[p] {
                continue;
            }
            let mut best: Option<(usize, f32, [f32; 3])> = None;
            for &cand in &candidates[p] {
                if cand == current {
                    continue;
                }
                let mut d = [0.0f32; 3];
                let mut delta = 0.0f32;
                for c in 0..3 {
                    d[c] = entry_opp[cand][c] - entry_opp[current][c];
                    delta += wts[c] * (2.0 * d[c] * ce[c][p] + d[c] * d[c] * cff0[c]);
                }
                if delta < best.map_or(-1e-9, |b| b.1) {
                    best = Some((cand, delta, d));
                }
            }
            let Some((cand, _, d)) = best else { continue };
            assign[p] = Some(cand);
            changed += 1;
            let (px, pz) = ((p % w) as isize, (p / w) as isize);
            for c in 0..3 {
                err[c][p] += d[c];
                if d[c] == 0.0 {
                    continue;
                }
                let cr = crs[c];
                let lo_z = (pz - cr).max(0);
                let hi_z = (pz + cr).min(h as isize - 1);
                let lo_x = (px - cr).max(0);
                let hi_x = (px + cr).min(w as isize - 1);
                for qz in lo_z..=hi_z {
                    let ky = cff[c][(cr + qz - pz) as usize];
                    if ky == 0.0 {
                        continue;
                    }
                    let row = qz as usize * w;
                    for qx in lo_x..=hi_x {
                        ce[c][row + qx as usize] += d[c] * ky * cff[c][(cr + qx - px) as usize];
                    }
                }
            }
        }
        swaps += changed;
        if changed == 0 {
            break;
        }
    }

    progress(1.0);
    let end_cost = cost(&ce, &err);
    let cells = assign
        .iter()
        .map(|a| a.map(|i| (entries[i].color_id, entries[i].tone)))
        .collect();
    (
        Grid {
            width: w,
            height: h,
            cells,
        },
        DbsReport {
            passes,
            swaps,
            start_cost,
            end_cost,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::BlockData;
    use crate::palette::Tone;
    use crate::quantize::{Dither, FLOYD_STEINBERG, quantize};

    fn setup() -> (BlockData, Palette) {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = BlockData::from_json(&json).unwrap();
        let ids: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let p = Palette::build(&d, &ids, &[Tone::Dark, Tone::Normal, Tone::Light]);
        (d, p)
    }

    fn ramp(side: usize) -> LinImage {
        let mut data = Vec::new();
        for z in 0..side {
            let v = (255 - z * 120 / (side - 1)) as u8;
            for x in 0..side {
                let u = (v as usize + x * 40 / side).min(255) as u8;
                data.extend_from_slice(&[u, v, 255 - v / 2, 255]);
            }
        }
        LinImage::from_srgb_rgba(side, side, &data)
    }

    fn ramp_with_a_hole(side: usize) -> LinImage {
        let mut data = Vec::new();
        for z in 0..side {
            let v = (255 - z * 120 / (side - 1)) as u8;
            for x in 0..side {
                let u = (v as usize + x * 40 / side).min(255) as u8;
                let clear = (side / 3..side / 3 + 3).contains(&z) && x % 7 != 0;
                data.extend_from_slice(&[u, v, 255 - v / 2, if clear { 0 } else { 255 }]);
            }
        }
        LinImage::from_srgb_rgba(side, side, &data)
    }

    #[test]
    fn refinement_leaves_forced_light_edges_alone() {
        let (d, p) = setup();
        let ids: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let edge = Palette::build(&d, &ids, &[Tone::Light]);
        let img = ramp_with_a_hole(48);
        let start = quantize(
            &img,
            &p,
            &Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
            Some(crate::quantize::Transparency {
                threshold: 0.5,
                edge: &edge,
            }),
        );
        let w = start.width;
        let edges: Vec<usize> = (0..start.cells.len())
            .filter(|&i| edge_forced(&start.cells, w, i))
            .collect();
        assert!(!edges.is_empty(), "fixture must produce forced edges");
        assert!(
            edges
                .iter()
                .all(|&i| start.cells[i].unwrap().1 == Tone::Light),
            "quantize should have forced them light"
        );

        let (g, r) = refine(&img, &p, Some(&edge), &start, &DbsConfig::default());
        assert!(r.swaps > 0, "refinement must have done something");
        for &i in &edges {
            assert_eq!(g.cells[i], start.cells[i], "edge cell {i} was refined away");
        }
        assert_eq!(
            g.cells.iter().filter(|c| c.is_none()).count(),
            start.cells.iter().filter(|c| c.is_none()).count(),
            "transparency must survive refinement"
        );

        let (loose, _) = refine(&img, &p, None, &start, &DbsConfig::default());
        assert!(
            edges.iter().any(|&i| loose.cells[i] != start.cells[i]),
            "without the edge palette DBS would move an edge cell, so the guard is load bearing"
        );
    }

    #[test]
    fn refinement_never_increases_its_own_cost() {
        let (_d, p) = setup();
        let img = ramp(48);
        let start = quantize(
            &img,
            &p,
            &Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
            None,
        );
        let (_g, r) = refine(&img, &p, None, &start, &DbsConfig::default());
        assert!(
            r.end_cost <= r.start_cost,
            "cost rose: {} -> {}",
            r.start_cost,
            r.end_cost
        );
    }

    #[test]
    fn incremental_cost_matches_a_full_recompute() {
        let (_d, p) = setup();
        let img = ramp(32);
        let start = quantize(&img, &p, &Dither::None, None);
        let cfg = DbsConfig {
            max_passes: 2,
            ..DbsConfig::default()
        };
        let (g, r) = refine(&img, &p, None, &start, &cfg);

        let (w, h) = (img.width, img.height);
        let kernels = opponent_kernels(cfg.view, cfg.filter_radius);
        let cff: Vec<Vec<f32>> = kernels.iter().map(|k| autocorr(k)).collect();
        let mut err = [
            vec![0.0f32; w * h],
            vec![0.0f32; w * h],
            vec![0.0f32; w * h],
        ];
        for (i, cell) in g.cells.iter().enumerate() {
            let Some((cid, tone)) = cell else { continue };
            let e = p
                .entries
                .iter()
                .find(|e| e.color_id == *cid && e.tone == *tone)
                .unwrap();
            let o = opponent_of(e.linear);
            let s = opponent_of({
                let q = img.pixels[i];
                [q[0], q[1], q[2]]
            });
            for c in 0..3 {
                err[c][i] = o[c] - s[c];
            }
        }
        let mut fresh = 0.0f64;
        for c in 0..3 {
            let ce = convolve_zero(&err[c], w, h, &cff[c]);
            let mut ct = 0.0f64;
            for i in 0..w * h {
                ct += f64::from(err[c][i]) * f64::from(ce[i]);
            }
            fresh += f64::from(cfg.channel_weights[c]) * ct;
        }
        let drift = (fresh - r.end_cost).abs() / fresh.abs().max(1e-9);
        assert!(drift < 1e-3, "incremental {} vs fresh {fresh}", r.end_cost);
    }

    #[test]
    fn exact_palette_colors_survive_refinement() {
        let (_d, p) = setup();
        let side = 32;
        let mut data = Vec::new();
        for z in 0..side {
            for x in 0..side {
                let e = p.entries[(z / 4 * 8 + x / 4) % p.entries.len()].srgb;
                data.extend_from_slice(&[e[0], e[1], e[2], 255]);
            }
        }
        let img = LinImage::from_srgb_rgba(side, side, &data);
        let start = quantize(&img, &p, &Dither::None, None);
        let (g, _r) = refine(&img, &p, None, &start, &DbsConfig::default());
        assert_eq!(g.cells, start.cells, "DBS disturbed an exact rendering");
    }
}
