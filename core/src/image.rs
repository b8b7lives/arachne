use crate::color::srgb_channel_to_linear;

#[derive(Debug, Clone)]
pub struct LinImage {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<[f32; 4]>,
}

impl LinImage {
    pub fn from_srgb_rgba(width: usize, height: usize, data: &[u8]) -> Self {
        assert_eq!(data.len(), width * height * 4, "RGBA buffer size");
        let pixels = data
            .chunks_exact(4)
            .map(|p| {
                [
                    srgb_channel_to_linear(p[0]),
                    srgb_channel_to_linear(p[1]),
                    srgb_channel_to_linear(p[2]),
                    f32::from(p[3]) / 255.0,
                ]
            })
            .collect();
        Self {
            width,
            height,
            pixels,
        }
    }

    pub fn pixel(&self, x: usize, y: usize) -> [f32; 4] {
        self.pixels[y * self.width + x]
    }

    pub fn resize_area(&self, out_w: usize, out_h: usize) -> LinImage {
        area_resample(self.width, self.height, out_w, out_h, |x, y| {
            self.pixel(x, y)
        })
    }

    pub fn resize_area_from_srgb(
        data: &[u8],
        width: usize,
        height: usize,
        out_w: usize,
        out_h: usize,
    ) -> LinImage {
        assert_eq!(data.len(), width * height * 4, "RGBA buffer size");
        let mut lut = [0.0f32; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = srgb_channel_to_linear(i as u8);
        }
        area_resample(width, height, out_w, out_h, |x, y| {
            let i = (y * width + x) * 4;
            [
                lut[data[i] as usize],
                lut[data[i + 1] as usize],
                lut[data[i + 2] as usize],
                f32::from(data[i + 3]) / 255.0,
            ]
        })
    }
}

fn area_resample<F: Fn(usize, usize) -> [f32; 4]>(
    in_w: usize,
    in_h: usize,
    out_w: usize,
    out_h: usize,
    get: F,
) -> LinImage {
    assert!(out_w > 0 && out_h > 0);
    let sx = in_w as f64 / out_w as f64;
    let sy = in_h as f64 / out_h as f64;
    let mut pixels = Vec::with_capacity(out_w * out_h);
    for oy in 0..out_h {
        let y0 = oy as f64 * sy;
        let y1 = (oy + 1) as f64 * sy;
        for ox in 0..out_w {
            let x0 = ox as f64 * sx;
            let x1 = (ox + 1) as f64 * sx;
            let mut acc = [0.0f64; 3];
            let mut acc_a = 0.0f64;
            let mut area = 0.0f64;
            let iy0 = y0.floor() as usize;
            let iy1 = (y1.ceil() as usize).min(in_h);
            let ix0 = x0.floor() as usize;
            let ix1 = (x1.ceil() as usize).min(in_w);
            for iy in iy0..iy1 {
                let wy = (y1.min((iy + 1) as f64) - y0.max(iy as f64)).max(0.0);
                for ix in ix0..ix1 {
                    let wx = (x1.min((ix + 1) as f64) - x0.max(ix as f64)).max(0.0);
                    let w = wx * wy;
                    let p = get(ix, iy);
                    let wa = w * f64::from(p[3]);
                    for (a, c) in acc.iter_mut().zip(p.iter()) {
                        *a += f64::from(*c) * wa;
                    }
                    acc_a += wa;
                    area += w;
                }
            }
            let rgb = if acc_a > 0.0 {
                acc.map(|a| (a / acc_a) as f32)
            } else {
                [0.0; 3]
            };
            pixels.push([rgb[0], rgb[1], rgb[2], (acc_a / area) as f32]);
        }
    }
    LinImage {
        width: out_w,
        height: out_h,
        pixels,
    }
}

impl LinImage {
    /// Draws an sRGB RGBA overlay of the same size over this image with
    /// straight-alpha "over" compositing in linear light. Fully transparent
    /// overlay pixels leave the image untouched; an opaque overlay pixel
    /// replaces the color and makes the cell opaque even where the image had
    /// a hole.
    pub fn composite_overlay(&mut self, overlay: &[u8]) {
        assert_eq!(
            overlay.len(),
            self.width * self.height * 4,
            "overlay buffer size"
        );
        for (p, o) in self.pixels.iter_mut().zip(overlay.chunks_exact(4)) {
            let a = f32::from(o[3]) / 255.0;
            if a <= 0.0 {
                continue;
            }
            let oc = [
                srgb_channel_to_linear(o[0]),
                srgb_channel_to_linear(o[1]),
                srgb_channel_to_linear(o[2]),
            ];
            let pa = p[3].clamp(0.0, 1.0);
            let out_a = a + pa * (1.0 - a);
            for c in 0..3 {
                p[c] = (oc[c] * a + p[c] * pa * (1.0 - a)) / out_a;
            }
            p[3] = out_a;
        }
    }

