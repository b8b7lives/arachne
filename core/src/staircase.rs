use crate::palette::Tone;

#[derive(Debug, Clone, Copy)]
pub enum HeightMode {
    Flat,
    Stepped { cliff_cap: Option<u32> },
}

pub fn column_heights(tones: &[Tone], mode: HeightMode) -> Vec<i32> {
    let n = tones.len();
    match mode {
        HeightMode::Flat => {
            // Flat builds sit at one level; only the reference row moves,
            // for the forced-light edge of a run that starts a panel.
            let mut h = vec![2; n + 1];
            match tones.first() {
                Some(Tone::Light) => h[0] = 1,
                Some(Tone::Dark) => h[0] = 3,
                _ => {}
            }
            h
        }
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

pub fn capped_heights(
    tone_costs: &[[Option<f32>; 3]],
    cliff_cap: Option<u32>,
    max_height: u32,
) -> Option<(Vec<i32>, Vec<Tone>, f32)> {
    use std::collections::VecDeque;
    let n = tone_costs.len();
    let hs = max_height as usize + 1;
    assert!(hs <= u16::MAX as usize + 1, "height cap fits u16 states");
    let cap = cliff_cap.map_or(hs, |c| (c.max(1) as usize).min(hs));
    let mut dp = vec![0.0f32; hs];
    let mut back: Vec<Vec<(u8, u16)>> = Vec::with_capacity(n);
    for costs in tone_costs {
        let mut nd = vec![f32::INFINITY; hs];
        let mut bk = vec![(3u8, 0u16); hs];
        if let Some(c) = costs[1] {
            for h in 0..hs {
                let v = dp[h] + c;
                if v < nd[h] {
                    nd[h] = v;
                    bk[h] = (1, h as u16);
                }
            }
        }
        if let Some(c) = costs[2] {
            let mut dq: VecDeque<usize> = VecDeque::new();
            for h in 1..hs {
                while dq.back().is_some_and(|&b| dp[b] > dp[h - 1]) {
                    dq.pop_back();
                }
                dq.push_back(h - 1);
                while dq.front().is_some_and(|&f| f + cap < h) {
                    dq.pop_front();
                }
                let p = *dq.front().expect("window holds h-1");
                let v = dp[p] + c;
                if v < nd[h] {
                    nd[h] = v;
                    bk[h] = (2, p as u16);
                }
            }
        }
        if let Some(c) = costs[0] {
            let mut dq: VecDeque<usize> = VecDeque::new();
            for h in (0..hs - 1).rev() {
                while dq.back().is_some_and(|&b| dp[b] >= dp[h + 1]) {
                    dq.pop_back();
                }
                dq.push_back(h + 1);
                while dq.front().is_some_and(|&f| f > h + cap) {
                    dq.pop_front();
                }
                let p = *dq.front().expect("window holds h+1");
                let v = dp[p] + c;
                if v < nd[h] {
                    nd[h] = v;
                    bk[h] = (0, p as u16);
                }
            }
        }
        if !nd.iter().any(|v| v.is_finite()) {
            return None;
        }
        dp = nd;
        back.push(bk);
    }
    let mut end = usize::MAX;
    let mut best = f32::INFINITY;
    for (h, &v) in dp.iter().enumerate() {
        if v < best {
            best = v;
            end = h;
        }
    }
    if end == usize::MAX {
        return None;
    }
    let mut h = end;
    let mut heights = vec![0i32; n + 1];
    let mut classes = vec![Tone::Normal; n];
    for i in (0..n).rev() {
        heights[i + 1] = h as i32;
        let (cls, prev) = back[i][h];
        classes[i] = match cls {
            0 => Tone::Dark,
            2 => Tone::Light,
            _ => Tone::Normal,
        };
        h = prev as usize;
    }
    heights[0] = h as i32;
    Some((heights, classes, best))
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

    fn class_of(t: Tone) -> usize {
        match t {
            D => 0,
            L => 2,
            _ => 1,
        }
    }

    fn keep_only(tones: &[Tone]) -> Vec<[Option<f32>; 3]> {
        tones
            .iter()
            .map(|t| {
                let mut row = [None, None, None];
                row[class_of(*t)] = Some(0.0);
                row
            })
            .collect()
    }

    fn substitutable(tones: &[Tone], cost: f32) -> Vec<[Option<f32>; 3]> {
        tones
            .iter()
            .map(|t| {
                let mut row = [Some(cost), Some(cost), Some(cost)];
                row[class_of(*t)] = Some(0.0);
                row
            })
            .collect()
    }

    fn dp_path_is_valid(
        costs: &[[Option<f32>; 3]],
        cap: Option<u32>,
        max_h: u32,
        heights: &[i32],
        classes: &[Tone],
        total: f32,
    ) {
        let capv = cap.map_or(i32::MAX, |c| c.max(1) as i32);
        let mut sum = 0.0;
        for (i, cls) in classes.iter().enumerate() {
            let step = heights[i + 1] - heights[i];
            match cls {
                L => assert!(step >= 1 && step <= capv, "light step {step}"),
                D => assert!(step <= -1 && step >= -capv, "dark step {step}"),
                _ => assert_eq!(step, 0),
            }
            sum += costs[i][class_of(*cls)].expect("chosen class is available");
        }
        for &h in heights {
            assert!(h >= 0 && h <= max_h as i32, "height {h} out of range");
        }
        assert!((sum - total).abs() < 1e-4, "cost {total} vs path sum {sum}");
    }

    #[test]
    fn capped_dp_keeps_tones_when_the_greedy_already_fits() {
        let tones = [L, L, D, N, D, L, D];
        let greedy = heights(&tones, Some(2));
        let peak = *greedy.iter().max().unwrap() as u32;
        let (h, classes, cost) =
            capped_heights(&keep_only(&tones), Some(2), peak).expect("feasible at its own peak");
        assert_eq!(cost, 0.0);
        assert_eq!(
            classes.iter().map(|t| class_of(*t)).collect::<Vec<_>>(),
            tones.iter().map(|t| class_of(*t)).collect::<Vec<_>>()
        );
        dp_path_is_valid(&keep_only(&tones), Some(2), peak, &h, &classes, cost);
    }

    #[test]
    fn capped_dp_reports_infeasible_instead_of_lying() {
        let tones = [L, L, L, L];
        assert!(capped_heights(&keep_only(&tones), None, 2).is_none());
        assert!(capped_heights(&substitutable(&tones, 1.0), None, 2).is_some());
    }

    #[test]
    fn capped_dp_matches_brute_force_on_cost() {
        let opts = [D, N, L];
        for code in 0..3usize.pow(5) {
            let mut c = code;
            let tones: Vec<Tone> = (0..5)
                .map(|_| {
                    let t = opts[c % 3];
                    c /= 3;
                    t
                })
                .collect();
            for (cap, max_h) in [(None, 2u32), (Some(1), 3), (Some(2), 2)] {
                let costs = substitutable(&tones, 1.0);
                let dp = capped_heights(&costs, cap, max_h);

                let mut best = f32::INFINITY;
                for combo_code in 0..3usize.pow(5) {
                    let mut cc = combo_code;
                    let combo: Vec<Tone> = (0..5)
                        .map(|_| {
                            let t = opts[cc % 3];
                            cc /= 3;
                            t
                        })
                        .collect();
                    let g = heights(&combo, cap);
                    if *g.iter().max().unwrap() as u32 > max_h {
                        continue;
                    }
                    let cost: f32 = combo
                        .iter()
                        .zip(tones.iter())
                        .map(|(a, b)| if class_of(*a) == class_of(*b) { 0.0 } else { 1.0 })
                        .sum();
                    best = best.min(cost);
                }

                match dp {
                    None => assert!(
                        best.is_infinite(),
                        "dp gave up but brute force found cost {best}: {tones:?} cap {cap:?} H {max_h}"
                    ),
                    Some((h, classes, total)) => {
                        assert!(
                            (total - best).abs() < 1e-4,
                            "dp {total} vs brute {best}: {tones:?} cap {cap:?} H {max_h}"
                        );
                        dp_path_is_valid(&costs, cap, max_h, &h, &classes, total);
                    }
                }
            }
        }
    }

    #[test]
    fn capped_dp_prefers_cheap_edits() {
        let tones = [L, L, L, L];
        let mut costs = substitutable(&tones, 10.0);
        costs[2] = {
            let mut row = [Some(0.1), Some(0.1), Some(0.0)];
            row[1] = Some(0.1);
            row
        };
        let (_, classes, total) = capped_heights(&costs, None, 2).expect("feasible with edits");
        assert!(total <= 0.2 + 1e-6, "should use the cheap row: {total}");
        assert_ne!(class_of(classes[2]), class_of(L));
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
