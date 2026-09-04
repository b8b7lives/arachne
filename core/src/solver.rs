use crate::cost::{Loadout, MiningEnv, TeardownCost};
use crate::data::{BlockData, CandidateBlock, Recoverability};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Toggles {
    pub gravity: bool,
    pub support_mandatory: bool,
    pub silk_gated: bool,
    pub flammable: bool,
    pub unrecoverable: bool,
    pub unstable: bool,
    pub constrained: bool,
    pub class_match_only: bool,
}

impl Default for Toggles {
    fn default() -> Self {
        Self {
            gravity: true,
            support_mandatory: true,
            silk_gated: true,
            flammable: true,
            unrecoverable: true,
            unstable: true,
            constrained: true,
            class_match_only: false,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SolverConfig {
    pub env: MiningEnv,
    pub toggles: Toggles,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RankedCandidate<'a> {
    pub index: usize,
    pub block: &'a CandidateBlock,
    pub cost: TeardownCost,
    pub since_index: usize,
}

impl RankedCandidate<'_> {
    pub fn recovery_ticks(&self) -> Option<u32> {
        self.cost.recovery().map(|p| p.ticks)
    }

    fn friction(&self) -> u32 {
        let b = self.block;
        u32::from(b.gravity)
            + u32::from(b.support_mandatory)
            + u32::from(b.constrained)
            + u32::from(b.unstable)
            + u32::from(b.recoverability == Recoverability::SilkGated)
    }

    fn sort_key(&self) -> (u32, u32, u32, usize, &str) {
        (
            self.recovery_ticks().unwrap_or(u32::MAX),
            self.friction(),
            self.cost.fastest.map_or(u32::MAX, |p| p.ticks),
            self.since_index,
            &self.block.block_id,
        )
    }
}

fn included(b: &CandidateBlock, t: &Toggles) -> bool {
    (t.gravity || !b.gravity)
        && (t.support_mandatory || !b.support_mandatory)
        && (t.flammable || !b.flammable)
        && (t.silk_gated || b.recoverability != Recoverability::SilkGated)
        && (t.unstable || !b.unstable)
        && (t.constrained || !b.constrained)
}

pub fn rank_color<'a>(
    data: &'a BlockData,
    color_id: u8,
    loadout: &Loadout,
    cfg: &SolverConfig,
) -> Vec<RankedCandidate<'a>> {
    let at = cfg.version.as_deref().and_then(|v| data.version_index(v));
    let mut out: Vec<RankedCandidate<'a>> = data
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.color_id == color_id)
        .filter(|(_, b)| included(b, &cfg.toggles))
        .filter(|(_, b)| data.available_at(&b.since, at))
        .filter(|(_, b)| {
            !cfg.toggles.class_match_only || loadout.tools.iter().any(|t| t.kind == b.tool)
        })
        .map(|(index, block)| RankedCandidate {
            index,
            block,
            cost: loadout.teardown(block, &cfg.env),
            since_index: data.version_index(&block.since).unwrap_or(usize::MAX),
        })
        .filter(|r| cfg.toggles.unrecoverable || r.recovery_ticks().is_some())
        .collect();
    out.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::{OwnedTool, Tier};
    use crate::data::Tool;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    fn eff10_silk_kit() -> Loadout {
        let t = |kind| OwnedTool {
            kind,
            tier: Tier::Netherite,
            custom_speed: None,
            efficiency: 10,
            silk: true,
        };
        Loadout {
            tools: vec![
                t(Tool::Pickaxe),
                t(Tool::Axe),
                t(Tool::Shovel),
                t(Tool::Hoe),
            ],
        }
    }

    #[test]
    fn equal_cost_ties_prefer_low_friction_plain_blocks() {
        let d = data();
        for cid in [2u8, 3, 8, 14, 20] {
            let ranked = rank_color(&d, cid, &eff10_silk_kit(), &SolverConfig::default());
            let top = &ranked[0];
            assert!(
                !top.block.support_mandatory && !top.block.constrained,
                "color {cid}: top pick {} needs support/substrate",
                top.block.block_id
            );
            let mut last = (0u32, 0u32);
            for r in &ranked {
                let k = (r.recovery_ticks().unwrap_or(u32::MAX), r.friction());
                assert!(k >= last, "friction out of order at {}", r.block.block_id);
                last = k;
            }
        }
    }

    #[test]
    fn stone_color_ranking_is_deterministic_and_recoverable_first() {
        let d = data();
        let ranked = rank_color(&d, 11, &eff10_silk_kit(), &SolverConfig::default());
        assert!(!ranked.is_empty());
        let mut last = (0u32, 0u32);
        for r in &ranked {
            let key = (
                r.recovery_ticks().unwrap_or(u32::MAX),
                r.cost.fastest.map_or(u32::MAX, |p| p.ticks),
            );
            assert!(key >= last, "ranking out of order at {}", r.block.block_id);
            last = key;
        }
        assert_eq!(ranked[0].recovery_ticks(), Some(0));
    }

    #[test]
    fn gravity_toggle_drops_gravel() {
        let d = data();
        let cid = d
            .blocks
            .iter()
            .find(|b| b.block_id == "gravel")
            .expect("gravel is a candidate")
            .color_id;
        let cfg = SolverConfig::default();
        let with = rank_color(&d, cid, &eff10_silk_kit(), &cfg);
        assert!(with.iter().any(|r| r.block.block_id == "gravel"));
        let cfg = SolverConfig {
            toggles: Toggles {
                gravity: false,
                ..Toggles::default()
            },
            ..SolverConfig::default()
        };
        let without = rank_color(&d, cid, &eff10_silk_kit(), &cfg);
        assert!(!without.iter().any(|r| r.block.block_id == "gravel"));
        let n_gravity = with.iter().filter(|r| r.block.gravity).count();
        assert!(n_gravity >= 1);
        assert_eq!(with.len(), without.len() + n_gravity);
    }

    #[test]
    fn constrained_toggle_filters() {
        let d = data();
        let base = rank_color(&d, 2, &eff10_silk_kit(), &SolverConfig::default());
        assert!(base.iter().any(|r| r.block.block_id == "scaffolding"));
        let cfg = SolverConfig {
            toggles: Toggles {
                constrained: false,
                ..Toggles::default()
            },
            ..SolverConfig::default()
        };
        let ranked = rank_color(&d, 2, &eff10_silk_kit(), &cfg);
        assert!(!ranked.iter().any(|r| r.block.block_id == "scaffolding"));
    }

    #[test]
    fn equal_cost_prefers_the_block_more_releases_can_make() {
        let d = data();
        let kit = eff10_silk_kit();
        for color in d.colors.iter() {
            let ranked = rank_color(&d, color.id, &kit, &SolverConfig::default());
            for pair in ranked.windows(2) {
                let (a, b) = (&pair[0], &pair[1]);
                let same = a.recovery_ticks() == b.recovery_ticks()
                    && a.friction() == b.friction()
                    && a.cost.fastest.map(|p| p.ticks) == b.cost.fastest.map(|p| p.ticks);
                if same {
                    assert!(
                        a.since_index <= b.since_index,
                        "{} ({}) ranked above {} ({})",
                        a.block.block_id,
                        a.block.since,
                        b.block.block_id,
                        b.block.since
                    );
                }
            }
        }
    }

    #[test]
    fn class_match_only_drops_wrong_tool_blocks() {
        let d = data();
        let silk_pick = Loadout {
            tools: vec![OwnedTool {
                kind: Tool::Pickaxe,
                tier: Tier::Netherite,
                custom_speed: None,
                efficiency: 5,
                silk: true,
            }],
        };
        let cfg = SolverConfig {
            toggles: Toggles {
                class_match_only: true,
                ..Toggles::default()
            },
            ..SolverConfig::default()
        };
        assert!(rank_color(&d, 3, &silk_pick, &cfg).is_empty());
        let stone = rank_color(&d, 11, &silk_pick, &cfg);
        assert!(!stone.is_empty());
        assert!(stone.iter().all(|r| r.block.tool == Tool::Pickaxe));
        assert!(!rank_color(&d, 3, &silk_pick, &SolverConfig::default()).is_empty());
    }

    #[test]
    fn silk_burden_ranks_stone_below_unconditional_peers() {
        let d = data();
        let mut l = eff10_silk_kit();
        for t in &mut l.tools {
            t.silk = false;
        }
        let ranked = rank_color(&d, 11, &l, &SolverConfig::default());
        let stone_pos = ranked
            .iter()
            .position(|r| r.block.block_id == "stone")
            .unwrap();
        assert_eq!(ranked[stone_pos].recovery_ticks(), None);
        for r in &ranked[..stone_pos] {
            assert!(r.recovery_ticks().is_some() || r.sort_key() <= ranked[stone_pos].sort_key());
        }
        let cfg = SolverConfig {
            toggles: Toggles {
                unrecoverable: false,
                ..Toggles::default()
            },
            ..SolverConfig::default()
        };
        let filtered = rank_color(&d, 11, &l, &cfg);
        assert!(!filtered.iter().any(|r| r.block.block_id == "stone"));
    }

    #[test]
    fn a_release_only_offers_blocks_it_has() {
        let d = data();
        let kit = eff10_silk_kit();
        for (version, absent) in [("1.13", "smooth_stone_slab"), ("1.16", "pale_oak_planks")] {
            let cfg = SolverConfig {
                version: Some(version.to_string()),
                ..SolverConfig::default()
            };
            for color in d.colors.iter() {
                for r in rank_color(&d, color.id, &kit, &cfg) {
                    assert_ne!(
                        r.block.block_id, absent,
                        "{version} offered {}, which it does not have",
                        absent
                    );
                    let si = d.version_index(&r.block.since).expect("known release");
                    let at = d.version_index(version).expect("known release");
                    assert!(si <= at, "{} is from {}", r.block.block_id, r.block.since);
                }
            }
        }
    }

    #[test]
    fn later_releases_never_offer_less() {
        let d = data();
        let kit = eff10_silk_kit();
        let count = |v: &str| {
            let cfg = SolverConfig {
                version: Some(v.to_string()),
                ..SolverConfig::default()
            };
            d.colors
                .iter()
                .map(|c| rank_color(&d, c.id, &kit, &cfg).len())
                .sum::<usize>()
        };
        let (early, mid, late) = (count("1.13"), count("1.17"), count("26.2"));
        assert!(early < mid && mid < late, "{early} {mid} {late}");
        let cfg = SolverConfig::default();
        let unset: usize = d
            .colors
            .iter()
            .map(|c| rank_color(&d, c.id, &kit, &cfg).len())
            .sum();
        assert_eq!(unset, late, "no version set should mean the newest");
    }
}
