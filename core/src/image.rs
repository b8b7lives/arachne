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
        assert!(out_w > 0 && out_h > 0);
        let sx = self.width as f64 / out_w as f64;
        let sy = self.height as f64 / out_h as f64;
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
                let iy1 = (y1.ceil() as usize).min(self.height);
                let ix0 = x0.floor() as usize;
                let ix1 = (x1.ceil() as usize).min(self.width);
                for iy in iy0..iy1 {
                    let wy = (y1.min((iy + 1) as f64) - y0.max(iy as f64)).max(0.0);
                    for ix in ix0..ix1 {
                        let wx = (x1.min((ix + 1) as f64) - x0.max(ix as f64)).max(0.0);
                        let w = wx * wy;
                        let p = self.pixel(ix, iy);
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
}

impl LinImage {
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
        assert!((p[0] - 1.0).abs() < 1e-6, "red polluted by transparent black: {p:?}");
        assert!(p[1].abs() < 1e-6 && p[2].abs() < 1e-6);
        assert!((p[3] - 0.5).abs() < 1e-6, "alpha should still average: {p:?}");
    }

    #[test]
    fn resize_of_fully_transparent_region_stays_empty() {
        let data = [200u8, 150, 90, 0, 30, 60, 90, 0];
        let img = LinImage::from_srgb_rgba(2, 1, &data);
        let out = img.resize_area(1, 1);
        assert_eq!(out.pixels[0][3], 0.0);
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
