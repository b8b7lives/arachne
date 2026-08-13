use crate::color::{linear_to_oklab, oklab_to_linear};
use crate::image::LinImage;
use serde::Deserialize;

const PIVOT: f32 = 0.5;
const TEMP_SCALE: f32 = 0.08;
const TINT_SCALE: f32 = 0.06;
const BRIGHT_SCALE: f32 = 0.5;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Adjust {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
}

impl Default for Adjust {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 1.0,
            temperature: 0.0,
            tint: 0.0,
        }
    }
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        self.brightness == 0.0
            && self.contrast == 0.0
            && (self.saturation - 1.0).abs() < f32::EPSILON
            && self.temperature == 0.0
            && self.tint == 0.0
    }

    fn contrast_gain(&self) -> f32 {
        4.0f32.powf(self.contrast.clamp(-1.0, 1.0))
    }

    pub fn pixel(&self, rgb: [f32; 3]) -> [f32; 3] {
        let [mut l, mut a, mut b] = linear_to_oklab(rgb);

        a += self.tint.clamp(-1.0, 1.0) * TINT_SCALE;
        b += self.temperature.clamp(-1.0, 1.0) * TEMP_SCALE;

        l += self.brightness.clamp(-1.0, 1.0) * BRIGHT_SCALE;
        l = PIVOT + (l - PIVOT) * self.contrast_gain();

        let s = self.saturation.max(0.0);
        a *= s;
        b *= s;

        to_gamut(l.clamp(0.0, 1.0), a, b)
    }
}

fn in_gamut(rgb: [f32; 3]) -> bool {
    rgb.iter().all(|c| (-1e-4..=1.0 + 1e-4).contains(c))
}

