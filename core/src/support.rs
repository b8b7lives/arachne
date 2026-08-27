use crate::palette::Tone;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportMode {
    None,
    Important,
    FullLayer,
}

#[derive(Debug, Clone, Copy)]
pub struct ColBlock {
    pub tone: Tone,
    pub mandatory: bool,
}

pub fn support_counts(col: &[ColBlock], mode: SupportMode) -> Vec<u32> {
    let n = col.len();
    assert!(n >= 1, "empty column");
    let mut out = vec![0u32; n + 1];
    match mode {
        SupportMode::None => {}
        SupportMode::Important => {
            for (i, b) in col.iter().enumerate() {
                if b.mandatory {
                    out[i + 1] = 1;
                }
            }
        }
        SupportMode::FullLayer => {
            for c in out.iter_mut() {
                *c = 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(tone: Tone, mandatory: bool) -> ColBlock {
        ColBlock { tone, mandatory }
    }
    use Tone::{Dark as D, Light as L, Normal as N};

    fn every_column() -> impl Iterator<Item = Vec<ColBlock>> {
        let tones = [N, D, L];
        (0..(3usize * 2).pow(5)).map(move |code| {
            let mut c = code;
            (0..5)
                .map(|_| {
                    let t = tones[c % 3];
                    c /= 3;
                    let m = c % 2 == 1;
                    c /= 2;
                    b(t, m)
                })
                .collect()
        })
    }

    #[test]
    fn none_mode_places_nothing() {
        for col in every_column() {
            assert!(support_counts(&col, SupportMode::None).iter().all(|&c| c == 0));
        }
    }

    #[test]
    fn important_is_exactly_one_under_each_mandatory_block() {
        for col in every_column() {
            let out = support_counts(&col, SupportMode::Important);
            assert_eq!(out[0], 0, "nothing under the anchor: {col:?}");
            for (i, blk) in col.iter().enumerate() {
                assert_eq!(out[i + 1], u32::from(blk.mandatory), "{col:?}");
            }
        }
    }

    #[test]
    fn tone_and_steps_never_add_filler() {
        let light_cliff = [b(L, false), b(D, false), b(D, false), b(L, false)];
        let out = support_counts(&light_cliff, SupportMode::Important);
        assert!(out.iter().all(|&c| c == 0), "{out:?}");
    }

    #[test]
    fn full_layer_is_one_under_every_position() {
        for col in every_column() {
            let out = support_counts(&col, SupportMode::FullLayer);
            assert_eq!(out.len(), col.len() + 1);
            assert!(out.iter().all(|&c| c == 1), "{col:?}");
        }
    }

    #[test]
    fn modes_are_monotone_in_cost() {
        for col in every_column() {
            let t = |m| -> u32 { support_counts(&col, m).iter().sum() };
            assert!(t(SupportMode::None) <= t(SupportMode::Important));
            assert!(t(SupportMode::Important) <= t(SupportMode::FullLayer));
        }
    }
}
