use crate::color::linear_to_oklab;
use crate::image::LinImage;
use crate::palette::{Palette, Tone};
use crate::quantize::Grid;

const FOV_VERTICAL_DEG: f32 = 70.0;
const SCREEN_HEIGHT_MM: f32 = 298.9;
const EYE_DISTANCE_MM: f32 = 600.0;
const MAP_EDGE_PIXELS: f32 = 128.0;

const FWHM_TO_SIGMA: f32 = 2.354_82;
const LUMA_LOBES: [(f32, f32); 3] = [(0.05, 1.003_27), (0.225, 0.114_416), (7.0, -0.117_686)];
const RG_LOBES: [(f32, f32); 2] = [(0.0685, 0.616_725), (0.826, 0.383_275)];
const BY_LOBES: [(f32, f32); 2] = [(0.092, 0.567_885), (0.6451, 0.432_115)];

const XYZ_FROM_LINEAR: [[f32; 3]; 3] = [
    [0.412_456_4, 0.357_576_1, 0.180_437_5],
    [0.212_672_9, 0.715_152_2, 0.072_175_0],
    [0.019_333_9, 0.119_192, 0.950_304_1],
];
const OPP_FROM_XYZ: [[f32; 3]; 3] = [
    [0.2787, 0.7218, -0.1065],
    [-0.4487, 0.2898, 0.0772],
    [0.0859, -0.5899, 0.5011],
];
const D65: [f32; 3] = [0.950_47, 1.0, 1.088_83];

#[derive(Debug, Clone, Copy)]
pub struct Viewing {
    pub samples_per_degree: f32,
}

fn subtended_degrees(size_blocks: f32, distance_blocks: f32) -> f32 {
    (2.0 * (size_blocks * 0.5 / distance_blocks).atan()).to_degrees()
}

fn on_screen_degrees(world_degrees: f32) -> f32 {
    let half_mm = (world_degrees / FOV_VERTICAL_DEG) * SCREEN_HEIGHT_MM * 0.5;
    (2.0 * (half_mm / EYE_DISTANCE_MM).atan()).to_degrees()
}

impl Viewing {
    pub fn framed(distance_blocks: f32) -> Self {
        let eye = on_screen_degrees(subtended_degrees(1.0, distance_blocks));
        Self {
            samples_per_degree: MAP_EDGE_PIXELS / eye,
        }
    }

    pub fn held(screen_fraction: f32) -> Self {
        let half_mm = screen_fraction * SCREEN_HEIGHT_MM * 0.5;
        let eye = (2.0 * (half_mm / EYE_DISTANCE_MM).atan()).to_degrees();
        Self {
            samples_per_degree: MAP_EDGE_PIXELS / eye,
        }
    }
}

pub fn opponent_kernels(view: Viewing, max_radius: usize) -> [Vec<f32>; 3] {
    let spd = view.samples_per_degree;
    [
        lobe_kernel(&LUMA_LOBES, spd, max_radius),
        lobe_kernel(&RG_LOBES, spd, max_radius),
        lobe_kernel(&BY_LOBES, spd, max_radius),
    ]
}

pub fn opponent_of(lin: [f32; 3]) -> [f32; 3] {
    apply3(OPP_FROM_XYZ, apply3(XYZ_FROM_LINEAR, lin))
}

fn erf(x: f32) -> f32 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let poly = t
        * (0.254_829_6
            + t * (-0.284_496_74 + t * (1.421_413_7 + t * (-1.453_152 + t * 1.061_405_4))));
    sign * (1.0 - poly * (-x * x).exp())
}

fn gauss_cells(sigma: f32, radius: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; 2 * radius + 1];
    if sigma < 1e-4 {
        v[radius] = 1.0;
        return v;
    }
    let s = 1.0 / (sigma * std::f32::consts::SQRT_2);
    for (i, out) in v.iter_mut().enumerate() {
        let k = i as f32 - radius as f32;
        *out = 0.5 * (erf((k + 0.5) * s) - erf((k - 0.5) * s));
    }
    v
}

