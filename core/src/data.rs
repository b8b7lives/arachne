use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BlockData {
    pub meta: Meta,
    pub colors: Vec<MapColor>,
    pub blocks: Vec<CandidateBlock>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Meta {
    pub mc_version: String,
    pub data_version: i32,
    #[serde(default)]
    pub versions: Vec<String>,
    #[serde(default)]
    pub data_versions: HashMap<String, i32>,
    pub tiers: HashMap<String, TierMeta>,
    pub tools: HashMap<String, ToolMeta>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct ToolMeta {
    pub efficiency: bool,
    pub silk_touch: bool,
    pub tiered: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TierMeta {
    pub speed: f32,
    pub gate: MinTier,
    #[serde(default)]
    pub durability: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MapColor {
    pub id: u8,
    pub name: String,
    #[serde(default)]
    pub since: String,
    pub constant: String,
    pub rgb: [u8; 3],
    pub tones: Tones,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Tones {
    pub dark: [u8; 3],
    pub normal: [u8; 3],
    pub light: [u8; 3],
    pub unobtainable: [u8; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    Pickaxe,
    Axe,
    Shovel,
    Hoe,
    Shears,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MinTier {
    None,
    Stone,
    Iron,
    Diamond,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Gate {
    #[default]
    None,
    Silk,
    Shears,
    SilkOrShears,
}

impl Gate {
    pub fn satisfied_by(self, silk: bool, shears: bool) -> bool {
        match self {
            Gate::None => true,
            Gate::Silk => silk,
            Gate::Shears => shears,
            Gate::SilkOrShears => silk || shears,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Recoverability {
    Unconditional,
    SilkGated,
    Never,
    NoTable,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CandidateBlock {
    pub color_id: u8,
    pub block_id: String,
    #[serde(default)]
    pub since: String,
    pub display_name: String,
    pub properties: HashMap<String, String>,
    pub hardness: f32,
    pub tool: Tool,
    pub min_tier: MinTier,
    pub requires_tool: bool,
    pub recoverability: Recoverability,
    pub gate: Gate,
    pub shears_speed: Option<f32>,
    pub gravity: bool,
    pub support_mandatory: bool,
    pub flammable: bool,
    pub unstable: bool,
    pub constrained: bool,
    #[serde(default)]
    pub fluid: bool,
}

impl BlockData {
    /// Position of a release in the supported list. Comparing these is how
    /// availability is decided; the strings are only for display.
    pub fn version_index(&self, version: &str) -> Option<usize> {
        self.meta.versions.iter().position(|v| v == version)
    }

    pub fn data_version_for(&self, version: Option<&str>) -> i32 {
        version
            .and_then(|v| self.meta.data_versions.get(v).copied())
            .unwrap_or(self.meta.data_version)
    }

    pub fn available_at(&self, since: &str, at: Option<usize>) -> bool {
        match at {
            None => true,
            Some(at) => self.version_index(since).is_some_and(|s| s <= at),
        }
    }

    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    pub fn color(&self, id: u8) -> Option<&MapColor> {
        self.colors.iter().find(|c| c.id == id)
    }

    pub fn candidates_for(&self, color_id: u8) -> impl Iterator<Item = &CandidateBlock> {
        self.blocks.iter().filter(move |b| b.color_id == color_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .expect("generated data present (run data-pipeline/build-blocks.py)");
        BlockData::from_json(&json).expect("schema matches generated data")
    }

    #[test]
    fn loads_generated_data() {
        let d = load();
        assert_eq!(d.meta.data_version, 4903);
        assert_eq!(d.colors.len(), 61);
        assert_eq!(d.blocks.len(), 618);
    }

    #[test]
    fn every_color_keeps_a_candidate() {
        let d = load();
        for c in &d.colors {
            assert!(
                d.blocks.iter().any(|b| b.color_id == c.id),
                "color {} ({}) has no candidate",
                c.id,
                c.name
            );
        }
    }

    #[test]
    fn tones_match_brightness_multipliers() {
        let d = load();
        for c in &d.colors {
            for (tone, mult) in [
                (&c.tones.dark, 180u32),
                (&c.tones.normal, 220),
                (&c.tones.light, 255),
                (&c.tones.unobtainable, 135),
            ] {
                for (t, base) in tone.iter().zip(c.rgb.iter()) {
                    assert_eq!(u32::from(*t), u32::from(*base) * mult / 255);
                }
            }
        }
    }

    #[test]
    fn color_names_are_unique_and_not_materials() {
        let d = load();
        let names: std::collections::HashSet<&str> =
            d.colors.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names.len(), 61, "color names must be unique");
        let by_id = |id: u8| d.color(id).unwrap();
        assert_eq!(by_id(61).name, "Muted Sea Green");
        assert_eq!(by_id(61).constant, "GLOW_LICHEN");
        assert_eq!(by_id(29).constant, "COLOR_BLACK");
        assert!(d.colors.iter().all(|c| c.name != c.constant));
    }

    #[test]
    fn all_tone_rgbs_unique() {
        let d = load();
        let mut seen = std::collections::HashSet::new();
        for c in &d.colors {
            for t in [
                c.tones.dark,
                c.tones.normal,
                c.tones.light,
                c.tones.unobtainable,
            ] {
                assert!(seen.insert(t), "duplicate tone RGB {t:?} (color {})", c.id);
            }
        }
    }

    #[test]
    fn every_color_has_a_candidate() {
        let d = load();
        for c in &d.colors {
            assert!(
                d.candidates_for(c.id).next().is_some(),
                "color {} ({}) has no candidate blocks",
                c.id,
                c.name
            );
        }
    }

    #[test]
    fn known_facts_hold() {
        let d = load();
        let stone = d
            .blocks
            .iter()
            .find(|b| b.block_id == "stone")
            .expect("stone is a candidate");
        assert_eq!(stone.recoverability, Recoverability::SilkGated);
        assert_eq!(stone.tool, Tool::Pickaxe);
        assert_eq!(stone.hardness, 1.5);
        assert!(stone.requires_tool);
        let dirt = d.blocks.iter().find(|b| b.block_id == "dirt").unwrap();
        assert!(!dirt.requires_tool);
        let clay = d.blocks.iter().find(|b| b.block_id == "clay").unwrap();
        assert_eq!(clay.recoverability, Recoverability::SilkGated);
        let f = |id: &str| d.blocks.iter().find(|b| b.block_id == id).unwrap();
        assert_eq!(f("white_wool").shears_speed, Some(5.0));
        assert_eq!(f("oak_leaves").gate, Gate::SilkOrShears);
        assert_eq!(f("stone").gate, Gate::Silk);
        assert_eq!(f("grass_block").shears_speed, None);
        assert!(f("ice").unstable);
        assert!(f("mycelium").unstable);
        assert!(!f("waxed_copper_block").unstable);
        assert!(f("grass_block").unstable);
        assert!(f("white_carpet").constrained && f("white_carpet").support_mandatory);
        for gone in [
            "wheat",
            "kelp",
            "vine",
            "dandelion",
            "oak_sign",
            "white_banner",
            "chest",
            "oak_fence",
            "cobblestone_wall",
            "lava",
            "exposed_copper",
            "lantern",
            "tube_coral_block",
            "lightning_rod",
            "farmland",
            "dried_ghast",
            "conduit",
            "sea_pickle",
            "oak_shelf",
            "lantern",
            "grindstone",
            "anvil",
        ] {
            assert!(
                !d.blocks.iter().any(|b| b.block_id == gone),
                "{gone} must not be offered"
            );
        }
        assert_eq!(f("snow").recoverability, Recoverability::SilkGated);
        assert_eq!(f("snow").gate, Gate::Silk);
        assert!(!f("slime_block").support_mandatory);
        assert!(!f("cobweb").support_mandatory && !f("white_stained_glass").support_mandatory);
        assert!(f("sand").support_mandatory && f("white_carpet").support_mandatory);
        let logs: Vec<_> = d
            .blocks
            .iter()
            .filter(|b| b.block_id == "oak_log")
            .collect();
        assert_eq!(logs.len(), 2);
        assert!(logs.iter().any(|b| b.color_id == 13));
        assert!(logs.iter().any(|b| b.color_id == 34));
    }
}
