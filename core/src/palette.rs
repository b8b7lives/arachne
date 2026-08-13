use crate::color::{LinRgb, OkLab, linear_to_oklab, oklab_dist2, srgb_to_linear};
use crate::data::BlockData;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Dark,
    Normal,
    Light,
    Unobtainable,
}

impl Tone {
    pub fn mapdat_offset(self) -> u8 {
        match self {
            Tone::Dark => 0,
            Tone::Normal => 1,
            Tone::Light => 2,
            Tone::Unobtainable => 3,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PaletteEntry {
    pub color_id: u8,
    pub tone: Tone,
    pub srgb: [u8; 3],
    pub linear: LinRgb,
    pub oklab: OkLab,
}

#[derive(Debug, Clone)]
pub struct Palette {
    pub entries: Vec<PaletteEntry>,
}

impl Palette {
    pub fn build(data: &BlockData, enabled_color_ids: &[u8], tones: &[Tone]) -> Self {
        let mut entries = Vec::new();
        for &cid in enabled_color_ids {
            let c = data.color(cid).expect("enabled color id exists");
            for &tone in tones {
                let srgb = match tone {
                    Tone::Dark => c.tones.dark,
                    Tone::Normal => c.tones.normal,
                    Tone::Light => c.tones.light,
                    Tone::Unobtainable => c.tones.unobtainable,
                };
                let linear = srgb_to_linear(srgb);
                entries.push(PaletteEntry {
                    color_id: cid,
                    tone,
                    srgb,
                    linear,
                    oklab: linear_to_oklab(linear),
                });
            }
        }
        Self { entries }
    }

    pub fn nearest(&self, lin: LinRgb) -> &PaletteEntry {
        let lab = linear_to_oklab(lin);
        self.entries
            .iter()
            .min_by(|a, b| {
                oklab_dist2(a.oklab, lab)
                    .partial_cmp(&oklab_dist2(b.oklab, lab))
                    .expect("finite distances")
            })
            .expect("non-empty palette")
    }

    pub fn nearest2(&self, lin: LinRgb) -> ((&PaletteEntry, f32), (&PaletteEntry, f32)) {
        let lab = linear_to_oklab(lin);
        let mut best: Option<(usize, f32)> = None;
        let mut second: Option<(usize, f32)> = None;
        for (i, e) in self.entries.iter().enumerate() {
            let d = oklab_dist2(e.oklab, lab);
            match best {
                None => best = Some((i, d)),
                Some((_, bd)) if d < bd => {
                    second = best;
                    best = Some((i, d));
                }
                _ => match second {
                    None => second = Some((i, d)),
                    Some((_, sd)) if d < sd => second = Some((i, d)),
                    _ => {}
                },
            }
        }
        let (bi, bd) = best.expect("non-empty palette");
        let (si, sd) = second.unwrap_or((bi, bd));
        ((&self.entries[bi], bd), (&self.entries[si], sd))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    #[test]
    fn build_counts() {
        let d = data();
        let all: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let p = Palette::build(&d, &all, &[Tone::Dark, Tone::Normal, Tone::Light]);
        assert_eq!(p.entries.len(), 61 * 3);
    }

    #[test]
    fn nearest_exact_match_is_identity() {
        let d = data();
        let all: Vec<u8> = d.colors.iter().map(|c| c.id).collect();
        let p = Palette::build(&d, &all, &[Tone::Dark, Tone::Normal, Tone::Light]);
        for e in &p.entries {
            let n = p.nearest(e.linear);
            assert_eq!((n.color_id, n.tone), (e.color_id, e.tone));
        }
    }
}