fn lobe_kernel(lobes: &[(f32, f32)], spd: f32, max_radius: usize) -> Vec<f32> {
    let sigmas: Vec<f32> = lobes
        .iter()
        .map(|(fwhm, _)| fwhm * spd / FWHM_TO_SIGMA)
        .collect();
    let widest = sigmas.iter().copied().fold(0.0f32, f32::max);
    let radius = ((widest * 3.0).ceil().max(1.0) as usize).min(max_radius.max(1));
    let mut acc = vec![0.0f32; 2 * radius + 1];
    for (&(_, weight), &sigma) in lobes.iter().zip(sigmas.iter()) {
        for (a, g) in acc.iter_mut().zip(gauss_cells(sigma, radius).iter()) {
            *a += weight * g;
        }
    }
    let sum: f32 = acc.iter().sum();
    for a in acc.iter_mut() {
        *a /= sum;
    }
    acc
}

pub fn convolve(plane: &[f32], w: usize, h: usize, k: &[f32]) -> Vec<f32> {
    let r = (k.len() / 2) as isize;
    let mut mid = vec![0.0f32; w * h];
    for z in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (i, &kv) in k.iter().enumerate() {
                let sx = (x as isize + i as isize - r).clamp(0, w as isize - 1) as usize;
                acc += kv * plane[z * w + sx];
            }
            mid[z * w + x] = acc;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for z in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (i, &kv) in k.iter().enumerate() {
                let sz = (z as isize + i as isize - r).clamp(0, h as isize - 1) as usize;
                acc += kv * mid[sz * w + x];
            }
            out[z * w + x] = acc;
        }
    }
    out
}

