use crate::color::{linear_to_oklab, oklab_dist2};
use crate::image::LinImage;
use crate::palette::Palette;
use crate::quantize::Transparency;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MarginalErrors {
    pub total: f64,
    pub per_color: Vec<(u8, f64)>,
}

pub fn marginal_errors(
    img: &LinImage,
    palette: &Palette,
    transparency: Option<Transparency>,
) -> MarginalErrors {
    let mut ids: Vec<u8> = palette.entries.iter().map(|e| e.color_id).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut delta: Vec<(u8, f64)> = ids.into_iter().map(|c| (c, 0.0)).collect();
    let mut total = 0.0f64;

    let transparent_at = |p: [f32; 4]| transparency.is_some_and(|t| p[3] < t.threshold);
    for z in 0..img.height {
        for x in 0..img.width {
            let p = img.pixel(x, z);
            if transparent_at(p) {
                continue;
            }
            let q = match transparency {
                Some(t) if z > 0 && transparent_at(img.pixel(x, z - 1)) => t.edge,
                _ => palette,
            };
            let lab = linear_to_oklab([p[0], p[1], p[2]]);
            let mut best: Option<(f32, u8)> = None;
            let mut alt: Option<f32> = None;
            for e in &q.entries {
                let d = oklab_dist2(e.oklab, lab);
                match best {
                    None => best = Some((d, e.color_id)),
                    Some((bd, bc)) => {
                        if d < bd {
                            if e.color_id != bc {
                                alt = Some(bd);
                            }
                            best = Some((d, e.color_id));
                        } else if e.color_id != bc && alt.is_none_or(|a| d < a) {
                            alt = Some(d);
                        }
                    }
                }
            }
            let (bd, bc) = best.expect("non-empty palette");
            total += f64::from(bd);
            let added = alt.map_or(f64::INFINITY, |a| f64::from(a - bd));
            delta
                .iter_mut()
                .find(|(c, _)| *c == bc)
                .expect("best color is enabled")
                .1 += added;
        }
    }
    MarginalErrors {
        total,
        per_color: delta,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::BlockData;
    use crate::palette::Tone;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    fn img_of(pixels: &[[u8; 3]], w: usize) -> LinImage {
        let data: Vec<u8> = pixels
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect();
        LinImage::from_srgb_rgba(w, pixels.len() / w, &data)
    }

    #[test]
    fn exact_pixels_have_zero_total_and_positive_drop_cost() {
        let d = data();
        let p = Palette::build(&d, &[8, 29], &[Tone::Normal]);
        let white = d.color(8).unwrap().tones.normal;
        let black = d.color(29).unwrap().tones.normal;
        let img = img_of(&[white, white, black, white], 2);
        let m = marginal_errors(&img, &p, None);
        assert_eq!(m.total, 0.0);
        let get = |c: u8| m.per_color.iter().find(|(x, _)| *x == c).unwrap().1;
        assert!(get(8) > 0.0 && get(29) > 0.0);
        let ratio = get(8) / get(29);
        assert!((ratio - 3.0).abs() < 1e-6, "ratio {ratio}");
    }

    #[test]
    fn unused_set_has_zero_delta() {
        let d = data();
        let p = Palette::build(&d, &[8, 29, 28], &[Tone::Normal]);
        let white = d.color(8).unwrap().tones.normal;
        let img = img_of(&[white, white], 2);
        let m = marginal_errors(&img, &p, None);
        for (c, v) in &m.per_color {
            if *c == 8 {
                assert!(*v > 0.0);
            } else {
                assert_eq!(*v, 0.0, "set {c} never chosen");
            }
        }
    }

    #[test]
    fn single_set_palette_is_infinite_to_drop() {
        let d = data();
        let p = Palette::build(&d, &[8], &[Tone::Normal]);
        let img = img_of(&[[10, 10, 10]], 1);
        let m = marginal_errors(&img, &p, None);
        assert!(m.total > 0.0);
        assert_eq!(m.per_color[0].1, f64::INFINITY);
    }

    #[test]
    fn an_edge_pixel_is_priced_within_the_light_palette() {
        let d = data();
        let p = Palette::build(&d, &[8, 29], &[Tone::Normal]);
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let dark = d.color(29).unwrap().tones.normal;
        let data_px = [dark[0], dark[1], dark[2], 0u8, dark[0], dark[1], dark[2], 255];
        let img = LinImage::from_srgb_rgba(1, 2, &data_px);
        let m = marginal_errors(
            &img,
            &p,
            Some(Transparency {
                threshold: 0.5,
                edge: &edge,
            }),
        );
        let want = {
            let lab = linear_to_oklab(crate::color::srgb_to_linear(dark));
            edge.entries
                .iter()
                .map(|e| oklab_dist2(e.oklab, lab))
                .fold(f32::INFINITY, f32::min)
        };
        assert!(
            (m.total - f64::from(want)).abs() < 1e-9,
            "edge pixel must be priced against the light tones it will render: \
             {} vs {want}",
            m.total
        );
        let loose = marginal_errors(&img, &p, None);
        assert!(m.total > loose.total, "the constraint must cost something");
    }

    #[test]
    fn a_pixel_on_the_north_border_stays_unconstrained() {
        let d = data();
        let p = Palette::build(&d, &[8, 29], &[Tone::Normal]);
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let dark = d.color(29).unwrap().tones.normal;
        let img = img_of(&[dark], 1);
        let m = marginal_errors(
            &img,
            &p,
            Some(Transparency {
                threshold: 0.5,
                edge: &edge,
            }),
        );
        assert_eq!(m.total, 0.0, "row 0 has no north neighbor and is exact");
    }

    #[test]
    fn transparent_pixels_are_skipped() {
        let d = data();
        let p = Palette::build(&d, &[8, 29], &[Tone::Normal]);
        let edge = Palette::build(&d, &[8, 29], &[Tone::Light]);
        let img = LinImage::from_srgb_rgba(1, 1, &[10, 10, 10, 0]);
        let m = marginal_errors(
            &img,
            &p,
            Some(Transparency {
                threshold: 0.5,
                edge: &edge,
            }),
        );
        assert_eq!(m.total, 0.0);
        assert!(m.per_color.iter().all(|(_, v)| *v == 0.0));
    }
}
