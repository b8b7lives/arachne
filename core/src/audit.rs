use crate::cost::Loadout;
use crate::data::{BlockData, Recoverability, Tool};
use crate::solver::{RankedCandidate, SolverConfig, rank_color};
use std::collections::BTreeMap;

pub const STACK: u32 = 64;
pub const SHULKER: u32 = 1728;
pub const DOUBLE_CHEST: u32 = 3456;
pub const MAP_BLOCKS: u32 = 16384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quantity {
    pub count: u32,
}

impl Quantity {
    fn split(self, unit: u32) -> (u32, u32) {
        (self.count / unit, self.count % unit)
    }

    pub fn stacks(self) -> (u32, u32) {
        self.split(STACK)
    }

    pub fn shulkers(self) -> (u32, u32) {
        self.split(SHULKER)
    }

    pub fn double_chests(self) -> (u32, u32) {
        self.split(DOUBLE_CHEST)
    }
}

pub fn material_quantities(materials: &BTreeMap<u8, u32>) -> BTreeMap<u8, Quantity> {
    materials
        .iter()
        .map(|(&c, &n)| (c, Quantity { count: n }))
        .collect()
}

#[derive(Debug, Clone)]
pub struct ColorAudit<'a> {
    pub color_id: u8,
    pub ranked: Vec<RankedCandidate<'a>>,
}

impl ColorAudit<'_> {
    pub fn top(&self) -> Option<&RankedCandidate<'_>> {
        self.ranked.first()
    }
}

#[derive(Debug, Clone, Default)]
pub struct AuditSummary {
    pub tool_class: BTreeMap<Tool, u32>,
    pub instamine_colors: u32,
    pub silk_gated_colors: u32,
    pub silk_penalty_ticks: u64,
    pub no_recovery_colors: u32,
    pub unstable_colors: u32,
    pub empty_colors: u32,
}

#[derive(Debug, Clone)]
pub struct PaletteAudit<'a> {
    pub colors: Vec<ColorAudit<'a>>,
    pub summary: AuditSummary,
}

pub fn audit<'a>(data: &'a BlockData, loadout: &Loadout, cfg: &SolverConfig) -> PaletteAudit<'a> {
    let mut colors = Vec::with_capacity(data.colors.len());
    let mut s = AuditSummary::default();
    for c in data.buildable_colors() {
        let ranked = rank_color(data, c.id, loadout, cfg);
        match ranked.first() {
            None => s.empty_colors += 1,
            Some(top) => {
                *s.tool_class.entry(top.block.tool).or_insert(0) += 1;
                match top.cost.recovery() {
                    None => s.no_recovery_colors += 1,
                    Some(p) if p.instamine() => s.instamine_colors += 1,
                    Some(_) => {}
                }
                if top.block.recoverability == Recoverability::SilkGated {
                    s.silk_gated_colors += 1;
                }
                if top.block.unstable {
                    s.unstable_colors += 1;
                }
                s.silk_penalty_ticks += u64::from(top.cost.recovery_penalty().unwrap_or(0));
            }
        }
        colors.push(ColorAudit {
            color_id: c.id,
            ranked,
        });
    }
    PaletteAudit { colors, summary: s }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cost::{OwnedTool, Tier};

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    fn full_kit(silk: bool) -> Loadout {
        let t = |kind| OwnedTool {
            kind,
            tier: Tier::Netherite,
            custom_speed: None,
            efficiency: 10,
            silk,
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
    fn audit_covers_all_colors() {
        let d = data();
        let a = audit(&d, &full_kit(true), &SolverConfig::default());
        assert_eq!(a.colors.len(), 60);
        assert!(a.colors.iter().all(|c| c.color_id != 12));
        assert_eq!(a.summary.empty_colors, 0);
        assert!(a.colors.iter().all(|c| !c.ranked.is_empty()));
        let class_total: u32 = a.summary.tool_class.values().sum();
        assert_eq!(class_total, 60);
    }

    #[test]
    fn silk_kit_recovers_every_color() {
        let d = data();
        let a = audit(&d, &full_kit(true), &SolverConfig::default());
        assert_eq!(a.summary.no_recovery_colors, 0);
        assert!(
            a.colors
                .iter()
                .all(|c| c.top().unwrap().recovery_ticks().is_some())
        );
        assert_eq!(a.summary.silk_penalty_ticks, 0);
        assert!(a.summary.instamine_colors > 0);
    }

    #[test]
    fn no_silk_kit_shows_burden_or_loss_on_silk_gated_sets() {
        let d = data();
        let with_silk = audit(&d, &full_kit(true), &SolverConfig::default());
        let no_silk = audit(&d, &full_kit(false), &SolverConfig::default());
        assert!(no_silk.summary.silk_gated_colors <= with_silk.summary.silk_gated_colors);
        for (a, b) in with_silk.colors.iter().zip(no_silk.colors.iter()) {
            let (ra, rb) = (a.top().unwrap(), b.top().unwrap());
            let ta = ra.recovery_ticks().unwrap_or(u32::MAX);
            let tb = rb.recovery_ticks().unwrap_or(u32::MAX);
            assert!(
                tb >= ta,
                "color {}: losing silk cannot speed recovery",
                a.color_id
            );
        }
    }

    #[test]
    fn quantity_units() {
        let q = Quantity { count: 3456 };
        assert_eq!(q.stacks(), (54, 0));
        assert_eq!(q.shulkers(), (2, 0));
        assert_eq!(q.double_chests(), (1, 0));
        let q = Quantity { count: 1800 };
        assert_eq!(q.stacks(), (28, 8));
        assert_eq!(q.shulkers(), (1, 72));
        assert_eq!(MAP_BLOCKS, 128 * 128);
    }
}
