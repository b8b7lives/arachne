use crate::palette::Tone;

#[derive(Debug, Clone, Copy)]
pub enum HeightMode {
    Flat,
    Stepped { cliff_cap: Option<u32> },
}

pub fn column_heights(tones: &[Tone], mode: HeightMode) -> Vec<i32> {
    let n = tones.len();
    match mode {
        HeightMode::Flat => vec![2; n + 1],
        HeightMode::Stepped { cliff_cap } => {
            let cap = cliff_cap.map_or(i64::MAX, |c| i64::from(c.max(1)));
            let mut m = vec![0i64; n + 1];
            for i in (0..n).rev() {
                m[i] = match tones[i] {
                    Tone::Light => (m[i + 1] - cap).max(0),
                    Tone::Normal | Tone::Unobtainable => m[i + 1],
                    Tone::Dark => m[i + 1] + 1,
                };
            }
            let mut h = vec![0i64; n + 1];
            h[0] = m[0];
            for i in 0..n {
                h[i + 1] = match tones[i] {
                    Tone::Light => (h[i] + 1).max(m[i + 1]),
                    Tone::Normal | Tone::Unobtainable => h[i],
                    Tone::Dark => m[i + 1].max(h[i] - cap),
                };
                debug_assert!(h[i + 1] >= m[i + 1]);
                debug_assert!((h[i + 1] - h[i]).abs() <= cap);
            }
            h.into_iter()
                .map(|v| i32::try_from(v).expect("height fits i32"))
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Tone::{Dark as D, Light as L, Normal as N};

    fn heights(tones: &[Tone], cap: Option<u32>) -> Vec<i32> {
        column_heights(tones, HeightMode::Stepped { cliff_cap: cap })
    }

    #[test]
    fn all_normal_is_flat_zero() {
        assert_eq!(heights(&[N, N, N], None), vec![0, 0, 0, 0]);
    }

    #[test]
    fn ascent_descent_valley() {
        assert_eq!(heights(&[L, L, D, D], None), vec![0, 1, 2, 1, 0]);
        assert_eq!(heights(&[L, L, L, D], None), vec![0, 1, 2, 3, 0]);
        assert_eq!(heights(&[L, L, L, D], Some(1)), vec![0, 1, 2, 3, 2]);
    }

    #[test]
    fn dark_run_forces_initial_height() {
        assert_eq!(heights(&[D, D, D], None), vec![3, 2, 1, 0]);
    }

    #[test]
    fn big_ascent_lets_prefix_sit_low() {
        assert_eq!(
            heights(&[L, D, D, D, D, D], None),
            vec![0, 5, 4, 3, 2, 1, 0]
        );
        assert_eq!(heights(&[L, D, D, D, D, D], Some(1))[0], 4);
    }

    #[test]
    fn cap_one_matches_plus_minus_one_walk_with_min_zero() {
        let tones = [L, D, N, D, L, L, D, N];
        let h = heights(&tones, Some(1));
        for (i, t) in tones.iter().enumerate() {
            let step = h[i + 1] - h[i];
            match t {
                L => assert_eq!(step, 1),
                D => assert_eq!(step, -1),
                _ => assert_eq!(step, 0),
            }
        }
        assert_eq!(*h.iter().min().unwrap(), 0);
    }

    #[test]
    fn tighter_caps_are_pointwise_higher() {
        let tones = [L, L, D, L, D, D, N, L, D, D, D, L, N, D];
        let free = heights(&tones, None);
        let capped = heights(&tones, Some(2));
        let classic = heights(&tones, Some(1));
        for i in 0..free.len() {
            assert!(free[i] <= capped[i]);
            assert!(capped[i] <= classic[i]);
        }
    }

    fn brute_force_minima(tones: &[Tone], cap: i32, bound: i32) -> Vec<i32> {
        let n = tones.len();
        let mut minima = vec![i32::MAX; n + 1];
        let mut stack = vec![Vec::<i32>::new()];
        while let Some(prefix) = stack.pop() {
            let idx = prefix.len();
            if idx == n + 1 {
                for (m, v) in minima.iter_mut().zip(prefix.iter()) {
                    *m = (*m).min(*v);
                }
                continue;
            }
            for hv in 0..=bound {
                let ok = if idx == 0 {
                    true
                } else {
                    let prev = prefix[idx - 1];
                    let step = hv - prev;
                    match tones[idx - 1] {
                        L => step >= 1 && step <= cap,
                        D => step <= -1 && step >= -cap,
                        _ => step == 0,
                    }
                };
                if ok {
                    let mut next = prefix.clone();
                    next.push(hv);
                    stack.push(next);
                }
            }
        }
        minima
    }

    #[test]
    fn pointwise_minimal_vs_brute_force() {
        let opts = [D, N, L];
        for code in 0..3usize.pow(6) {
            let mut c = code;
            let tones: Vec<Tone> = (0..6)
                .map(|_| {
                    let t = opts[c % 3];
                    c /= 3;
                    t
                })
                .collect();
            assert_eq!(
                heights(&tones, None),
                brute_force_minima(&tones, i32::MAX, 7),
                "uncapped, tones {tones:?}"
            );
            assert_eq!(
                heights(&tones, Some(2)),
                brute_force_minima(&tones, 2, 7),
                "cap 2, tones {tones:?}"
            );
        }
    }
}
