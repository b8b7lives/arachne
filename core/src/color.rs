pub type LinRgb = [f32; 3];
pub type OkLab = [f32; 3];

pub fn srgb_channel_to_linear(c: u8) -> f32 {
    let c = f32::from(c) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub fn linear_channel_to_srgb(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let s = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0).round() as u8
}

pub fn srgb_to_linear(rgb: [u8; 3]) -> LinRgb {
    rgb.map(srgb_channel_to_linear)
}

pub fn linear_to_srgb(rgb: LinRgb) -> [u8; 3] {
    rgb.map(linear_channel_to_srgb)
}

pub fn linear_to_oklab(rgb: LinRgb) -> OkLab {
    let [r, g, b] = rgb.map(|c| c.max(0.0));
    let l = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let l = l.cbrt();
    let m = m.cbrt();
    let s = s.cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

pub fn oklab_to_linear(lab: OkLab) -> LinRgb {
    let [ll, aa, bb] = lab;
    let l = ll + 0.396_337_78 * aa + 0.215_803_76 * bb;
    let m = ll - 0.105_561_346 * aa - 0.063_854_17 * bb;
    let s = ll - 0.089_484_18 * aa - 1.291_485_5 * bb;
    let l = l * l * l;
    let m = m * m * m;
    let s = s * s * s;
    [
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    ]
}

pub fn oklab_dist2(a: OkLab, b: OkLab) -> f32 {
    let d0 = a[0] - b[0];
    let d1 = a[1] - b[1];
    let d2 = a[2] - b[2];
    d0 * d0 + d1 * d1 + d2 * d2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_linear_round_trip() {
        for c in 0..=255u8 {
            assert_eq!(linear_channel_to_srgb(srgb_channel_to_linear(c)), c);
        }
    }

    #[test]
    fn oklab_reference_values() {
        let white = linear_to_oklab([1.0, 1.0, 1.0]);
        assert!((white[0] - 1.0).abs() < 1e-3, "{white:?}");
        assert!(white[1].abs() < 1e-3 && white[2].abs() < 1e-3, "{white:?}");
        let black = linear_to_oklab([0.0, 0.0, 0.0]);
        assert!(black[0].abs() < 1e-6);
    }

    #[test]
    fn oklab_orders_perceptually() {
        let g = linear_to_oklab(srgb_to_linear([128, 128, 128]));
        let lg = linear_to_oklab(srgb_to_linear([180, 180, 180]));
        let red = linear_to_oklab(srgb_to_linear([255, 0, 0]));
        assert!(oklab_dist2(g, lg) < oklab_dist2(g, red));
    }
}
