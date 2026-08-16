use crate::palette::Tone;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportMode {
    None,
    Important,
    AllOptimized,
    AllDoubleOptimized,
}

#[derive(Debug, Clone, Copy)]
pub struct ColBlock {
    pub tone: Tone,
    pub mandatory: bool,
}

pub fn support_counts(col: &[ColBlock], steps: &[i32], mode: SupportMode) -> Vec<u32> {
    let n = col.len();
    assert!(n >= 1, "empty column");
    assert_eq!(steps.len(), n, "one step per block");
    let mut out = vec![0u32; n + 1];
    let dark = |b: ColBlock| b.tone == Tone::Dark;
    let light = |b: ColBlock| b.tone == Tone::Light;
    let normal = |b: ColBlock| b.tone == Tone::Normal;
    let depth = |r: usize| steps[r].unsigned_abs().max(1);

    match mode {
        SupportMode::None => {}
        SupportMode::Important => {
            for (i, b) in col.iter().enumerate() {
                if b.mandatory {
                    out[i + 1] = 1;
                }
            }
        }
        SupportMode::AllOptimized => {
            for r in 0..n {
                let blk = col[r];
                if r == 0 {
                    let mut d = 0u32;
                    if dark(blk) {
                        d = d.max(depth(0));
                    }
                    if normal(blk) && blk.mandatory {
                        d = d.max(1);
                    }
                    out[0] += d;
                    if dark(blk) && blk.mandatory {
                        out[0] += 1;
                    }
                } else if r == 1 {
                    let b0 = col[0];
                    let mut d = 0u32;
                    if light(b0) {
                        d = d.max(depth(0));
                    }
                    if dark(blk) {
                        d = d.max(depth(1));
                    }
                    if b0.mandatory || (normal(blk) && blk.mandatory) {
                        d = d.max(1);
                    }
                    out[1] += d;
                    if dark(blk) && blk.mandatory {
                        out[1] += 1;
                    }
                } else {
                    let q = col[r - 1];
                    let north = col[r - 2];
                    let mut d = 0u32;
                    if light(q) {
                        d = d.max(depth(r - 1));
                    }
                    if dark(blk) {
                        d = d.max(depth(r));
                    }
                    if q.mandatory
                        || (normal(blk) && blk.mandatory)
                        || (normal(q) && north.mandatory)
                    {
                        d = d.max(1);
                    }
                    out[r] += d;
                    if (dark(blk) && blk.mandatory) || (light(q) && north.mandatory) {
                        out[r] += 1;
                    }
                }
                if r == n - 1 {
                    let north = if r == 0 {
                        ColBlock {
                            tone: Tone::Normal,
                            mandatory: false,
                        }
                    } else {
                        col[r - 1]
                    };
                    let mut d = 0u32;
                    if light(blk) {
                        d = d.max(depth(r));
                    }
                    if blk.mandatory || (normal(blk) && north.mandatory) {
                        d = d.max(1);
                    }
                    out[n] += d;
                    if light(blk) && north.mandatory {
                        out[n] += 1;
                    }
                }
            }
        }
        SupportMode::AllDoubleOptimized => {
            for r in 0..n {
                let blk = col[r];
                if r == 0 {
                    out[0] += 1;
                    if dark(blk) {
                        out[0] += depth(0);
                    }
                } else {
                    let q = col[r - 1];
                    out[r] += 1;
                    let mut d = 0u32;
                    if light(q) {
                        d = d.max(depth(r - 1));
                    }
                    if dark(blk) {
                        d = d.max(depth(r));
                    }
                    out[r] += d;
                }
                if r == n - 1 {
                    out[n] += 1;
                    if light(blk) {
                        out[n] += depth(r);
                    }
                }
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

    fn flat(n: usize) -> Vec<ColBlock> {
        vec![b(N, false); n]
    }

    fn unit_steps(col: &[ColBlock]) -> Vec<i32> {
        col.iter()
            .map(|c| match c.tone {
                Tone::Light => 1,
                Tone::Dark => -1,
                _ => 0,
            })
            .collect()
    }

    fn counts(col: &[ColBlock], mode: SupportMode) -> Vec<u32> {
        support_counts(col, &unit_steps(col), mode)
    }

    #[test]
    fn single_row_run_uses_the_anchor_as_its_north_neighbor() {
        for (tone, mandatory) in [(N, false), (D, false), (L, false), (N, true), (L, true)] {
            let single = counts(&[b(tone, mandatory)], SupportMode::AllOptimized);
            let with_plain_north = counts(
                &[b(N, false), b(tone, mandatory)],
                SupportMode::AllOptimized,
            );
            assert_eq!(
                single[1], with_plain_north[2],
                "row support differs for {tone:?}/{mandatory}"
            );
            assert_eq!(single.len(), 2);
        }
        assert_eq!(
            counts(&[b(N, true)], SupportMode::Important),
            vec![0, 1]
        );
        assert_eq!(
            counts(&[b(N, false)], SupportMode::Important),
            vec![0, 0]
        );
        let dd = counts(&[b(D, false)], SupportMode::AllDoubleOptimized);
        assert!(dd[0] >= 1 && dd[1] >= 1);
    }

    #[test]
    fn none_mode_places_nothing() {
        assert_eq!(counts(&flat(4), SupportMode::None), vec![0; 5]);
    }

    #[test]
    fn important_only_under_mandatory() {
        let mut col = flat(4);
        col[2].mandatory = true;
        assert_eq!(
            counts(&col, SupportMode::Important),
            vec![0, 0, 0, 1, 0]
        );
    }

    #[test]
    fn instance_1_light_tone_gets_support() {
        let col = [b(N, false), b(N, false), b(L, false), b(N, false)];
        let out = counts(&col, SupportMode::AllOptimized);
        assert_eq!(out, vec![0, 0, 0, 1, 0]);
    }

    #[test]
    fn instance_2_dark_south_neighbor() {
        let col = [b(N, false), b(N, false), b(D, false), b(N, false)];
        let out = counts(&col, SupportMode::AllOptimized);
        assert_eq!(out, vec![0, 0, 1, 0, 0]);
    }

    #[test]
    fn instance_3_gravity_block_flanked() {
        let col = [b(N, false), b(N, true), b(N, false), b(N, false)];
        let out = counts(&col, SupportMode::AllOptimized);
        assert_eq!(out, vec![0, 1, 1, 1, 0]);
    }

    #[test]
    fn instance_6_dark_gravity_needs_two_below_north() {
        let col = [b(N, false), b(D, true), b(N, false), b(N, false)];
        let out = counts(&col, SupportMode::AllOptimized);
        assert_eq!(out[1], 2, "two supports under row 0: {out:?}");
        assert_eq!(out[2], 1);
    }

    #[test]
    fn instance_7_light_gravity_north() {
        let col = [b(N, false), b(N, true), b(L, false), b(N, false)];
        let out = counts(&col, SupportMode::AllOptimized);
        assert_eq!(out[3], 2, "{out:?}");
    }

    #[test]
    fn last_row_light_gets_support() {
        let col = [b(N, false), b(N, false), b(N, false), b(L, false)];
        let out = counts(&col, SupportMode::AllOptimized);
        assert_eq!(out[4], 1, "{out:?}");
    }

    #[test]
    fn double_mode_is_full_carbon_copy_plus_steps() {
        let col = [b(N, false), b(L, false), b(D, false), b(N, false)];
        let out = counts(&col, SupportMode::AllDoubleOptimized);
        assert!(out.iter().all(|&c| c >= 1));
        let single = counts(&col, SupportMode::AllOptimized);
        let total_double: u32 = out.iter().map(|&c| u32::from(c)).sum();
        let total_single: u32 = single.iter().map(|&c| u32::from(c)).sum();
        assert!(total_double > total_single);
    }

    #[test]
    fn all_optimized_covers_important_pointwise() {
        let tones = [N, D, L];
        for code in 0..(3usize * 2).pow(5) {
            let mut c = code;
            let col: Vec<ColBlock> = (0..5)
                .map(|_| {
                    let t = tones[c % 3];
                    c /= 3;
                    let m = c % 2 == 1;
                    c /= 2;
                    b(t, m)
                })
                .collect();
            let imp = counts(&col, SupportMode::Important);
            let opt = counts(&col, SupportMode::AllOptimized);
            let dbl = counts(&col, SupportMode::AllDoubleOptimized);
            for i in 0..imp.len() {
                assert!(
                    opt[i] >= imp[i],
                    "all_optimized dropped a mandatory support at {i}: {col:?}"
                );
                assert!(dbl[i] >= 1, "double mode must floor every position: {col:?}");
            }
        }
    }

    #[test]
    fn a_light_cliff_gets_a_full_pillar() {
        let col = [b(L, false), b(D, false), b(D, false), b(D, false)];
        let steps = [3, -1, -1, -1];
        let out = support_counts(&col, &steps, SupportMode::AllOptimized);
        assert_eq!(out[1], 3, "a +3 jump needs a 3-deep pillar: {out:?}");
        let dbl = support_counts(&col, &steps, SupportMode::AllDoubleOptimized);
        assert_eq!(dbl[1], 4, "layer plus the pillar: {dbl:?}");
    }

    #[test]
    fn a_dark_cliff_gets_a_full_pillar_under_its_north_neighbor() {
        let col = [b(L, false), b(L, false), b(L, false), b(D, false)];
        let steps = [1, 1, 1, -3];
        let out = support_counts(&col, &steps, SupportMode::AllOptimized);
        assert_eq!(out[3], 3, "a -3 drop needs 3 below the block north of it: {out:?}");
    }

    #[test]
    fn a_trailing_light_cliff_scales_the_last_row() {
        let col = [b(N, false), b(L, false)];
        let steps = [0, 4];
        let out = support_counts(&col, &steps, SupportMode::AllOptimized);
        assert_eq!(out[2], 4, "{out:?}");
    }

    #[test]
    fn unit_steps_reproduce_the_classic_table() {
        let tones = [N, D, L];
        for code in 0..(3usize * 2).pow(5) {
            let mut c = code;
            let col: Vec<ColBlock> = (0..5)
                .map(|_| {
                    let t = tones[c % 3];
                    c /= 3;
                    let m = c % 2 == 1;
                    c /= 2;
                    b(t, m)
                })
                .collect();
            let zeros = vec![0i32; 5];
            for mode in [
                SupportMode::Important,
                SupportMode::AllOptimized,
                SupportMode::AllDoubleOptimized,
            ] {
                assert_eq!(
                    support_counts(&col, &unit_steps(&col), mode),
                    support_counts(&col, &zeros, mode),
                    "flat and unit steps must agree at depth 1: {col:?}"
                );
            }
        }
    }

    #[test]
    fn modes_are_monotone_in_cost() {
        let col = [
            b(L, true),
            b(D, false),
            b(N, true),
            b(L, false),
            b(D, true),
            b(N, false),
        ];
        let t = |m| -> u32 { counts(&col, m).iter().map(|&c| u32::from(c)).sum() };
        assert!(t(SupportMode::None) <= t(SupportMode::Important));
        assert!(t(SupportMode::Important) <= t(SupportMode::AllOptimized));
        assert!(t(SupportMode::AllOptimized) <= t(SupportMode::AllDoubleOptimized));
    }
}