pub fn to_gamut(l: f32, a: f32, b: f32) -> [f32; 3] {
    let direct = oklab_to_linear([l, a, b]);
    if in_gamut(direct) {
        return direct.map(|c| c.clamp(0.0, 1.0));
    }
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..16 {
        let mid = 0.5 * (lo + hi);
        if in_gamut(oklab_to_linear([l, a * mid, b * mid])) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    oklab_to_linear([l, a * lo, b * lo]).map(|c| c.clamp(0.0, 1.0))
}

pub fn apply(img: &mut LinImage, adj: &Adjust) {
    if adj.is_identity() {
        return;
    }
    for p in img.pixels.iter_mut() {
        let out = adj.pixel([p[0], p[1], p[2]]);
        p[0] = out[0];
        p[1] = out[1];
        p[2] = out[2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::{linear_to_oklab, srgb_to_linear};

    fn lab(rgb: [u8; 3], adj: &Adjust) -> [f32; 3] {
        linear_to_oklab(adj.pixel(srgb_to_linear(rgb)))
    }

    #[test]
    fn defaults_change_nothing() {
        let adj = Adjust::default();
        assert!(adj.is_identity());
        for rgb in [[0u8, 0, 0], [255, 255, 255], [37, 150, 190], [200, 40, 90]] {
            let before = srgb_to_linear(rgb);
            let after = adj.pixel(before);
            for (a, b) in before.iter().zip(after.iter()) {
                assert!((a - b).abs() < 1e-4, "{rgb:?}: {before:?} -> {after:?}");
            }
        }
    }

    #[test]
    fn saturation_preserves_hue() {
        for rgb in [[200u8, 40, 90], [37, 150, 190], [90, 170, 40]] {
            let base = lab(rgb, &Adjust::default());
            let hue = base[2].atan2(base[1]);
            for s in [0.25f32, 0.5, 1.5, 2.0] {
                let adj = Adjust {
                    saturation: s,
                    ..Adjust::default()
                };
                let out = lab(rgb, &adj);
                let h = out[2].atan2(out[1]);
                assert!(
                    (h - hue).abs() < 0.02,
                    "{rgb:?} at saturation {s}: hue {hue} -> {h}"
                );
            }
        }
    }

    #[test]
    fn zero_saturation_leaves_no_color() {
        let adj = Adjust {
            saturation: 0.0,
            ..Adjust::default()
        };
        for rgb in [[200u8, 40, 90], [37, 150, 190]] {
            let out = adj.pixel(srgb_to_linear(rgb));
            let hi = out.iter().cloned().fold(f32::MIN, f32::max);
            let lo = out.iter().cloned().fold(f32::MAX, f32::min);
            assert!(hi - lo < 0.02, "{rgb:?} -> {out:?}");
        }
    }

    #[test]
    fn temperature_moves_along_blue_yellow_only() {
        let neutral = [128u8, 128, 128];
        let base = lab(neutral, &Adjust::default());
        for (t, warmer) in [(0.5f32, true), (-0.5, false)] {
            let adj = Adjust {
                temperature: t,
                ..Adjust::default()
            };
            let out = lab(neutral, &adj);
            assert!((out[1] - base[1]).abs() < 0.01, "tint drifted: {out:?}");
            if warmer {
                assert!(out[2] > base[2] + 0.01, "warm should raise b: {out:?}");
            } else {
                assert!(out[2] < base[2] - 0.01, "cool should lower b: {out:?}");
            }
        }
    }

    #[test]
    fn tint_moves_along_green_magenta_only() {
        let neutral = [128u8, 128, 128];
        let base = lab(neutral, &Adjust::default());
        let adj = Adjust {
            tint: 0.5,
            ..Adjust::default()
        };
        let out = lab(neutral, &adj);
        assert!(out[1] > base[1] + 0.01, "tint should raise a: {out:?}");
        assert!(
            (out[2] - base[2]).abs() < 0.01,
            "temperature drifted: {out:?}"
        );
    }

    #[test]
    fn brightness_is_monotonic() {
        let mut last = -1.0f32;
        for v in [-1.0f32, -0.5, 0.0, 0.5, 1.0] {
            let adj = Adjust {
                brightness: v,
                ..Adjust::default()
            };
            let l = lab([128, 128, 128], &adj)[0];
            assert!(l >= last, "brightness {v} lowered L");
            last = l;
        }
    }

    #[test]
    fn contrast_spreads_around_the_pivot() {
        let adj = Adjust {
            contrast: 0.5,
            ..Adjust::default()
        };
        let dark = lab([60, 60, 60], &adj)[0];
        let light = lab([200, 200, 200], &adj)[0];
        let dark0 = lab([60, 60, 60], &Adjust::default())[0];
        let light0 = lab([200, 200, 200], &Adjust::default())[0];
        assert!(dark < dark0, "darks should darken: {dark} vs {dark0}");
        assert!(light > light0, "lights should lighten: {light} vs {light0}");
    }

    #[test]
    fn contrast_is_symmetric_in_gain() {
        for c in [0.25f32, 0.5, 1.0] {
            let up = Adjust {
                contrast: c,
                ..Adjust::default()
            };
            let down = Adjust {
                contrast: -c,
                ..Adjust::default()
            };
            let l0 = lab([128, 128, 128], &Adjust::default())[0];
            let spread_up = (lab([128, 128, 128], &up)[0] - PIVOT) / (l0 - PIVOT);
            let spread_down = (lab([128, 128, 128], &down)[0] - PIVOT) / (l0 - PIVOT);
            assert!(
                (spread_up * spread_down - 1.0).abs() < 1e-3,
                "contrast {c}: gains {spread_up} and {spread_down} are not reciprocal"
            );
        }
    }

    #[test]
    fn output_stays_in_gamut() {
        let adj = Adjust {
            brightness: 1.0,
            contrast: 1.0,
            saturation: 2.0,
            temperature: 1.0,
            tint: 1.0,
        };
        for r in (0..=255).step_by(51) {
            for g in (0..=255).step_by(51) {
                for b in (0..=255).step_by(51) {
                    let out = adj.pixel(srgb_to_linear([r as u8, g as u8, b as u8]));
                    for c in out {
                        assert!((0.0..=1.0).contains(&c), "out of gamut: {out:?}");
                    }
                }
            }
        }
    }
}