fn apply3(m: [[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn invert3(m: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let c = [
        [
            m[1][1] * m[2][2] - m[1][2] * m[2][1],
            m[0][2] * m[2][1] - m[0][1] * m[2][2],
            m[0][1] * m[1][2] - m[0][2] * m[1][1],
        ],
        [
            m[1][2] * m[2][0] - m[1][0] * m[2][2],
            m[0][0] * m[2][2] - m[0][2] * m[2][0],
            m[0][2] * m[1][0] - m[0][0] * m[1][2],
        ],
        [
            m[1][0] * m[2][1] - m[1][1] * m[2][0],
            m[0][1] * m[2][0] - m[0][0] * m[2][1],
            m[0][0] * m[1][1] - m[0][1] * m[1][0],
        ],
    ];
    c.map(|row| row.map(|v| v / d))
}

fn lab_f(t: f32) -> f32 {
    const D: f32 = 6.0 / 29.0;
    if t > D * D * D {
        t.cbrt()
    } else {
        t / (3.0 * D * D) + 4.0 / 29.0
    }
}

fn xyz_to_lab(xyz: [f32; 3]) -> [f32; 3] {
    let fx = lab_f(xyz[0] / D65[0]);
    let fy = lab_f(xyz[1] / D65[1]);
    let fz = lab_f(xyz[2] / D65[2]);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

pub fn grid_to_linear(grid: &Grid, palette: &Palette) -> LinImage {
    let mut lookup = [[None; 4]; 64];
    for e in &palette.entries {
        lookup[e.color_id as usize % 64][e.tone.mapdat_offset() as usize] = Some(e.linear);
    }
    let pixels = grid
        .cells
        .iter()
        .map(|c| match c {
            Some((cid, tone)) => {
                let l = lookup[*cid as usize % 64][tone.mapdat_offset() as usize]
                    .unwrap_or([0.0, 0.0, 0.0]);
                [l[0], l[1], l[2], 1.0]
            }
            None => [0.0, 0.0, 0.0, 1.0],
        })
        .collect();
    LinImage {
        width: grid.width,
        height: grid.height,
        pixels,
    }
}

struct Seen {
    lab: Vec<[f32; 3]>,
    oklab: Vec<[f32; 3]>,
    bw: Vec<f32>,
}

fn local_mean(plane: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    let k = vec![1.0 / (2 * radius + 1) as f32; 2 * radius + 1];
    convolve(plane, w, h, &k)
}

fn perceive(img: &LinImage, kernels: &[Vec<f32>; 3]) -> Seen {
    let (w, h) = (img.width, img.height);
    let mut planes = [
        vec![0.0f32; w * h],
        vec![0.0f32; w * h],
        vec![0.0f32; w * h],
    ];
    for (i, p) in img.pixels.iter().enumerate() {
        let opp = apply3(OPP_FROM_XYZ, apply3(XYZ_FROM_LINEAR, [p[0], p[1], p[2]]));
        for (plane, v) in planes.iter_mut().zip(opp.iter()) {
            plane[i] = *v;
        }
    }
    let filtered: Vec<Vec<f32>> = planes
        .iter()
        .zip(kernels.iter())
        .map(|(p, k)| convolve(p, w, h, k))
        .collect();

    let xyz_from_opp = invert3(OPP_FROM_XYZ);
    let lin_from_xyz = invert3(XYZ_FROM_LINEAR);
    let mut lab = Vec::with_capacity(w * h);
    let mut oklab = Vec::with_capacity(w * h);
    for ((&bw, &rg), &by) in filtered[0]
        .iter()
        .zip(filtered[1].iter())
        .zip(filtered[2].iter())
    {
        let xyz = apply3(xyz_from_opp, [bw, rg, by]);
        lab.push(xyz_to_lab(xyz));
        oklab.push(linear_to_oklab(apply3(lin_from_xyz, xyz)));
    }
    Seen {
        lab,
        oklab,
        bw: filtered[0].clone(),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Report {
    pub scielab_mean: f32,
    pub scielab_p95: f32,
    pub oklab_mean: f32,
    pub oklab_p95: f32,
    pub chroma_cast: f32,
    pub chroma_speckle: f32,
    pub grain: f32,
}

fn percentile(mut v: Vec<f32>, p: f32) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let idx = ((v.len() - 1) as f32 * p).round() as usize;
    v[idx]
}

pub fn compare(src: &LinImage, out: &LinImage, view: Viewing) -> Report {
    assert_eq!(
        (src.width, src.height),
        (out.width, out.height),
        "compared images share a size"
    );
    let max_radius = src.width.max(src.height);
    let kernels = opponent_kernels(view, max_radius);
    let a = perceive(src, &kernels);
    let b = perceive(out, &kernels);

    let de: Vec<f32> = a
        .lab
        .iter()
        .zip(b.lab.iter())
        .map(|(p, q)| {
            ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
        })
        .collect();
    let dok: Vec<f32> = a
        .oklab
        .iter()
        .zip(b.oklab.iter())
        .map(|(p, q)| {
            ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
        })
        .collect();

    let drift: Vec<f32> = a
        .oklab
        .iter()
        .zip(b.oklab.iter())
        .map(|(p, q)| ((p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt())
        .collect();
    let cast = drift.iter().sum::<f32>() / drift.len() as f32;
    let speckle = percentile(drift, 0.999);

    let visible_error: Vec<f32> = b.bw.iter().zip(a.bw.iter()).map(|(q, p)| q - p).collect();
    let smooth = local_mean(&visible_error, src.width, src.height, 2);
    let grain = (visible_error
        .iter()
        .zip(smooth.iter())
        .map(|(e, s)| (e - s) * (e - s))
        .sum::<f32>()
        / visible_error.len() as f32)
        .sqrt();

    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    Report {
        scielab_mean: mean(&de),
        scielab_p95: percentile(de, 0.95),
        oklab_mean: mean(&dok),
        oklab_p95: percentile(dok, 0.95),
        chroma_cast: cast,
        chroma_speckle: speckle,
        grain,
    }
}

pub fn palette_entry(palette: &Palette, color_id: u8, tone: Tone) -> Option<usize> {
    palette
        .entries
        .iter()
        .position(|e| e.color_id == color_id && e.tone == tone)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: usize, h: usize, rgba: [u8; 4]) -> LinImage {
        let data: Vec<u8> = std::iter::repeat_n(rgba, w * h).flatten().collect();
        LinImage::from_srgb_rgba(w, h, &data)
    }

    #[test]
    fn erf_matches_known_values() {
        for (x, want) in [
            (0.0, 0.0),
            (0.5, 0.520_499_9),
            (1.0, 0.842_700_8),
            (2.0, 0.995_322_3),
            (-1.0, -0.842_700_8),
        ] {
            assert!((erf(x) - want).abs() < 2e-7, "erf({x}) = {}", erf(x));
        }
    }

    #[test]
    fn gauss_cells_integrate_to_one() {
        for sigma in [0.3f32, 0.58, 2.6, 9.7] {
            let k = gauss_cells(sigma, (sigma * 4.0).ceil() as usize + 1);
            let s: f32 = k.iter().sum();
            assert!((s - 1.0).abs() < 1e-3, "sigma {sigma} sums to {s}");
        }
    }

    #[test]
    fn published_lobe_weights_sum_to_unity() {
        for lobes in [&LUMA_LOBES[..], &RG_LOBES[..], &BY_LOBES[..]] {
            let s: f32 = lobes.iter().map(|(_, w)| w).sum();
            assert!((s - 1.0).abs() < 1e-5, "lobe weights sum to {s}");
        }
    }

    #[test]
    fn kernels_preserve_dc() {
        for spd in [0.86f32, 8.2, 27.5, 82.0] {
            for lobes in [&LUMA_LOBES[..], &RG_LOBES[..], &BY_LOBES[..]] {
                let k = lobe_kernel(lobes, spd, 128);
                let s: f32 = k.iter().sum();
                assert!((s - 1.0).abs() < 1e-4, "spd {spd} kernel sums to {s}");
            }
        }
    }

    #[test]
    fn matrix_inverse_round_trips() {
        for m in [OPP_FROM_XYZ, XYZ_FROM_LINEAR] {
            let inv = invert3(m);
            for v in [[0.3f32, 0.6, 0.1], [1.0, 1.0, 1.0], [0.05, 0.02, 0.9]] {
                let back = apply3(inv, apply3(m, v));
                for (a, b) in back.iter().zip(v.iter()) {
                    assert!((a - b).abs() < 1e-4, "{back:?} vs {v:?}");
                }
            }
        }
    }

    #[test]
    fn linear_white_is_d65() {
        let xyz = apply3(XYZ_FROM_LINEAR, [1.0, 1.0, 1.0]);
        for (a, b) in xyz.iter().zip(D65.iter()) {
            assert!((a - b).abs() < 1e-4, "{xyz:?}");
        }
        let lab = xyz_to_lab(xyz);
        assert!((lab[0] - 100.0).abs() < 1e-3 && lab[1].abs() < 1e-2 && lab[2].abs() < 1e-2);
    }

    #[test]
    fn uniform_regions_reduce_to_plain_cielab() {
        let a = flat(32, 32, [120, 90, 200, 255]);
        let b = flat(32, 32, [128, 96, 190, 255]);
        let spatial = compare(&a, &b, Viewing::framed(5.0));
        let la = xyz_to_lab(apply3(
            XYZ_FROM_LINEAR,
            [a.pixel(0, 0)[0], a.pixel(0, 0)[1], a.pixel(0, 0)[2]],
        ));
        let lb = xyz_to_lab(apply3(
            XYZ_FROM_LINEAR,
            [b.pixel(0, 0)[0], b.pixel(0, 0)[1], b.pixel(0, 0)[2]],
        ));
        let plain =
            ((la[0] - lb[0]).powi(2) + (la[1] - lb[1]).powi(2) + (la[2] - lb[2]).powi(2)).sqrt();
        assert!(
            (spatial.scielab_mean - plain).abs() < 0.05,
            "spatial {} vs plain {plain}",
            spatial.scielab_mean
        );
    }

    #[test]
    fn identical_images_score_zero() {
        let a = flat(16, 16, [200, 30, 90, 255]);
        let r = compare(&a, &a, Viewing::framed(5.0));
        assert!(r.scielab_mean < 1e-3 && r.oklab_mean < 1e-3 && r.grain < 1e-6);
    }

    #[test]
    fn chroma_blurs_more_than_luminance() {
        let spd = Viewing::framed(5.0).samples_per_degree;
        let luma = lobe_kernel(&LUMA_LOBES, spd, 128);
        let by = lobe_kernel(&BY_LOBES, spd, 128);
        let peak = |k: &[f32]| k[k.len() / 2];
        assert!(
            peak(&luma) > peak(&by) * 2.0,
            "luma peak {} vs by peak {}",
            peak(&luma),
            peak(&by)
        );
    }

    #[test]
    fn grain_falls_as_the_map_gets_further_away() {
        let src = flat(64, 64, [128, 128, 128, 255]);
        let mut data = Vec::new();
        for z in 0..64 {
            for x in 0..64 {
                let v = if (x + z) % 2 == 0 { 90u8 } else { 165 };
                data.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let checker = LinImage::from_srgb_rgba(64, 64, &data);
        let near = compare(&src, &checker, Viewing::framed(1.0)).grain;
        let mid = compare(&src, &checker, Viewing::framed(5.0)).grain;
        let far = compare(&src, &checker, Viewing::framed(15.0)).grain;
        assert!(
            near > mid && mid > far,
            "grain should fall with distance: {near} {mid} {far}"
        );
    }

    #[test]
    fn viewing_distance_orders_sampling_rate() {
        assert!(Viewing::framed(3.0).samples_per_degree < Viewing::framed(8.0).samples_per_degree);
        assert!(Viewing::framed(1.0).samples_per_degree < Viewing::framed(3.0).samples_per_degree);
        assert!((Viewing::framed(5.0).samples_per_degree - 27.5).abs() < 0.5);
    }
}
