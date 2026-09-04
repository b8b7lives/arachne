use crate::data::{CandidateBlock, MinTier, Recoverability, Tool};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Wood,
    Stone,
    Copper,
    Iron,
    Diamond,
    Netherite,
    Gold,
}

impl Tier {
    pub fn speed(self) -> f32 {
        match self {
            Tier::Wood => 2.0,
            Tier::Stone => 4.0,
            Tier::Copper => 5.0,
            Tier::Iron => 6.0,
            Tier::Diamond => 8.0,
            Tier::Netherite => 9.0,
            Tier::Gold => 12.0,
        }
    }

    pub fn gate(self) -> MinTier {
        match self {
            Tier::Wood | Tier::Gold => MinTier::None,
            Tier::Stone | Tier::Copper => MinTier::Stone,
            Tier::Iron => MinTier::Iron,
            Tier::Diamond | Tier::Netherite => MinTier::Diamond,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct OwnedTool {
    pub kind: Tool,
    pub tier: Tier,
    #[serde(default)]
    pub custom_speed: Option<f32>,
    #[serde(default)]
    pub efficiency: u8,
    #[serde(default)]
    pub silk: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct MiningEnv {
    #[serde(default)]
    pub haste: u8,
    #[serde(default)]
    pub flying: bool,
}

pub fn break_ticks(
    block: &CandidateBlock,
    tool: Option<&OwnedTool>,
    env: &MiningEnv,
) -> Option<u32> {
    if block.hardness < 0.0 {
        return None;
    }
    let mut speed = match tool {
        Some(t) if t.kind == Tool::Shears => t.custom_speed.or(block.shears_speed).unwrap_or(1.0),
        Some(t) if t.kind == block.tool => t.custom_speed.unwrap_or(t.tier.speed()),
        _ => 1.0,
    };
    if speed > 1.0 {
        let eff = tool.map_or(0, |t| t.efficiency);
        if eff > 0 {
            speed += (u32::from(eff) * u32::from(eff) + 1) as f32;
        }
    }
    speed *= 1.0 + 0.2 * f32::from(env.haste);
    if env.flying {
        speed /= 5.0;
    }
    let divisor = if correct_for_drops(block, tool) {
        30.0
    } else {
        100.0
    };
    if block.hardness == 0.0 {
        return Some(0);
    }
    let progress = speed / block.hardness / divisor;
    if progress >= 1.0 {
        Some(0)
    } else {
        Some((1.0 / progress).ceil() as u32)
    }
}

pub fn correct_for_drops(block: &CandidateBlock, tool: Option<&OwnedTool>) -> bool {
    !block.requires_tool
        || tool.is_some_and(|t| t.kind == block.tool && t.tier.gate() >= block.min_tier)
        || tool.is_some_and(|t| t.kind == Tool::Shears && block.shears_speed.is_some())
}

fn silk_applies(t: &OwnedTool) -> bool {
    t.silk && t.kind != Tool::Shears
}

pub fn drops_self(block: &CandidateBlock, tool: Option<&OwnedTool>) -> bool {
    match block.recoverability {
        Recoverability::Unconditional => correct_for_drops(block, tool),
        Recoverability::SilkGated => {
            tool.is_some_and(|t| {
                block
                    .gate
                    .satisfied_by(silk_applies(t), t.kind == Tool::Shears)
            }) && correct_for_drops(block, tool)
        }
        Recoverability::Never | Recoverability::NoTable => false,
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Loadout {
    pub tools: Vec<OwnedTool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathCost {
    pub ticks: u32,
    pub tool: Option<usize>,
}

impl PathCost {
    pub fn instamine(&self) -> bool {
        self.ticks == 0
    }
}

#[derive(Debug, Clone)]
pub struct TeardownCost {
    pub reuse: Option<PathCost>,
    pub fastest: Option<PathCost>,
}

impl TeardownCost {
    pub fn recovery(&self) -> Option<PathCost> {
        self.reuse
    }

    pub fn recovery_penalty(&self) -> Option<u32> {
        Some(self.recovery()?.ticks - self.fastest?.ticks)
    }
}

impl Loadout {
    pub fn teardown(&self, block: &CandidateBlock, env: &MiningEnv) -> TeardownCost {
        let mut reuse: Option<PathCost> = None;
        let mut fastest: Option<PathCost> = None;
        let min = |cur: &mut Option<PathCost>, cand: PathCost| {
            if cur.is_none_or(|c| cand.ticks < c.ticks) {
                *cur = Some(cand);
            }
        };
        let options = std::iter::once(None).chain(self.tools.iter().enumerate().map(Some));
        for opt in options {
            let (idx, tool) = match opt {
                None => (None, None),
                Some((i, t)) => (Some(i), Some(t)),
            };
            let Some(ticks) = break_ticks(block, tool, env) else {
                continue;
            };
            min(&mut fastest, PathCost { ticks, tool: idx });
            if drops_self(block, tool) {
                min(&mut reuse, PathCost { ticks, tool: idx });
            }
        }
        TeardownCost { reuse, fastest }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Gate;
    use std::collections::HashMap;

    fn block(
        hardness: f32,
        tool: Tool,
        min_tier: MinTier,
        requires_tool: bool,
        recoverability: Recoverability,
    ) -> CandidateBlock {
        CandidateBlock {
            color_id: 0,
            since: "1.13".to_string(),
            block_id: "test".into(),
            display_name: "Test".into(),
            properties: HashMap::new(),
            hardness,
            tool,
            min_tier,
            requires_tool,
            recoverability,
            gate: if recoverability == Recoverability::SilkGated {
                Gate::Silk
            } else {
                Gate::None
            },
            shears_speed: None,
            gravity: false,
            support_mandatory: false,
            flammable: false,
            unstable: false,
            constrained: false,
            fluid: false,
        }
    }

    fn stone() -> CandidateBlock {
        block(
            1.5,
            Tool::Pickaxe,
            MinTier::None,
            true,
            Recoverability::SilkGated,
        )
    }

    fn pick(tier: Tier, efficiency: u8, silk: bool) -> OwnedTool {
        OwnedTool {
            kind: Tool::Pickaxe,
            tier,
            custom_speed: None,
            efficiency,
            silk,
        }
    }

    const GROUNDED: MiningEnv = MiningEnv {
        haste: 0,
        flying: false,
    };
    const FLYING: MiningEnv = MiningEnv {
        haste: 0,
        flying: true,
    };

    #[test]
    fn eff10_pick_vs_stone_grounded_instamines() {
        let t = pick(Tier::Netherite, 10, false);
        assert_eq!(break_ticks(&stone(), Some(&t), &GROUNDED), Some(0));
    }

    #[test]
    fn eff10_pick_vs_stone_flying_is_3_ticks() {
        let t = pick(Tier::Netherite, 10, false);
        assert_eq!(break_ticks(&stone(), Some(&t), &FLYING), Some(3));
    }

    #[test]
    fn eff5_diamond_pick_vs_stone_is_2_ticks() {
        let t = pick(Tier::Diamond, 5, false);
        assert_eq!(break_ticks(&stone(), Some(&t), &GROUNDED), Some(2));
    }

    #[test]
    fn instamine_boundary_is_exact() {
        let mut t = pick(Tier::Diamond, 0, false);
        t.custom_speed = Some(45.0);
        assert_eq!(break_ticks(&stone(), Some(&t), &GROUNDED), Some(0));
        t.custom_speed = Some(44.9);
        assert_eq!(break_ticks(&stone(), Some(&t), &GROUNDED), Some(2));
    }

    #[test]
    fn haste_multiplies_after_eff() {
        let t = pick(Tier::Diamond, 0, false);
        let env = MiningEnv {
            haste: 2,
            flying: false,
        };
        assert_eq!(break_ticks(&stone(), Some(&t), &env), Some(5));
        let t = pick(Tier::Diamond, 5, false);
        assert_eq!(break_ticks(&stone(), Some(&t), &env), Some(0));
    }

    #[test]
    fn stone_by_hand_uses_100_divisor_and_never_drops() {
        assert_eq!(break_ticks(&stone(), None, &GROUNDED), Some(150));
        assert!(!drops_self(&stone(), None));
    }

    #[test]
    fn dirt_hand_and_shovel_match_vanilla() {
        let dirt = block(
            0.5,
            Tool::Shovel,
            MinTier::None,
            false,
            Recoverability::Unconditional,
        );
        assert_eq!(break_ticks(&dirt, None, &GROUNDED), Some(15));
        let t = OwnedTool {
            kind: Tool::Shovel,
            tier: Tier::Iron,
            custom_speed: None,
            efficiency: 0,
            silk: false,
        };
        assert_eq!(break_ticks(&dirt, Some(&t), &GROUNDED), Some(3));
        assert!(drops_self(&dirt, None));
    }

    #[test]
    fn tier_gate_failure_slows_and_blocks_drops() {
        let gold = block(
            3.0,
            Tool::Pickaxe,
            MinTier::Iron,
            true,
            Recoverability::Unconditional,
        );
        let t = pick(Tier::Stone, 0, false);
        assert_eq!(break_ticks(&gold, Some(&t), &GROUNDED), Some(75));
        assert!(!drops_self(&gold, Some(&t)));
        let t = pick(Tier::Copper, 0, false);
        assert!(!drops_self(&gold, Some(&t)));
        let t = pick(Tier::Iron, 0, false);
        assert_eq!(break_ticks(&gold, Some(&t), &GROUNDED), Some(15));
        assert!(drops_self(&gold, Some(&t)));
    }

    #[test]
    fn eff_ignored_when_tool_speed_is_1() {
        let glassy = block(
            0.3,
            Tool::None,
            MinTier::None,
            false,
            Recoverability::SilkGated,
        );
        let t = pick(Tier::Netherite, 10, true);
        assert_eq!(break_ticks(&glassy, Some(&t), &GROUNDED), Some(9));
        assert!(drops_self(&glassy, Some(&t)));
        assert!(!drops_self(&glassy, None));
    }

    #[test]
    fn zero_and_negative_hardness() {
        let insta = block(
            0.0,
            Tool::None,
            MinTier::None,
            false,
            Recoverability::Unconditional,
        );
        assert_eq!(break_ticks(&insta, None, &GROUNDED), Some(0));
        let bedrock = block(
            -1.0,
            Tool::None,
            MinTier::None,
            false,
            Recoverability::NoTable,
        );
        assert_eq!(break_ticks(&bedrock, None, &GROUNDED), None);
    }

    #[test]
    fn loadout_silk_burden_on_stone() {
        let l = Loadout {
            tools: vec![pick(Tier::Netherite, 10, false), pick(Tier::Iron, 0, true)],
        };
        let c = l.teardown(&stone(), &GROUNDED);
        assert_eq!(
            c.fastest,
            Some(PathCost {
                ticks: 0,
                tool: Some(0)
            })
        );
        assert_eq!(
            c.reuse,
            Some(PathCost {
                ticks: 8,
                tool: Some(1)
            })
        );
        assert_eq!(c.recovery_penalty(), Some(8));
    }

    #[test]
    fn silk_gated_blocks_recover_only_with_silk() {
        let clay = block(
            0.6,
            Tool::Shovel,
            MinTier::None,
            false,
            Recoverability::SilkGated,
        );
        let shovel = |silk| OwnedTool {
            kind: Tool::Shovel,
            tier: Tier::Iron,
            custom_speed: None,
            efficiency: 0,
            silk,
        };
        let l = Loadout {
            tools: vec![shovel(false)],
        };
        let c = l.teardown(&clay, &GROUNDED);
        assert_eq!(c.reuse, None);
        assert_eq!(c.recovery(), None);
        assert!(c.fastest.is_some());
        let l = Loadout {
            tools: vec![shovel(false), shovel(true)],
        };
        let c = l.teardown(&clay, &GROUNDED);
        assert_eq!(
            c.recovery(),
            Some(PathCost {
                ticks: 3,
                tool: Some(1)
            })
        );
    }

    #[test]
    fn tool_meta_matches_jar() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = crate::data::BlockData::from_json(&json).unwrap();
        let shears = d.meta.tools.get("shears").expect("shears in tool meta");
        assert!(shears.efficiency && !shears.silk_touch && !shears.tiered);
        let pick = d.meta.tools.get("pickaxe").unwrap();
        assert!(pick.efficiency && pick.silk_touch && pick.tiered);
    }

    #[test]
    fn tier_constants_match_dumped_registry() {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        let d = crate::data::BlockData::from_json(&json).unwrap();
        for (tier, name) in [
            (Tier::Wood, "wood"),
            (Tier::Stone, "stone"),
            (Tier::Copper, "copper"),
            (Tier::Iron, "iron"),
            (Tier::Diamond, "diamond"),
            (Tier::Netherite, "netherite"),
            (Tier::Gold, "gold"),
        ] {
            let m = d.meta.tiers.get(name).expect("tier in dumped meta");
            assert_eq!(tier.speed(), m.speed, "{name} speed");
            assert_eq!(tier.gate(), m.gate, "{name} gate");
        }
        assert_eq!(d.meta.tiers.len(), 7);
    }

    #[test]
    fn shears_use_per_block_speed_and_unlock_shears_gates() {
        let mut wool = block(
            0.8,
            Tool::None,
            MinTier::None,
            false,
            Recoverability::Unconditional,
        );
        wool.shears_speed = Some(5.0);
        let shears = OwnedTool {
            kind: Tool::Shears,
            tier: Tier::Iron,
            custom_speed: None,
            efficiency: 0,
            silk: false,
        };
        assert_eq!(break_ticks(&wool, None, &GROUNDED), Some(24));
        assert_eq!(break_ticks(&wool, Some(&shears), &GROUNDED), Some(5));

        let mut vine = block(
            0.2,
            Tool::None,
            MinTier::None,
            false,
            Recoverability::SilkGated,
        );
        vine.gate = Gate::Shears;
        vine.shears_speed = Some(2.0);
        assert!(drops_self(&vine, Some(&shears)));
        let silk_pick = pick(Tier::Netherite, 0, true);
        assert!(
            !drops_self(&vine, Some(&silk_pick)),
            "silk does not shear vines"
        );

        let mut silky_shears = shears.clone();
        silky_shears.silk = true;
        let stone_block = stone();
        assert!(
            !drops_self(&stone_block, Some(&silky_shears)),
            "silk touch does not exist on shears"
        );

        let mut leaves = block(
            0.2,
            Tool::Hoe,
            MinTier::None,
            false,
            Recoverability::SilkGated,
        );
        leaves.gate = Gate::SilkOrShears;
        leaves.shears_speed = Some(15.0);
        assert!(drops_self(&leaves, Some(&shears)));
        assert!(drops_self(&leaves, Some(&silk_pick)));
        assert_eq!(break_ticks(&leaves, Some(&shears), &GROUNDED), Some(0));
        let mut eff_shears = shears.clone();
        eff_shears.efficiency = 5;
        assert_eq!(break_ticks(&wool, Some(&eff_shears), &GROUNDED), Some(0));
        eff_shears.efficiency = 1;
        assert_eq!(break_ticks(&wool, Some(&eff_shears), &GROUNDED), Some(4));
    }

    #[test]
    fn no_table_has_no_recovery() {
        let water = block(
            100.0,
            Tool::None,
            MinTier::None,
            false,
            Recoverability::NoTable,
        );
        let l = Loadout {
            tools: vec![pick(Tier::Netherite, 10, true)],
        };
        let c = l.teardown(&water, &GROUNDED);
        assert_eq!(c.recovery(), None);
        assert!(c.fastest.is_some());
    }
}
