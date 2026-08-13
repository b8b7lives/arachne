use crate::data::BlockData;
use crate::nbt::Tag;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PaletteEntry {
    pub block: Option<usize>,
    pub block_id: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct ViewModel {
    pub size: [i32; 3],
    pub w: i32,
    pub d: i32,
    pub support: usize,
    pub palette: Vec<PaletteEntry>,
    pub cells: Vec<i32>,
    pub heights: Vec<i32>,
}

fn ints(tag: Option<&Tag>, key: &str) -> Result<Vec<i32>, String> {
    match tag {
        Some(Tag::List(_, items)) => items
            .iter()
            .map(|t| match t {
                Tag::Int(v) => Ok(*v),
                _ => Err(format!("{key}: expected int")),
            })
            .collect(),
        _ => Err(format!("{key}: expected a list")),
    }
}

fn resolve(name: &str, props: Option<&Tag>, data: &BlockData) -> Option<usize> {
    let block_id = name.strip_prefix("minecraft:").unwrap_or(name);
    let pairs: Vec<(&str, &str)> = match props {
        Some(Tag::Compound(kv)) => kv
            .iter()
            .filter_map(|(k, v)| match v {
                Tag::String(s) => Some((k.as_str(), s.as_str())),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    data.blocks.iter().position(|b| {
        b.block_id == block_id
            && b.properties.len() == pairs.len()
            && pairs
                .iter()
                .all(|(k, v)| b.properties.get(*k).map(String::as_str) == Some(*v))
    })
}

pub fn view_model(root: &Tag, data: &BlockData) -> Result<ViewModel, String> {
    let size = ints(root.get("size"), "size")?;
    if size.len() != 3 {
        return Err("size: expected 3 ints".to_string());
    }
    let (w, d) = (size[0], size[2]);
    if w <= 0 || d <= 0 {
        return Err("size: width and depth must be positive".to_string());
    }

    let palette_tags = match root.get("palette") {
        Some(Tag::List(_, items)) => items,
        _ => return Err("palette: expected a list".to_string()),
    };
    let palette: Vec<PaletteEntry> = palette_tags
        .iter()
        .map(|entry| {
            let name = match entry.get("Name") {
                Some(Tag::String(s)) => s.clone(),
                _ => return Err("palette entry: missing Name".to_string()),
            };
            let block = resolve(&name, entry.get("Properties"), data);
            Ok(PaletteEntry {
                block_id: name.strip_prefix("minecraft:").unwrap_or(&name).to_string(),
                display_name: block
                    .map(|i| data.blocks[i].display_name.clone())
                    .unwrap_or_else(|| {
                        name.strip_prefix("minecraft:").unwrap_or(&name).to_string()
                    }),
                block,
            })
        })
        .collect::<Result<_, String>>()?;
    if palette.is_empty() {
        return Err("palette: empty".to_string());
    }
    let support = palette.len() - 1;

    let cell_count = (w as usize) * (d as usize);
    let mut cells = vec![-1i32; cell_count];
    let mut heights = vec![0i32; cell_count];

    let blocks = match root.get("blocks") {
        Some(Tag::List(_, items)) => items,
        _ => return Err("blocks: expected a list".to_string()),
    };
    for b in blocks {
        let pos = ints(b.get("pos"), "pos")?;
        if pos.len() != 3 {
            return Err("pos: expected 3 ints".to_string());
        }
        let state = match b.get("state") {
            Some(Tag::Int(v)) => *v,
            _ => return Err("block: missing state".to_string()),
        };
        let (x, y, z) = (pos[0], pos[1], pos[2]);
        if x < 0 || x >= w || z < 0 || z >= d {
            continue;
        }
        let i = (z as usize) * (w as usize) + (x as usize);
        let is_support = state as usize == support;
        let take = match cells[i] {
            -1 => true,
            cur => {
                let cur_support = cur as usize == support;
                match (cur_support, is_support) {
                    (true, false) => true,
                    (false, true) => false,
                    _ => y > heights[i],
                }
            }
        };
        if take {
            cells[i] = state;
            heights[i] = y;
        }
    }

    Ok(ViewModel {
        size: [size[0], size[1], size[2]],
        w,
        d,
        support,
        palette,
        cells,
        heights,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::BlockData;
    use crate::nbt::{read_root, write_root};
    use crate::palette::Tone;
    use crate::quantize::Grid;
    use crate::schem::{SchemConfig, build_schem, schem_to_nbt};
    use crate::staircase::HeightMode;
    use crate::support::SupportMode;
    use std::collections::BTreeMap;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .expect("blocks data");
        BlockData::from_json(&json).expect("parse")
    }

    fn rendered(height_mode: HeightMode) -> (BlockData, ViewModel) {
        let d = data();
        let grid = Grid {
            width: 2,
            height: 2,
            cells: vec![
                Some((8u8, Tone::Normal)),
                Some((29u8, Tone::Light)),
                Some((8u8, Tone::Dark)),
                Some((29u8, Tone::Normal)),
            ],
        };
        let mut selection = BTreeMap::new();
        for cid in [8u8, 29] {
            selection.insert(cid, d.candidates_for(cid).next().unwrap());
        }
        let cfg = SchemConfig {
            height_mode,
            support_mode: SupportMode::None,
            support_block_id: "cobblestone".into(),
            selection,
            data_version: d.meta.data_version,
            author: "arachne".into(),
        };
        let schem = build_schem(&grid, &cfg);
        let bytes = write_root("", &schem_to_nbt(&schem, &cfg));
        let (_, root) = read_root(&bytes).expect("read back");
        let vm = view_model(&root, &d).expect("view model");
        (d, vm)
    }

    #[test]
    fn every_column_draws_exactly_one_block() {
        let (_, vm) = rendered(HeightMode::Flat);
        assert_eq!([vm.w, vm.d], [2, 3]);
        assert_eq!(vm.cells.len(), 6);
        assert!(vm.cells.iter().all(|&c| c >= 0), "no column left empty");
    }

    #[test]
    fn the_noobline_row_reads_as_support() {
        let (_, vm) = rendered(HeightMode::Flat);
        for x in 0..vm.w as usize {
            assert_eq!(vm.cells[x] as usize, vm.support, "z=0 is the noobline");
        }
        for i in vm.w as usize..vm.cells.len() {
            assert_ne!(vm.cells[i] as usize, vm.support, "z>0 draws the map block");
        }
    }

    #[test]
    fn palette_entries_resolve_to_the_selected_blocks() {
        let (d, vm) = rendered(HeightMode::Flat);
        for (i, entry) in vm.palette.iter().enumerate() {
            if i == vm.support {
                continue;
            }
            let idx = entry.block.expect("selected blocks resolve");
            assert_eq!(d.blocks[idx].block_id, entry.block_id);
        }
    }

    #[test]
    fn heights_survive_the_round_trip() {
        let (_, vm) = rendered(HeightMode::Stepped { cliff_cap: None });
        let row = |z: usize| -> Vec<i32> {
            (0..vm.w as usize)
                .map(|x| vm.heights[z * vm.w as usize + x])
                .collect()
        };
        assert_ne!(
            row(1),
            row(2),
            "stepped tones give the rows different heights"
        );
    }

    #[test]
    fn resolves_palette_names_against_the_candidate_pool() {
        let d = data();
        let stone = resolve("minecraft:stone", None, &d).expect("stone resolves");
        assert_eq!(d.blocks[stone].block_id, "stone");
        assert!(resolve("minecraft:not_a_block", None, &d).is_none());
    }

    #[test]
    fn properties_must_match_exactly() {
        let d = data();
        let logs: Vec<&crate::data::CandidateBlock> = d
            .blocks
            .iter()
            .filter(|b| b.properties.contains_key("axis"))
            .collect();
        if logs.is_empty() {
            return;
        }
        let want = logs[0];
        let props = Tag::Compound(
            want.properties
                .iter()
                .map(|(k, v)| (k.clone(), Tag::String(v.clone())))
                .collect(),
        );
        let hit = resolve(&format!("minecraft:{}", want.block_id), Some(&props), &d)
            .expect("exact properties resolve");
        assert_eq!(d.blocks[hit].properties, want.properties);
        assert!(
            resolve(&format!("minecraft:{}", want.block_id), None, &d)
                .map(|i| d.blocks[i].properties.is_empty())
                .unwrap_or(true),
            "a bare name must not match a stateful block"
        );
    }
}