    pub fn composite_over(&mut self, bg: [f32; 3]) {
        for p in self.pixels.iter_mut() {
            let a = p[3].clamp(0.0, 1.0);
            if a >= 1.0 {
                continue;
            }
            for c in 0..3 {
                p[c] = p[c] * a + bg[c] * (1.0 - a);
            }
            p[3] = 1.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_preserves_flat_color() {
        let data: Vec<u8> = std::iter::repeat_n([10u8, 200, 30, 255], 64 * 48)
            .flatten()
            .collect();
        let img = LinImage::from_srgb_rgba(64, 48, &data);
        let out = img.resize_area(7, 5);
        let expect = img.pixel(0, 0);
        for p in &out.pixels {
            for (a, b) in p.iter().zip(expect.iter()) {
                assert!((a - b).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn resize_ignores_the_color_of_transparent_pixels() {
        let data = [255u8, 0, 0, 255, 0, 0, 0, 0];
        let img = LinImage::from_srgb_rgba(2, 1, &data);
        let out = img.resize_area(1, 1);
        let p = out.pixels[0];
        assert!(
            (p[0] - 1.0).abs() < 1e-6,
            "red polluted by transparent black: {p:?}"
        );
        assert!(p[1].abs() < 1e-6 && p[2].abs() < 1e-6);
        assert!(
            (p[3] - 0.5).abs() < 1e-6,
            "alpha should still average: {p:?}"
        );
    }

    #[test]
    fn overlay_replaces_where_opaque_and_leaves_the_rest() {
        let base: Vec<u8> = std::iter::repeat_n([100u8, 100, 100, 255], 4)
            .flatten()
            .collect();
        let mut img = LinImage::from_srgb_rgba(2, 2, &base);
        img.pixels[3] = [0.0, 0.0, 0.0, 0.0];
        let overlay = [
            255u8, 0, 0, 255, // opaque red over gray
            0, 0, 0, 0, // untouched
            0, 0, 255, 128, // half blue over gray
            0, 255, 0, 255, // opaque green over a hole
        ];
        img.composite_overlay(&overlay);
        assert_eq!(img.pixels[0], [1.0, 0.0, 0.0, 1.0]);
        let gray = srgb_channel_to_linear(100);
        assert_eq!(img.pixels[1], [gray, gray, gray, 1.0]);
        assert!(
            img.pixels[2][2] > gray && img.pixels[2][0] < gray,
            "half blue tints the gray"
        );
        assert!((img.pixels[2][3] - 1.0).abs() < 1e-6);
        assert_eq!(img.pixels[3], [0.0, 1.0, 0.0, 1.0], "text fills a hole");
    }

    #[test]
    fn resize_of_fully_transparent_region_stays_empty() {
        let data = [200u8, 150, 90, 0, 30, 60, 90, 0];
        let img = LinImage::from_srgb_rgba(2, 1, &data);
        let out = img.resize_area(1, 1);
        assert_eq!(out.pixels[0][3], 0.0);
    }

    #[test]
    fn streaming_resize_matches_the_two_step_path() {
        let mut data = Vec::with_capacity(37 * 23 * 4);
        let mut seed = 0x1234_5678u32;
        for _ in 0..37 * 23 * 4 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            data.push((seed >> 24) as u8);
        }
        for (ow, oh) in [(5, 7), (37, 23), (64, 40), (13, 13)] {
            let two_step = LinImage::from_srgb_rgba(37, 23, &data).resize_area(ow, oh);
            let streamed = LinImage::resize_area_from_srgb(&data, 37, 23, ow, oh);
            for (a, b) in streamed.pixels.iter().zip(two_step.pixels.iter()) {
                for (x, y) in a.iter().zip(b.iter()) {
                    assert!((x - y).abs() < 1e-6, "{a:?} vs {b:?} at {ow}x{oh}");
                }
            }
        }
    }

    #[test]
    fn resize_averages_in_linear_light() {
        let data = [0u8, 0, 0, 255, 255, 255, 255, 255];
        let img = LinImage::from_srgb_rgba(2, 1, &data);
        let out = img.resize_area(1, 1);
        assert!((out.pixels[0][0] - 0.5).abs() < 1e-6);
        assert_eq!(crate::color::linear_channel_to_srgb(out.pixels[0][0]), 188);
    }
}
