use arachne_core::adjust::to_gamut;
use arachne_core::color::linear_to_srgb;
use arachne_core::data::BlockData;
use arachne_core::dbs::{DbsConfig, refine};
use arachne_core::heightcap::{apply_height_cap, natural_peak};
use arachne_core::image::LinImage;
use arachne_core::metric::{Report, Viewing, compare, grid_to_linear};
use arachne_core::palette::{Matcher, Palette, Tone};
use arachne_core::quantize::{
    ATKINSON, BURKES, Dither, FLOYD_STEINBERG, MIN_AVG_ERR, SIERRA_LITE, STUCKI,
    YLILUOMA_CANDIDATES, bayer2, bayer4, blue16, ordered3, quantize,
};

const SIDE: usize = 128;

fn full_palette() -> (BlockData, Palette) {
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

fn build<F: Fn(usize, usize) -> [u8; 3]>(f: F) -> LinImage {
    let mut data = Vec::with_capacity(SIDE * SIDE * 4);
    for z in 0..SIDE {
        for x in 0..SIDE {
            let c = f(x, z);
            data.extend_from_slice(&[c[0], c[1], c[2], 255]);
        }
    }
    LinImage::from_srgb_rgba(SIDE, SIDE, &data)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn oklch(l: f32, c: f32, hue_deg: f32) -> [u8; 3] {
    let h = hue_deg.to_radians();
    linear_to_srgb(to_gamut(l, c * h.cos(), c * h.sin()))
}

fn neutral_ramp_tight(_x: usize, z: usize) -> [u8; 3] {
    let v = 255 - (z * 30 / (SIDE - 1)) as u8;
    [v, v, v]
}

fn neutral_ramp_full(_x: usize, z: usize) -> [u8; 3] {
    let v = (255 - z * 255 / (SIDE - 1)) as u8;
    [v, v, v]
}

fn sky_gradient(_x: usize, z: usize) -> [u8; 3] {
    let t = z as f32 / (SIDE - 1) as f32;
    [
        lerp(203.0, 92.0, t) as u8,
        lerp(228.0, 148.0, t) as u8,
        lerp(247.0, 219.0, t) as u8,
    ]
}

fn hue_wheel(x: usize, _z: usize) -> [u8; 3] {
    oklch(0.65, 0.12, x as f32 / SIDE as f32 * 360.0)
}

fn chroma_ramp(x: usize, _z: usize) -> [u8; 3] {
    oklch(0.70, x as f32 / (SIDE - 1) as f32 * 0.20, 30.0)
}

fn lightness_ramp_saturated(_x: usize, z: usize) -> [u8; 3] {
    oklch(lerp(0.20, 0.90, z as f32 / (SIDE - 1) as f32), 0.11, 250.0)
}

fn skin_band(x: usize, z: usize) -> [u8; 3] {
    const TONES: [[u8; 3]; 6] = [
        [255, 224, 196],
        [241, 194, 165],
        [224, 172, 138],
        [198, 134, 100],
        [141, 85, 58],
        [92, 55, 40],
    ];
    let base = TONES[z * TONES.len() / SIDE];
    let shade = lerp(0.88, 1.12, x as f32 / (SIDE - 1) as f32);
    base.map(|c| (f32::from(c) * shade).clamp(0.0, 255.0) as u8)
}

fn two_tone_edge(x: usize, z: usize) -> [u8; 3] {
    if (x / 16 + z / 16) % 2 == 0 {
        [178, 34, 52]
    } else {
        [28, 62, 138]
    }
}

fn probes() -> Vec<(&'static str, LinImage)> {
    vec![
        ("neutral_ramp_tight", build(neutral_ramp_tight)),
        ("neutral_ramp_full", build(neutral_ramp_full)),
        ("sky_gradient", build(sky_gradient)),
        ("hue_wheel", build(hue_wheel)),
        ("chroma_ramp", build(chroma_ramp)),
        ("lightness_ramp_saturated", build(lightness_ramp_saturated)),
        ("skin_band", build(skin_band)),
        ("two_tone_edge", build(two_tone_edge)),
    ]
}

fn exact_swatches(palette: &Palette) -> LinImage {
    let n = palette.entries.len();
    build(|x, z| {
        let cell = (z / 8) * (SIDE / 8) + (x / 8);
        palette.entries[cell % n].srgb
    })
}

fn configs() -> Vec<(&'static str, Dither, Option<DbsConfig>)> {
    let base = configs_plain();
    let fs = Dither::Diffusion {
        kernel: FLOYD_STEINBERG,
        serpentine: true,
    };
    let yl = Dither::Yliluoma {
        matrix: bayer4(),
        candidates: YLILUOMA_CANDIDATES,
        levels: None,
    };
    let mut out: Vec<(&'static str, Dither, Option<DbsConfig>)> =
        base.into_iter().map(|(n, d)| (n, d, None)).collect();
    out.push(("dbs-from-fs", fs, Some(DbsConfig::default())));
    out.push(("dbs-from-yliluoma", yl, Some(DbsConfig::default())));
    out
}

fn configs_plain() -> Vec<(&'static str, Dither)> {
    vec![
        ("none", Dither::None),
        ("bayer4", Dither::Ordered(bayer4())),
        ("blue16", Dither::Ordered(blue16())),
        (
            "yliluoma-blue16",
            Dither::Yliluoma {
                matrix: blue16(),
                candidates: YLILUOMA_CANDIDATES,
                levels: None,
            },
        ),
        (
            "yl-blue16-l16",
            Dither::Yliluoma {
                matrix: blue16(),
                candidates: YLILUOMA_CANDIDATES,
                levels: Some(16),
            },
        ),
        (
            "yl-blue16-l64",
            Dither::Yliluoma {
                matrix: blue16(),
                candidates: YLILUOMA_CANDIDATES,
                levels: Some(64),
            },
        ),
        ("ordered3", Dither::Ordered(ordered3())),
        (
            "yliluoma-b2",
            Dither::Yliluoma {
                matrix: bayer2(),
                candidates: YLILUOMA_CANDIDATES,
                levels: None,
            },
        ),
        (
            "yliluoma-b4",
            Dither::Yliluoma {
                matrix: bayer4(),
                candidates: YLILUOMA_CANDIDATES,
                levels: None,
            },
        ),
        (
            "yliluoma-o3",
            Dither::Yliluoma {
                matrix: ordered3(),
                candidates: YLILUOMA_CANDIDATES,
                levels: None,
            },
        ),
        (
            "floyd-steinberg",
            Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
        ),
        (
            "burkes",
            Dither::Diffusion {
                kernel: BURKES,
                serpentine: true,
            },
        ),
        (
            "stucki",
            Dither::Diffusion {
                kernel: STUCKI,
                serpentine: true,
            },
        ),
        (
            "atkinson",
            Dither::Diffusion {
                kernel: ATKINSON,
                serpentine: true,
            },
        ),
        (
            "sierra-lite",
            Dither::Diffusion {
                kernel: SIERRA_LITE,
                serpentine: true,
            },
        ),
        (
            "min-avg-err",
            Dither::Diffusion {
                kernel: MIN_AVG_ERR,
                serpentine: true,
            },
        ),
    ]
}

fn score(src: &LinImage, palette: &Palette, dither: &Dither, view: Viewing) -> Report {
    score_mode(src, palette, dither, None, view)
}

fn score_mode(
    src: &LinImage,
    palette: &Palette,
    dither: &Dither,
    dbs: Option<&DbsConfig>,
    view: Viewing,
) -> Report {
    let grid = quantize(src, palette, dither, None);
    let grid = match dbs {
        Some(cfg) => refine(src, palette, None, &grid, cfg).0,
        None => grid,
    };
    compare(src, &grid_to_linear(&grid, palette), view)
}

fn table(label: &str, view: Viewing, all: &[(&str, LinImage)], palette: &Palette, detail: bool) {
    println!(
        "\n=== {label}: {:.2} samples/degree, {:.1} arcmin per map pixel ===",
        view.samples_per_degree,
        60.0 / view.samples_per_degree
    );
    let mut totals: Vec<(String, [f32; 5])> = Vec::new();
    for (pname, img) in all {
        if detail {
            println!("\n{pname}");
            println!(
                "  {:<16} {:>8} {:>8} {:>8} {:>9} {:>9} {:>8}",
                "dither", "dE_mean", "dE_p95", "ok_mean", "cast", "speckle", "grain"
            );
        }
        for (cname, dither, dbs) in configs() {
            let r = score_mode(img, palette, &dither, dbs.as_ref(), view);
            if detail {
                println!(
                    "  {:<16} {:>8.3} {:>8.3} {:>8.4} {:>9.5} {:>9.5} {:>8.4}",
                    cname,
                    r.scielab_mean,
                    r.scielab_p95,
                    r.oklab_mean,
                    r.chroma_cast,
                    r.chroma_speckle,
                    r.grain
                );
            }
            let row = [
                r.scielab_mean,
                r.scielab_p95,
                r.chroma_cast,
                r.chroma_speckle,
                r.grain,
            ];
            match totals.iter_mut().find(|t| t.0 == cname) {
                Some(t) => {
                    for (acc, v) in t.1.iter_mut().zip(row.iter()) {
                        *acc += v;
                    }
                }
                None => totals.push((cname.to_string(), row)),
            }
        }
    }
    let n = all.len() as f32;
    totals.sort_by(|a, b| a.1[0].partial_cmp(&b.1[0]).unwrap());
    println!(
        "\n  corpus mean over {} probes, ranked by dE_mean",
        all.len()
    );
    println!(
        "  {:<16} {:>8} {:>8} {:>9} {:>9} {:>8}",
        "dither", "dE_mean", "dE_p95", "cast", "speckle", "grain"
    );
    for t in &totals {
        println!(
            "  {:<16} {:>8.3} {:>8.3} {:>9.5} {:>9.5} {:>8.4}",
            t.0,
            t.1[0] / n,
            t.1[1] / n,
            t.1[2] / n,
            t.1[3] / n,
            t.1[4] / n
        );
    }
}

#[test]
#[ignore = "report, not an assertion: cargo test --release --test bench -- --ignored --nocapture"]
fn quality_table() {
    let (_d, palette) = full_palette();
    let mut all = probes();
    all.push(("exact_swatches", exact_swatches(&palette)));
    table(
        "framed on a wall, 5 blocks back",
        Viewing::framed(5.0),
        &all,
        &palette,
        true,
    );
    table(
        "stood at the wall, 2 blocks",
        Viewing::framed(2.0),
        &all,
        &palette,
        false,
    );
    table(
        "nose on the frame, 1 block",
        Viewing::framed(1.0),
        &all,
        &palette,
        false,
    );
    println!();
}

fn vivid_gradient(x: usize, z: usize) -> [u8; 3] {
    let hue = lerp(150.0, 330.0, x as f32 / (SIDE - 1) as f32);
    let l = lerp(0.35, 0.85, z as f32 / (SIDE - 1) as f32);
    oklch(l, 0.28, hue)
}

fn achievable_error(target: [f32; 3], palette: &Palette) -> f32 {
    let mut acc = [0.0f32; 3];
    let mut best_err = f32::INFINITY;
    for i in 0..16 {
        let count = (i + 1) as f32;
        let mut best = 0;
        let mut best_d = f32::INFINITY;
        for (idx, e) in palette.entries.iter().enumerate() {
            let avg = [0, 1, 2].map(|c| (acc[c] + e.linear[c]) / count);
            let d =
                arachne_core::color::oklab_dist2(arachne_core::color::linear_to_oklab(avg), target);
            if d < best_d {
                best_d = d;
                best = idx;
            }
        }
        for (a, c) in acc.iter_mut().zip(palette.entries[best].linear.iter()) {
            *a += c;
        }
        best_err = best_err.min(best_d);
    }
    best_err.sqrt()
}

fn prefit(img: &LinImage, palette: &Palette, tau: f32) -> LinImage {
    let mut out = img.clone();
    for p in out.pixels.iter_mut() {
        let lab = arachne_core::color::linear_to_oklab([p[0], p[1], p[2]]);
        if achievable_error(lab, palette) <= tau {
            continue;
        }
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        for _ in 0..8 {
            let mid = 0.5 * (lo + hi);
            let t = [lab[0], lab[1] * mid, lab[2] * mid];
            if achievable_error(t, palette) <= tau {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let fitted = to_gamut(lab[0], lab[1] * lo, lab[2] * lo);
        p[0] = fitted[0];
        p[1] = fitted[1];
        p[2] = fitted[2];
    }
    out
}

fn fs_unclamped(img: &LinImage, palette: &Palette) -> LinImage {
    let (w, h) = (img.width, img.height);
    let mut buf: Vec<[f32; 3]> = img.pixels.iter().map(|p| [p[0], p[1], p[2]]).collect();
    let mut out = Vec::with_capacity(w * h);
    let k = FLOYD_STEINBERG;
    for z in 0..h {
        for x in 0..w {
            let old = buf[z * w + x].map(|c| c.clamp(0.0, 1.0));
            let e = palette.nearest(old);
            out.push([e.linear[0], e.linear[1], e.linear[2], 1.0]);
            let err = [0, 1, 2].map(|c| old[c] - e.linear[c]);
            for (dz, row) in k.rows.iter().enumerate() {
                for (ci, &wgt) in row.iter().enumerate() {
                    if wgt == 0.0 {
                        continue;
                    }
                    let nx = x as isize + ci as isize - 2;
                    let nz = z + dz;
                    if nz >= h || nx < 0 || nx as usize >= w {
                        continue;
                    }
                    let t = &mut buf[nz * w + nx as usize];
                    for (tc, ec) in t.iter_mut().zip(err.iter()) {
                        *tc += ec * wgt / k.divisor;
                    }
                }
            }
        }
    }
    LinImage {
        width: w,
        height: h,
        pixels: out,
    }
}

fn zone_plate(x: usize, z: usize) -> [u8; 3] {
    let cx = x as f32 - SIDE as f32 / 2.0;
    let cz = z as f32 - SIDE as f32 / 2.0;
    let r2 = cx * cx + cz * cz;
    let v = 0.5 + 0.35 * (r2 * 0.011).cos();
    let s = arachne_core::color::linear_channel_to_srgb(v * v);
    [s, s, s]
}

fn sharpen(img: &LinImage, amount: f32) -> LinImage {
    let (w, h) = (img.width, img.height);
    let k = [1.0f32, 4.0, 6.0, 4.0, 1.0].map(|v| v / 16.0);
    let mut out = img.clone();
    for c in 0..3 {
        let plane: Vec<f32> = img.pixels.iter().map(|p| p[c]).collect();
        let blurred = arachne_core::metric::convolve(&plane, w, h, &k);
        for (p, (orig, b)) in out.pixels.iter_mut().zip(plane.iter().zip(blurred.iter())) {
            p[c] = (orig + amount * (orig - b)).clamp(0.0, 1.0);
        }
    }
    out
}

#[test]
#[ignore = "report, not an assertion: cargo test --release -p arachne-core --test bench sharpen_table -- --ignored --nocapture"]
fn sharpen_table() {
    let (_d, palette) = full_palette();
    let fs = Dither::Diffusion {
        kernel: FLOYD_STEINBERG,
        serpentine: true,
    };
    let yl = Dither::Yliluoma {
        matrix: bayer4(),
        candidates: YLILUOMA_CANDIDATES,
        levels: None,
    };
    let probes_sel = [
        ("zone_plate", build(zone_plate)),
        ("two_tone_edge", build(two_tone_edge)),
        ("skin_band", build(skin_band)),
        ("sky_gradient", build(sky_gradient)),
    ];
    for (vname, view) in [
        ("framed 5", Viewing::framed(5.0)),
        ("held", Viewing::held(0.163)),
    ] {
        println!("\n=== {vname} ===");
        println!(
            "  {:<16} {:<12} {:>7} {:>8} {:>8} {:>9} {:>8}",
            "probe", "mode", "amount", "dE_mean", "dE_p95", "cast", "grain"
        );
        for (pname, img) in &probes_sel {
            for (mname, dither) in [("fs", &fs), ("yl-b4", &yl)] {
                for amount in [0.0f32, 0.5, 1.0, 2.0] {
                    let pre = if amount == 0.0 {
                        img.clone()
                    } else {
                        sharpen(img, amount)
                    };
                    let g = quantize(&pre, &palette, dither, None);
                    let r = compare(img, &grid_to_linear(&g, &palette), view);
                    println!(
                        "  {:<16} {:<12} {:>7.1} {:>8.3} {:>8.3} {:>9.5} {:>8.4}",
                        pname, mname, amount, r.scielab_mean, r.scielab_p95, r.chroma_cast, r.grain
                    );
                }
            }
        }
    }
}

#[test]
#[ignore = "report, not an assertion: cargo test --release -p arachne-core --test bench prefit_table -- --ignored --nocapture"]
fn prefit_table() {
    let (_d, palette) = full_palette();
    let fs = Dither::Diffusion {
        kernel: FLOYD_STEINBERG,
        serpentine: true,
    };
    let yl = Dither::Yliluoma {
        matrix: bayer4(),
        candidates: YLILUOMA_CANDIDATES,
        levels: None,
    };
    let probes_sel = [
        ("vivid_gradient", build(vivid_gradient)),
        ("sky_gradient", build(sky_gradient)),
        ("hue_wheel", build(hue_wheel)),
        ("skin_band", build(skin_band)),
    ];
    let view = Viewing::framed(5.0);
    println!(
        "  {:<22} {:<16} {:>8} {:>8} {:>9} {:>9} {:>8}",
        "probe", "mode", "dE_mean", "dE_p95", "cast", "speckle", "grain"
    );
    for (pname, img) in &probes_sel {
        let fitted = prefit(img, &palette, 0.02);
        let rows: Vec<(&str, LinImage)> = vec![
            ("fs-clamp", {
                let g = quantize(img, &palette, &fs, None);
                grid_to_linear(&g, &palette)
            }),
            ("fs-noclamp", fs_unclamped(img, &palette)),
            ("prefit+fs-clamp", {
                let g = quantize(&fitted, &palette, &fs, None);
                grid_to_linear(&g, &palette)
            }),
            ("prefit+fs-noclamp", fs_unclamped(&fitted, &palette)),
            ("yliluoma-b4", {
                let g = quantize(img, &palette, &yl, None);
                grid_to_linear(&g, &palette)
            }),
            ("prefit+yliluoma-b4", {
                let g = quantize(&fitted, &palette, &yl, None);
                grid_to_linear(&g, &palette)
            }),
        ];
        for (mname, render) in &rows {
            let r = compare(img, render, view);
            println!(
                "  {:<22} {:<16} {:>8.3} {:>8.3} {:>9.5} {:>9.5} {:>8.4}",
                pname,
                mname,
                r.scielab_mean,
                r.scielab_p95,
                r.chroma_cast,
                r.chroma_speckle,
                r.grain
            );
        }
    }
}

#[test]
#[ignore = "report, not an assertion: cargo test --release -p arachne-core --test bench matcher_table -- --ignored --nocapture"]
fn matcher_table() {
    let (_d, palette) = full_palette();
    let matchers = [
        ("ok-euclid", Matcher::OkEuclid),
        ("ok-hyab", Matcher::OkHyab),
        ("ok-l2x", Matcher::OkLScaled(2.0)),
        ("ok-l3x", Matcher::OkLScaled(3.0)),
        ("ok-lhalf", Matcher::OkLScaled(0.5)),
    ];
    let modes: Vec<(&str, Dither)> = vec![
        ("none", Dither::None),
        (
            "floyd-steinberg",
            Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
        ),
        (
            "yliluoma-b4",
            Dither::Yliluoma {
                matrix: bayer4(),
                candidates: YLILUOMA_CANDIDATES,
                levels: None,
            },
        ),
    ];
    for (vname, view) in [
        ("framed 5 blocks", Viewing::framed(5.0)),
        ("nose on the frame", Viewing::framed(1.0)),
    ] {
        println!("\n=== {vname} ===");
        println!(
            "  {:<16} {:<10} {:>8} {:>8} {:>8} {:>9} {:>9} {:>8}",
            "mode", "matcher", "dE_mean", "dE_p95", "ok_mean", "cast", "speckle", "grain"
        );
        for (mname, dither) in &modes {
            for (name, m) in matchers {
                let p = palette.clone().with_matcher(m);
                let mut acc = [0.0f32; 6];
                let probes = probes();
                for (_p, img) in &probes {
                    let r = score(img, &p, dither, view);
                    for (a, v) in acc.iter_mut().zip([
                        r.scielab_mean,
                        r.scielab_p95,
                        r.oklab_mean,
                        r.chroma_cast,
                        r.chroma_speckle,
                        r.grain,
                    ]) {
                        *a += v;
                    }
                }
                let n = probes.len() as f32;
                println!(
                    "  {:<16} {:<10} {:>8.3} {:>8.3} {:>8.4} {:>9.5} {:>9.5} {:>8.4}",
                    mname,
                    name,
                    acc[0] / n,
                    acc[1] / n,
                    acc[2] / n,
                    acc[3] / n,
                    acc[4] / n,
                    acc[5] / n
                );
            }
        }
    }
}

fn write_ppm(path: &str, img: &LinImage, scale: usize) {
    let (w, h) = (img.width * scale, img.height * scale);
    let mut out = format!("P6\n{w} {h}\n255\n").into_bytes();
    for y in 0..h {
        for x in 0..w {
            let p = img.pixel(x / scale, y / scale);
            out.extend_from_slice(&linear_to_srgb([p[0], p[1], p[2]]));
        }
    }
    std::fs::write(path, out).unwrap();
}

#[test]
#[ignore = "render probe sheets: ARACHNE_PROBE_DIR=<dir> cargo test --release -p arachne-core --test bench render_probes -- --ignored"]
fn render_probes() {
    let Ok(dir) = std::env::var("ARACHNE_PROBE_DIR") else {
        return;
    };
    let (_d, palette) = full_palette();
    let picks: Vec<(&str, Dither)> = vec![
        (
            "yliluoma-b4",
            Dither::Yliluoma {
                matrix: bayer4(),
                candidates: YLILUOMA_CANDIDATES,
                levels: None,
            },
        ),
        (
            "yl-blue16-l16",
            Dither::Yliluoma {
                matrix: blue16(),
                candidates: YLILUOMA_CANDIDATES,
                levels: Some(16),
            },
        ),
        (
            "yl-blue16-l64",
            Dither::Yliluoma {
                matrix: blue16(),
                candidates: YLILUOMA_CANDIDATES,
                levels: Some(64),
            },
        ),
        (
            "floyd-steinberg",
            Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
        ),
    ];
    for (pname, img) in probes() {
        write_ppm(&format!("{dir}/{pname}-source.ppm"), &img, 4);
        for (cname, dither) in &picks {
            let grid = quantize(&img, &palette, dither, None);
            let out = grid_to_linear(&grid, &palette);
            write_ppm(&format!("{dir}/{pname}-{cname}.ppm"), &out, 4);
        }
    }
}

#[test]
fn height_cap_sweep_holds_every_level_between_staircased_and_flat() {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../data/blocks-26.2.json"
    ))
    .unwrap();
    let d = BlockData::from_json(&json).unwrap();
    let (_d2, palette) = full_palette();
    let all = [Tone::Dark, Tone::Normal, Tone::Light];
    let view = Viewing::framed(5.0);

    for (pname, img) in [
        ("sky_gradient", build(sky_gradient)),
        ("skin_band", build(skin_band)),
    ] {
        let grid = quantize(
            &img,
            &palette,
            &Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
            None,
        );
        let peak = natural_peak(&grid, None);
        assert!(
            peak > 3,
            "{pname}: probe too flat to stress the cap ({peak})"
        );

        let (same, r0) = apply_height_cap(&grid, &d, &all, None, peak);
        assert_eq!(
            same.cells, grid.cells,
            "{pname}: cap at the peak is a no-op"
        );
        assert_eq!(r0.edited_cells, 0);

        let base_err = compare(&img, &grid_to_linear(&grid, &palette), view).scielab_mean;
        let mut last_err = base_err;
        let ladder: Vec<u32> = (0..=peak).rev().collect();
        for h in ladder {
            let (capped, report) = apply_height_cap(&grid, &d, &all, None, h);
            assert_eq!(report.infeasible_columns, 0, "{pname} H={h}");
            assert!(
                natural_peak(&capped, None) <= h,
                "{pname}: cap {h} not honored"
            );
            for (a, b) in capped.cells.iter().zip(grid.cells.iter()) {
                match (a, b) {
                    (Some((ca, _)), Some((cb, _))) => {
                        assert_eq!(ca, cb, "{pname} H={h}: color changed")
                    }
                    (None, None) => {}
                    _ => panic!("{pname} H={h}: transparency changed"),
                }
            }
            let err = compare(&img, &grid_to_linear(&capped, &palette), view).scielab_mean;
            assert!(
                err >= last_err - 0.35,
                "{pname}: quality got better as the cap tightened? H={h}: {err} vs {last_err}"
            );
            if h == 0 {
                assert!(
                    capped
                        .cells
                        .iter()
                        .flatten()
                        .all(|(_, t)| *t == Tone::Normal),
                    "{pname}: H=0 is flat"
                );
                assert!(
                    err > base_err,
                    "{pname}: flattening a staircased picture must cost quality"
                );
            }
            last_err = err.max(last_err);
        }
    }
}

#[test]
#[ignore = "report, not an assertion: cargo test --release -p arachne-core --test bench height_cap_table -- --ignored --nocapture"]
fn height_cap_table() {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../data/blocks-26.2.json"
    ))
    .unwrap();
    let d = BlockData::from_json(&json).unwrap();
    let (_d2, palette) = full_palette();
    let all = [Tone::Dark, Tone::Normal, Tone::Light];
    let view = Viewing::framed(5.0);
    for (pname, img) in [
        ("sky_gradient", build(sky_gradient)),
        ("skin_band", build(skin_band)),
        ("lightness_ramp_saturated", build(lightness_ramp_saturated)),
    ] {
        let grid = quantize(
            &img,
            &palette,
            &Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
            None,
        );
        let peak = natural_peak(&grid, None);
        let base = compare(&img, &grid_to_linear(&grid, &palette), view).scielab_mean;
        println!("\n{pname}: natural peak {peak}, base dE {base:.3}");
        println!(
            "  {:>4} {:>8} {:>8} {:>7} {:>7}",
            "H", "dE", "vs base", "edits", "cols"
        );
        for h in (0..=peak).rev() {
            let (capped, r) = apply_height_cap(&grid, &d, &all, None, h);
            let err = compare(&img, &grid_to_linear(&capped, &palette), view).scielab_mean;
            println!(
                "  {:>4} {:>8.3} {:>+7.1}% {:>7} {:>7}",
                h,
                err,
                (err / base - 1.0) * 100.0,
                r.edited_cells,
                r.edited_columns
            );
        }
    }
}

#[test]
fn dithering_beats_flat_matching_on_smooth_gradients() {
    let (_d, palette) = full_palette();
    let view = Viewing::framed(5.0);
    for (name, img) in [
        ("sky_gradient", build(sky_gradient)),
        ("neutral_ramp_full", build(neutral_ramp_full)),
        ("lightness_ramp_saturated", build(lightness_ramp_saturated)),
    ] {
        let flat = score(&img, &palette, &Dither::None, view);
        let fs = score(
            &img,
            &palette,
            &Dither::Diffusion {
                kernel: FLOYD_STEINBERG,
                serpentine: true,
            },
            view,
        );
        assert!(
            fs.scielab_mean < flat.scielab_mean,
            "{name}: diffusion {} should beat flat {}",
            fs.scielab_mean,
            flat.scielab_mean
        );
    }
}

#[test]
fn yliluoma_wins_the_corpus_mean_against_plain_ordered() {
    let (_d, palette) = full_palette();
    let view = Viewing::framed(5.0);
    let yl = Dither::Yliluoma {
        matrix: bayer4(),
        candidates: YLILUOMA_CANDIDATES,
        levels: None,
    };
    let mut ordered_sum = 0.0f32;
    let mut yliluoma_sum = 0.0f32;
    for (_name, img) in probes() {
        ordered_sum += score(&img, &palette, &Dither::Ordered(bayer4()), view).scielab_mean;
        yliluoma_sum += score(&img, &palette, &yl, view).scielab_mean;
    }
    assert!(
        yliluoma_sum < ordered_sum,
        "yliluoma corpus mean {} should beat plain ordered {}",
        yliluoma_sum,
        ordered_sum
    );
}

#[test]
fn plain_ordered_holds_a_two_tone_edge_at_least_as_well_as_mixing() {
    let (_d, palette) = full_palette();
    let view = Viewing::framed(5.0);
    let yl = Dither::Yliluoma {
        matrix: bayer4(),
        candidates: YLILUOMA_CANDIDATES,
        levels: None,
    };
    let img = build(two_tone_edge);
    let ordered = score(&img, &palette, &Dither::Ordered(bayer4()), view);
    let mixed = score(&img, &palette, &yl, view);
    assert!(
        ordered.scielab_mean <= mixed.scielab_mean,
        "hard edges are where snapping should win: ordered {} vs yliluoma {}",
        ordered.scielab_mean,
        mixed.scielab_mean
    );
}

#[test]
fn dbs_improves_the_distance_it_optimizes_for_and_costs_the_others() {
    let (_d, palette) = full_palette();
    let target = Viewing::framed(5.0);
    let cfg = DbsConfig::default();
    let yl = Dither::Yliluoma {
        matrix: bayer4(),
        candidates: YLILUOMA_CANDIDATES,
        levels: None,
    };
    let (mut won, mut lost) = (0, 0);
    for (_name, img) in probes() {
        let base = score(&img, &palette, &yl, target);
        let dbs = score_mode(&img, &palette, &yl, Some(&cfg), target);
        if dbs.scielab_mean < base.scielab_mean {
            won += 1;
        }
        let close = Viewing::framed(1.0);
        if score_mode(&img, &palette, &yl, Some(&cfg), close).scielab_mean
            > score(&img, &palette, &yl, close).scielab_mean
        {
            lost += 1;
        }
    }
    assert!(
        won >= 6,
        "DBS should win most probes at its target: {won}/8"
    );
    assert!(
        lost >= 1,
        "DBS tuned for one distance is expected to cost others; none regressed, \
         which means the viewing condition is not actually driving the search"
    );
}

#[test]
fn exact_palette_colors_are_left_alone() {
    let (_d, palette) = full_palette();
    let img = exact_swatches(&palette);
    let view = Viewing::framed(5.0);
    let flat = score(&img, &palette, &Dither::None, view);
    assert!(
        flat.scielab_mean < 0.5,
        "flat matching should be near-exact, got {}",
        flat.scielab_mean
    );
    for (name, dither, dbs) in configs() {
        let r = score_mode(&img, &palette, &dither, dbs.as_ref(), view);
        assert!(
            r.scielab_mean < 4.0,
            "{name} disturbed exact swatches: {}",
            r.scielab_mean
        );
    }
}

#[test]
fn the_measure_detects_the_neutral_gray_cyan_defect() {
    let (_d, palette) = full_palette();
    let view = Viewing::framed(1.0);
    let img = build(neutral_ramp_tight);
    let unbounded = quantize_without_drift_limit(&img, &palette, view);
    let bounded = score(
        &img,
        &palette,
        &Dither::Diffusion {
            kernel: FLOYD_STEINBERG,
            serpentine: false,
        },
        view,
    );
    assert!(
        unbounded.chroma_speckle > bounded.chroma_speckle * 1.5,
        "speckle must separate the defect ({}) from the fix ({})",
        unbounded.chroma_speckle,
        bounded.chroma_speckle
    );
}

#[test]
fn the_cyan_defect_is_invisible_from_across_the_room() {
    let (_d, palette) = full_palette();
    let view = Viewing::framed(5.0);
    let img = build(neutral_ramp_tight);
    let unbounded = quantize_without_drift_limit(&img, &palette, view);
    let bounded = score(
        &img,
        &palette,
        &Dither::Diffusion {
            kernel: FLOYD_STEINBERG,
            serpentine: false,
        },
        view,
    );
    let ratio = unbounded.chroma_speckle / bounded.chroma_speckle;
    assert!(
        (0.8..1.25).contains(&ratio),
        "chroma CSF should erase the defect at wall distance, ratio {ratio}"
    );
}

fn quantize_without_drift_limit(img: &LinImage, palette: &Palette, view: Viewing) -> Report {
    let (w, h) = (img.width, img.height);
    let mut buf: Vec<[f32; 3]> = img.pixels.iter().map(|p| [p[0], p[1], p[2]]).collect();
    let mut out = Vec::with_capacity(w * h);
    let k = FLOYD_STEINBERG;
    for z in 0..h {
        for x in 0..w {
            let old = buf[z * w + x].map(|c| c.clamp(0.0, 1.0));
            let e = palette.nearest(old);
            out.push([e.linear[0], e.linear[1], e.linear[2], 1.0]);
            let err = [
                old[0] - e.linear[0],
                old[1] - e.linear[1],
                old[2] - e.linear[2],
            ];
            for (dz, row) in k.rows.iter().enumerate() {
                for (ci, &wgt) in row.iter().enumerate() {
                    if wgt == 0.0 {
                        continue;
                    }
                    let nx = x as isize + ci as isize - 2;
                    let nz = z + dz;
                    if nz >= h || nx < 0 || nx as usize >= w {
                        continue;
                    }
                    let t = &mut buf[nz * w + nx as usize];
                    for (tc, ec) in t.iter_mut().zip(err.iter()) {
                        *tc += ec * wgt / k.divisor;
                    }
                }
            }
        }
    }
    compare(
        img,
        &LinImage {
            width: w,
            height: h,
            pixels: out,
        },
        view,
    )
}
