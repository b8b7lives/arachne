use arachne_core::adjust::to_gamut;
use arachne_core::dbs::{DbsConfig, refine};
use arachne_core::color::linear_to_srgb;
use arachne_core::data::BlockData;
use arachne_core::image::LinImage;
use arachne_core::metric::{Report, Viewing, compare, grid_to_linear};
use arachne_core::palette::{Palette, Tone};
use arachne_core::quantize::{
    ATKINSON, BURKES, Dither, FLOYD_STEINBERG, MIN_AVG_ERR, SIERRA_LITE, STUCKI,
    YLILUOMA_CANDIDATES, bayer2, bayer4, ordered3, quantize,
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
    if (x / 16 + z / 16).is_multiple_of(2) {
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
        ("ordered3", Dither::Ordered(ordered3())),
        (
            "yliluoma-b2",
            Dither::Yliluoma {
                matrix: bayer2(),
                candidates: YLILUOMA_CANDIDATES,
            },
        ),
        (
            "yliluoma-b4",
            Dither::Yliluoma {
                matrix: bayer4(),
                candidates: YLILUOMA_CANDIDATES,
            },
        ),
        (
            "yliluoma-o3",
            Dither::Yliluoma {
                matrix: ordered3(),
                candidates: YLILUOMA_CANDIDATES,
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
    println!("\n  corpus mean over {} probes, ranked by dE_mean", all.len());
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
    table("framed on a wall, 5 blocks back", Viewing::framed(5.0), &all, &palette, true);
    table("stood at the wall, 2 blocks", Viewing::framed(2.0), &all, &palette, false);
    table("nose on the frame, 1 block", Viewing::framed(1.0), &all, &palette, false);
    println!();
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
    assert!(won >= 6, "DBS should win most probes at its target: {won}/8");
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
