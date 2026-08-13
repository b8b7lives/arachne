use crate::color::{OkLab, linear_to_oklab, oklab_dist2};
use crate::image::LinImage;
use crate::palette::{Palette, Tone};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Grid {
    pub width: usize,
    pub height: usize,
    pub cells: Vec<Option<(u8, Tone)>>,
}

impl Grid {
    pub fn cell(&self, x: usize, z: usize) -> Option<(u8, Tone)> {
        self.cells[z * self.width + x]
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Kernel {
    pub rows: [[f32; 5]; 3],
    pub divisor: f32,
}

pub const FLOYD_STEINBERG: Kernel = Kernel {
    rows: [[0., 0., 0., 7., 0.], [0., 3., 5., 1., 0.], [0.; 5]],
    divisor: 16.,
};
pub const MIN_AVG_ERR: Kernel = Kernel {
    rows: [
        [0., 0., 0., 7., 5.],
        [3., 5., 7., 5., 3.],
        [1., 3., 5., 3., 1.],
    ],
    divisor: 48.,
};
pub const BURKES: Kernel = Kernel {
    rows: [[0., 0., 0., 8., 4.], [2., 4., 8., 4., 2.], [0.; 5]],
    divisor: 32.,
};
pub const SIERRA_LITE: Kernel = Kernel {
    rows: [[0., 0., 0., 2., 0.], [0., 1., 1., 0., 0.], [0.; 5]],
    divisor: 4.,
};
pub const STUCKI: Kernel = Kernel {
    rows: [
        [0., 0., 0., 8., 4.],
        [2., 4., 8., 4., 2.],
        [1., 2., 4., 2., 1.],
    ],
    divisor: 42.,
};
pub const ATKINSON: Kernel = Kernel {
    rows: [
        [0., 0., 0., 1., 1.],
        [0., 1., 1., 1., 0.],
        [0., 0., 1., 0., 0.],
    ],
    divisor: 8.,
};

#[derive(Debug, Clone)]
pub struct OrderedMatrix {
    pub w: usize,
    pub h: usize,
    pub thresholds: Vec<f32>,
}

pub fn bayer2() -> OrderedMatrix {
    OrderedMatrix {
        w: 2,
        h: 2,
        thresholds: vec![1., 3., 4., 2.],
    }
}
pub fn bayer4() -> OrderedMatrix {
    OrderedMatrix {
        w: 4,
        h: 4,
        thresholds: vec![
            1., 9., 3., 11., 13., 5., 15., 7., 4., 12., 2., 10., 16., 8., 14., 6.,
        ],
    }
}
pub fn ordered3() -> OrderedMatrix {
    OrderedMatrix {
        w: 3,
        h: 3,
        thresholds: vec![1., 7., 4., 5., 8., 3., 6., 2., 9.],
    }
}

pub const YLILUOMA_CANDIDATES: usize = 48;

#[derive(Debug, Clone)]
pub enum Dither {
    None,
    Ordered(OrderedMatrix),
    Yliluoma { matrix: OrderedMatrix, candidates: usize },
    Diffusion { kernel: Kernel, serpentine: bool },
}

fn shortlist(target: OkLab, palette: &Palette, k: usize) -> Vec<usize> {
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

fn mixing_plan(target: OkLab, palette: &Palette, n: usize, k: usize) -> Vec<usize> {
    let candidates = shortlist(target, palette, k);
    let mut plan: Vec<usize> = Vec::with_capacity(n);
    let mut acc = [0.0f32; 3];
    for i in 0..n {
        let count = (i + 1) as f32;
        let mut best = candidates[0];
        let mut best_d = f32::INFINITY;
        for &idx in &candidates {
            let e = &palette.entries[idx];
            let avg = [
                (acc[0] + e.linear[0]) / count,
                (acc[1] + e.linear[1]) / count,
                (acc[2] + e.linear[2]) / count,
            ];
            let d = oklab_dist2(linear_to_oklab(avg), target);
            if d < best_d {
                best_d = d;
                best = idx;
            }
        }
        plan.push(best);
        let chosen = palette.entries[best].linear;
        for (a, c) in acc.iter_mut().zip(chosen.iter()) {
            *a += c;
        }
    }
    plan.sort_by(|a, b| {
        palette.entries[*a].oklab[0]
            .partial_cmp(&palette.entries[*b].oklab[0])
            .expect("finite lightness")
    });
    plan
}

const DRIFT_LIMIT: f32 = 0.2;

#[derive(Debug, Clone, Copy)]
pub struct Transparency<'a> {
    pub threshold: f32,
    pub edge: &'a Palette,
}

pub fn edge_forced(cells: &[Option<(u8, Tone)>], w: usize, i: usize) -> bool {
    cells[i].is_some() && i >= w && cells[i - w].is_none()
}

pub fn quantize(
    img: &LinImage,
    palette: &Palette,
    dither: &Dither,
    transparency: Option<Transparency>,
) -> Grid {
    quantize_with_progress(img, palette, dither, transparency, &mut |_| {})
}

pub fn quantize_with_progress(
    img: &LinImage,
    palette: &Palette,
    dither: &Dither,
    transparency: Option<Transparency>,
    progress: &mut dyn FnMut(f32),
) -> Grid {
    let (w, h) = (img.width, img.height);
    let step = (h / 50).max(1);
    let mut cells = vec![None; w * h];
    let transparent_at = |p: [f32; 4]| transparency.is_some_and(|t| p[3] < t.threshold);
    let forced_at = |x: usize, z: usize| z > 0 && transparent_at(img.pixel(x, z - 1));
    let pal = |x: usize, z: usize| match transparency {
        Some(t) if forced_at(x, z) => t.edge,
        _ => palette,
    };

    match dither {
        Dither::None => {
            for z in 0..h {
                for x in 0..w {
                    let p = img.pixel(x, z);
                    if transparent_at(p) {
                        continue;
                    }
                    let e = pal(x, z).nearest([p[0], p[1], p[2]]);
                    cells[z * w + x] = Some((e.color_id, e.tone));
                }
                if z % step == 0 {
                    progress((z + 1) as f32 / h as f32);
                }
            }
        }
        Dither::Ordered(m) => {
            let n = (m.w * m.h) as f32;
            for z in 0..h {
                for x in 0..w {
                    let p = img.pixel(x, z);
                    if transparent_at(p) {
                        continue;
                    }
                    let lab = linear_to_oklab([p[0], p[1], p[2]]);
                    let ((best, _), (second, _)) = pal(x, z).nearest2([p[0], p[1], p[2]]);
                    let sb = [0, 1, 2].map(|i| second.oklab[i] - best.oklab[i]);
                    let tb = [0, 1, 2].map(|i| lab[i] - best.oklab[i]);
                    let len2 = sb.iter().map(|v| v * v).sum::<f32>();
                    let t = if len2 > 0.0 {
                        (sb.iter().zip(tb.iter()).map(|(a, b)| a * b).sum::<f32>() / len2)
                            .clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let e = if t * (n + 1.0) > m.thresholds[(z % m.h) * m.w + (x % m.w)] {
                        second
                    } else {
                        best
                    };
                    cells[z * w + x] = Some((e.color_id, e.tone));
                }
                if z % step == 0 {
                    progress((z + 1) as f32 / h as f32);
                }
            }
        }
        Dither::Yliluoma {
            matrix: m,
            candidates,
        } => {
            let n = m.w * m.h;
            let mut cache: HashMap<[u16; 3], Vec<usize>> = HashMap::new();
            let mut edge_cache: HashMap<[u16; 3], Vec<usize>> = HashMap::new();
            for z in 0..h {
                for x in 0..w {
                    let p = img.pixel(x, z);
                    if transparent_at(p) {
                        continue;
                    }
                    let lin = [p[0], p[1], p[2]];
                    let key = lin.map(|c| (c.clamp(0.0, 1.0) * 16383.0).round() as u16);
                    let q = pal(x, z);
                    let store = if forced_at(x, z) {
                        &mut edge_cache
                    } else {
                        &mut cache
                    };
                    let plan = store
                        .entry(key)
                        .or_insert_with(|| mixing_plan(linear_to_oklab(lin), q, n, *candidates));
                    let slot = m.thresholds[(z % m.h) * m.w + (x % m.w)] as usize - 1;
                    let e = &q.entries[plan[slot.min(n - 1)]];
                    cells[z * w + x] = Some((e.color_id, e.tone));
                }
                if z % step == 0 {
                    progress((z + 1) as f32 / h as f32);
                }
            }
        }
        Dither::Diffusion { kernel, serpentine } => {
            let mut buf: Vec<[f32; 3]> = img.pixels.iter().map(|p| [p[0], p[1], p[2]]).collect();
            for z in 0..h {
                let reverse = *serpentine && z % 2 == 1;
                let xs: Box<dyn Iterator<Item = usize>> = if reverse {
                    Box::new((0..w).rev())
                } else {
                    Box::new(0..w)
                };
                for x in xs {
                    let a = img.pixel(x, z)[3];
                    if transparent_at([0.0, 0.0, 0.0, a]) {
                        continue;
                    }
                    let old = buf[z * w + x];
                    let src = img.pixel(x, z);
                    let clamped = [0, 1, 2].map(|i| {
                        (src[i] + (old[i] - src[i]).clamp(-DRIFT_LIMIT, DRIFT_LIMIT))
                            .clamp(0.0, 1.0)
                    });
                    let e = pal(x, z).nearest(clamped);
                    cells[z * w + x] = Some((e.color_id, e.tone));
                    let err = [
                        clamped[0] - e.linear[0],
                        clamped[1] - e.linear[1],
                        clamped[2] - e.linear[2],
                    ];
                    for (dz, row) in kernel.rows.iter().enumerate() {
                        for (ci, &wgt) in row.iter().enumerate() {
                            if wgt == 0.0 {
                                continue;
                            }
                            let mut dx = ci as isize - 2;
                            if reverse {
                                dx = -dx;
                            }
                            let nx = x as isize + dx;
                            let nz = z + dz;
                            if nz >= h || nx < 0 || nx as usize >= w {
                                continue;
                            }
                            let t = &mut buf[nz * w + nx as usize];
                            for (tc, ec) in t.iter_mut().zip(err.iter()) {
                                *tc += ec * wgt / kernel.divisor;
                            }
                        }
                    }
                }
                if z % step == 0 {
                    progress((z + 1) as f32 / h as f32);
                }
            }
        }
    }
    Grid {
        width: w,
        height: h,
        cells,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::BlockData;
    use crate::palette::Palette;

    fn small_palette() -> (BlockData, Palette) {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = BlockData::from_json(&json).unwrap();
        let p = Palette::build(&d, &[8, 29], &[Tone::Dark, Tone::Normal, Tone::Light]);
        (d, p)
    }

    fn flat_image(w: usize, h: usize, rgba: [u8; 4]) -> LinImage {
        let data: Vec<u8> = std::iter::repeat_n(rgba, w * h).flatten().collect();
        LinImage::from_srgb_rgba(w, h, &data)
    }

    #[test]
    fn diffusion_keeps_a_neutral_ramp_neutral() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = BlockData::from_json(&json).unwrap();
        let ids: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let p = Palette::build(&d, &ids, &[Tone::Dark, Tone::Normal, Tone::Light]);

        let (w, h) = (128usize, 128usize);
        let mut data = Vec::with_capacity(w * h * 4);
        for z in 0..h {
            let v = 255 - (z * 30 / (h - 1)) as u8;
            for _ in 0..w {
                data.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let img = LinImage::from_srgb_rgba(w, h, &data);

        for kernel in [FLOYD_STEINBERG, ATKINSON, BURKES, SIERRA_LITE, STUCKI] {
            let g = quantize(
                &img,
                &p,
                &Dither::Diffusion {
                    kernel,
                    serpentine: false,
                },
                None,
            );
            let tinted: Vec<&str> = g
                .cells
                .iter()
                .flatten()
                .filter_map(|(cid, _)| d.color(*cid))
                .filter(|c| {
                    let [r, gg, b] = c.rgb;
                    let hi = r.max(gg).max(b) as i32;
                    let lo = r.min(gg).min(b) as i32;
                    hi - lo > 20
                })
                .map(|c| c.name.as_str())
                .collect();
            assert!(
                tinted.is_empty(),
                "a gray ramp picked up color: {:?}",
                &tinted[..tinted.len().min(4)]
            );
        }
    }

    #[test]
    fn exact_palette_pixels_stay_put() {
        let (d, p) = small_palette();
        let white_light = d.color(8).unwrap().tones.light;
        let img = flat_image(8, 8, [white_light[0], white_light[1], white_light[2], 255]);
        for dm in [
            Dither::None,
            Dither::Ordered(bayer4()),
            Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
        ] {
            let g = quantize(&img, &p, &dm, None);
            for c in &g.cells {
                assert_eq!(*c, Some((8, Tone::Light)));
            }
        }
    }

    #[test]
    fn diffusion_dithers_gray_between_black_and_white() {
        let (_d, p) = small_palette();
        let img = flat_image(16, 16, [140, 140, 140, 255]);
        let g = quantize(
            &img,
            &p,
            &Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
            None,
        );
        let whites = g.cells.iter().filter(|c| c.unwrap().0 == 8).count();
        let blacks = g.cells.iter().filter(|c| c.unwrap().0 == 29).count();
        assert!(
            whites > 0 && blacks > 0,
            "gray should mix: {whites}w {blacks}b"
        );
    }

    #[test]
    fn yliluoma_leaves_an_exact_palette_color_alone() {
        let (d, p) = small_palette();
        let white = d.color(8).unwrap().tones.light;
        let img = flat_image(8, 8, [white[0], white[1], white[2], 255]);
        let g = quantize(
            &img,
            &p,
            &Dither::Yliluoma {
                matrix: bayer4(),
                candidates: YLILUOMA_CANDIDATES,
            },
            None,
        );
        for c in &g.cells {
            assert_eq!(*c, Some((8, Tone::Light)));
        }
    }

    #[test]
    fn yliluoma_plan_averages_toward_the_target() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = BlockData::from_json(&json).unwrap();
        let ids: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let p = Palette::build(&d, &ids, &[Tone::Dark, Tone::Normal, Tone::Light]);

        for srgb in [[128u8, 128, 128], [200, 90, 60], [40, 90, 160]] {
            let target = linear_to_oklab(crate::color::srgb_to_linear(srgb));
            let plan = mixing_plan(target, &p, 16, YLILUOMA_CANDIDATES);
            let mut avg = [0.0f32; 3];
            for &i in &plan {
                for (a, c) in avg.iter_mut().zip(p.entries[i].linear.iter()) {
                    *a += c / plan.len() as f32;
                }
            }
            let mixed = oklab_dist2(linear_to_oklab(avg), target);
            let single = oklab_dist2(p.nearest(crate::color::srgb_to_linear(srgb)).oklab, target);
            assert!(
                mixed <= single,
                "{srgb:?}: mix {mixed} should beat single {single}"
            );
        }
    }

    #[test]
    fn yliluoma_shortlist_converges_on_the_full_palette() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = BlockData::from_json(&json).unwrap();
        let ids: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let p = Palette::build(&d, &ids, &[Tone::Dark, Tone::Normal, Tone::Light]);

        for srgb in [
            [128u8, 128, 128],
            [200, 90, 60],
            [40, 90, 160],
            [247, 244, 240],
            [90, 148, 219],
        ] {
            let target = linear_to_oklab(crate::color::srgb_to_linear(srgb));
            let short = mixing_plan(target, &p, 16, YLILUOMA_CANDIDATES);
            let full = mixing_plan(target, &p, 16, p.entries.len());
            let avg = |plan: &[usize]| {
                let mut a = [0.0f32; 3];
                for &i in plan {
                    for (t, c) in a.iter_mut().zip(p.entries[i].linear.iter()) {
                        *t += c / plan.len() as f32;
                    }
                }
                oklab_dist2(linear_to_oklab(a), target)
            };
            let (s, f) = (avg(&short), avg(&full));
            assert!(
                s <= f * 1.15 + 1e-6,
                "{srgb:?}: shortlist {s} drifted from full {f}"
            );
        }
    }

    #[test]
    fn ordered_mixes_a_midpoint_instead_of_flipping_to_one_side() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = BlockData::from_json(&json).unwrap();
        let p = Palette::build(&d, &[8], &[Tone::Dark, Tone::Light]);
        let mid = [0, 1, 2].map(|i| (p.entries[0].oklab[i] + p.entries[1].oklab[i]) / 2.0);
        let lin = crate::adjust::to_gamut(mid[0], mid[1], mid[2]);
        let srgb = lin.map(crate::color::linear_channel_to_srgb);
        let img = flat_image(8, 8, [srgb[0], srgb[1], srgb[2], 255]);
        let g = quantize(&img, &p, &Dither::Ordered(bayer4()), None);
        let darks = g.cells.iter().filter(|c| c.unwrap().1 == Tone::Dark).count();
        let lights = g.cells.iter().filter(|c| c.unwrap().1 == Tone::Light).count();
        assert!(
            darks * 4 >= g.cells.len() && lights * 4 >= g.cells.len(),
            "midpoint should mix both tones: {darks} dark, {lights} light"
        );
    }

    fn alpha_rows(w: usize, alphas: &[u8], srgb: [u8; 3]) -> LinImage {
        let mut data = Vec::new();
        for &a in alphas {
            for _ in 0..w {
                data.extend_from_slice(&[srgb[0], srgb[1], srgb[2], a]);
            }
        }
        LinImage::from_srgb_rgba(w, alphas.len(), &data)
    }

    fn every_dither() -> Vec<Dither> {
        vec![
            Dither::None,
            Dither::Ordered(bayer4()),
            Dither::Yliluoma {
                matrix: bayer4(),
                candidates: YLILUOMA_CANDIDATES,
            },
            Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
        ]
    }

    #[test]
    fn a_pixel_south_of_transparency_is_forced_to_its_light_tone() {
        let (d, p) = small_palette();
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let img = alpha_rows(3, &[0, 255, 255], [12, 12, 12]);
        for dither in every_dither() {
            let g = quantize(
                &img,
                &p,
                &dither,
                Some(Transparency {
                    threshold: 0.5,
                    edge: &edge,
                }),
            );
            for x in 0..3 {
                assert!(g.cell(x, 0).is_none(), "{dither:?}: row 0 is transparent");
                let (cid, tone) = g.cell(x, 1).expect("row 1 has art");
                assert_eq!(tone, Tone::Light, "{dither:?}: row 1 sits south of nothing");
                let want = edge.nearest(img.pixel(x, 1)[..3].try_into().unwrap());
                assert_eq!(cid, want.color_id, "{dither:?}: not the best light match");
                assert!(g.cell(x, 2).is_some(), "{dither:?}: row 2 keeps its art");
            }
        }
    }

    #[test]
    fn the_constraint_holds_when_the_palette_has_no_light_tone() {
        let (d, _) = small_palette();
        let flat = Palette::build(&d, &[8, 29], &[Tone::Normal]);
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let img = alpha_rows(2, &[0, 255], [12, 12, 12]);
        for dither in every_dither() {
            let g = quantize(
                &img,
                &flat,
                &dither,
                Some(Transparency {
                    threshold: 0.5,
                    edge: &edge,
                }),
            );
            for x in 0..2 {
                assert_eq!(
                    g.cell(x, 1).unwrap().1,
                    Tone::Light,
                    "{dither:?}: flat mode still renders the edge light"
                );
            }
        }
    }

    #[test]
    fn the_north_border_and_interior_rows_stay_unconstrained() {
        let (d, p) = small_palette();
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let img = alpha_rows(2, &[255, 255], [12, 12, 12]);
        let g = quantize(
            &img,
            &p,
            &Dither::None,
            Some(Transparency {
                threshold: 0.5,
                edge: &edge,
            }),
        );
        let free = p.nearest(img.pixel(0, 0)[..3].try_into().unwrap());
        assert_eq!(g.cell(0, 0).unwrap(), (free.color_id, free.tone));
        assert_eq!(g.cell(0, 1).unwrap(), (free.color_id, free.tone));
        assert_ne!(
            free.tone,
            Tone::Light,
            "fixture must be able to tell them apart"
        );
    }

    #[test]
    fn transparency_produces_empty_cells() {
        let (d, p) = small_palette();
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let img = flat_image(4, 4, [10, 10, 10, 0]);
        let g = quantize(
            &img,
            &p,
            &Dither::None,
            Some(Transparency {
                threshold: 0.5,
                edge: &edge,
            }),
        );
        assert!(g.cells.iter().all(Option::is_none));
    }
}
