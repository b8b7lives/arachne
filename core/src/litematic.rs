use crate::nbt::Tag;
use crate::schem::{Schem, SchemConfig, palette_tags};

pub struct LitematicMeta<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub time_ms: i64,
}

const DATA_VERSION_1_18: i32 = 2860;
const SCHEMATIC_VERSION_BEFORE_1_18: i32 = 5;
const SCHEMATIC_VERSION_FROM_1_18: i32 = 6;
const SCHEMATIC_SUB_VERSION: i32 = 1;

pub fn schematic_version(data_version: i32) -> i32 {
    if data_version >= DATA_VERSION_1_18 {
        SCHEMATIC_VERSION_FROM_1_18
    } else {
        SCHEMATIC_VERSION_BEFORE_1_18
    }
}

pub fn bits_for(palette_len: usize) -> u32 {
    let n = palette_len.saturating_sub(1) as u32;
    (u32::BITS - n.leading_zeros()).max(2)
}

pub fn pack(bits: u32, entries: &[u32]) -> Vec<i64> {
    let total = entries.len() as u64 * u64::from(bits);
    let n = (total.div_ceil(64) as usize).max(1);
    let mut longs = vec![0u64; n];
    let mask = (1u64 << bits) - 1;
    for (i, &v) in entries.iter().enumerate() {
        let start = i as u64 * u64::from(bits);
        let si = (start >> 6) as usize;
        let ei = (((i as u64 + 1) * u64::from(bits) - 1) >> 6) as usize;
        let sb = (start & 63) as u32;
        let v = u64::from(v) & mask;
        longs[si] = longs[si] & !(mask << sb) | (v << sb);
        if si != ei {
            let end_off = 64 - sb;
            let j1 = bits - end_off;
            longs[ei] = (longs[ei] >> j1) << j1 | (v >> end_off);
        }
    }
    longs.into_iter().map(|l| l as i64).collect()
}

pub fn unpack(bits: u32, count: usize, longs: &[i64]) -> Vec<u32> {
    let mask = (1u64 << bits) - 1;
    (0..count)
        .map(|i| {
            let start = i as u64 * u64::from(bits);
            let si = (start >> 6) as usize;
            let ei = (((i as u64 + 1) * u64::from(bits) - 1) >> 6) as usize;
            let sb = (start & 63) as u32;
            let a = longs[si] as u64;
            if si == ei {
                ((a >> sb) & mask) as u32
            } else {
                let end_off = 64 - sb;
                (((a >> sb) | ((longs[ei] as u64) << end_off)) & mask) as u32
            }
        })
        .collect()
}

fn vec3(x: i32, y: i32, z: i32) -> Tag {
    Tag::compound(vec![
        ("x", Tag::Int(x)),
        ("y", Tag::Int(y)),
        ("z", Tag::Int(z)),
    ])
}

pub fn schem_to_litematic(s: &Schem, cfg: &SchemConfig, meta: &LitematicMeta) -> Tag {
    let [w, h, l] = s.size;
    let (wu, hu, lu) = (w as usize, h as usize, l as usize);
    let volume = wu * hu * lu;
    let mut palette = vec![Tag::compound(vec![(
        "Name",
        Tag::String("minecraft:air".into()),
    )])];
    palette.extend(palette_tags(s, cfg));
    let bits = bits_for(palette.len());
    let mut entries = vec![0u32; volume];
    for &(x, y, z, idx) in &s.blocks {
        entries[(y as usize * lu + z as usize) * wu + x as usize] = idx + 1;
    }
    let region = Tag::compound(vec![
        ("BlockStatePalette", Tag::list_of(10, palette)),
        ("BlockStates", Tag::LongArray(pack(bits, &entries))),
        ("TileEntities", Tag::list_of(10, vec![])),
        ("Entities", Tag::list_of(10, vec![])),
        ("Position", vec3(0, 0, 0)),
        ("Size", vec3(w, h, l)),
    ]);
    let metadata = Tag::compound(vec![
        ("Name", Tag::String(meta.name.into())),
        ("Author", Tag::String(cfg.author.clone())),
        ("Description", Tag::String(meta.description.into())),
        ("RegionCount", Tag::Int(1)),
        ("TotalVolume", Tag::Int(volume as i32)),
        ("TotalBlocks", Tag::Int(s.blocks.len() as i32)),
        ("TimeCreated", Tag::Long(meta.time_ms)),
        ("TimeModified", Tag::Long(meta.time_ms)),
        ("EnclosingSize", vec3(w, h, l)),
    ]);
    Tag::compound(vec![
        ("MinecraftDataVersion", Tag::Int(cfg.data_version)),
        ("Version", Tag::Int(schematic_version(cfg.data_version))),
        ("SubVersion", Tag::Int(SCHEMATIC_SUB_VERSION)),
        ("Metadata", metadata),
        (
            "Regions",
            Tag::Compound(vec![(meta.name.to_string(), region)]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::BlockData;
    use crate::nbt::{read_root, write_root};
    use crate::palette::Tone;
    use crate::quantize::Grid;
    use crate::schem::build_schem;
    use crate::staircase::HeightMode;
    use crate::support::SupportMode;
    use std::collections::BTreeMap;

    #[test]
    fn bits_follow_the_reader() {
        for (n, b) in [
            (1, 2),
            (2, 2),
            (4, 2),
            (5, 3),
            (8, 3),
            (9, 4),
            (16, 4),
            (17, 5),
            (33, 6),
            (65, 7),
        ] {
            assert_eq!(bits_for(n), b, "palette of {n}");
        }
    }

    #[test]
    fn pack_round_trips_and_sizes_like_the_reader() {
        for bits in 2..=9u32 {
            let count = 1000usize;
            let entries: Vec<u32> = (0..count)
                .map(|i| ((i as u64 * 2654435761 + u64::from(bits)) % (1u64 << bits)) as u32)
                .collect();
            let longs = pack(bits, &entries);
            let expect = ((count as u64 * u64::from(bits)).div_ceil(64)) as usize;
            assert_eq!(longs.len(), expect, "{bits} bits");
            assert_eq!(unpack(bits, count, &longs), entries, "{bits} bits");
        }
        assert_eq!(pack(2, &[]).len(), 1);
    }

    #[test]
    fn versions_by_target() {
        for (dv, v) in [
            (1519, 5),
            (1631, 5),
            (1952, 5),
            (2730, 5),
            (2860, 6),
            (3700, 6),
            (3837, 6),
            (3953, 6),
            (4903, 6),
        ] {
            assert_eq!(schematic_version(dv), v, "data version {dv}");
        }
    }

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .unwrap();
        BlockData::from_json(&json).unwrap()
    }

    #[test]
    fn region_matches_the_structure() {
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
            height_mode: HeightMode::Stepped { cliff_cap: None },
            support_mode: SupportMode::Important,
            support_block_id: "cobblestone".into(),
            selection,
            data_version: d.meta.data_version,
            author: "arachne".into(),
        };
        let s = build_schem(&grid, &cfg);
        let meta = LitematicMeta {
            name: "test_x0_z0",
            description: "d",
            time_ms: 1234,
        };
        let tag = schem_to_litematic(&s, &cfg, &meta);
        let bytes = write_root("", &tag);
        let (_, back) = read_root(&bytes).unwrap();
        assert_eq!(back, tag);

        assert_eq!(tag.get("Version"), Some(&Tag::Int(6)));
        assert_eq!(
            tag.get("MinecraftDataVersion"),
            Some(&Tag::Int(d.meta.data_version))
        );
        let md = tag.get("Metadata").unwrap();
        assert_eq!(md.get("Name"), Some(&Tag::String("test_x0_z0".into())));
        assert_eq!(md.get("Author"), Some(&Tag::String("arachne".into())));
        assert_eq!(
            md.get("TotalBlocks"),
            Some(&Tag::Int(s.blocks.len() as i32))
        );
        let [w, h, l] = s.size;
        assert_eq!(md.get("TotalVolume"), Some(&Tag::Int(w * h * l)));

        let region = tag.get("Regions").unwrap().get("test_x0_z0").unwrap();
        let Some(Tag::List(10, palette)) = region.get("BlockStatePalette") else {
            panic!("palette")
        };
        assert_eq!(
            palette[0].get("Name"),
            Some(&Tag::String("minecraft:air".into()))
        );
        assert_eq!(palette.len(), s.palette_colors.len() + 2);
        let Some(Tag::LongArray(longs)) = region.get("BlockStates") else {
            panic!("states")
        };
        let bits = bits_for(palette.len());
        let entries = unpack(bits, (w * h * l) as usize, longs);
        assert_eq!(entries.iter().filter(|&&e| e != 0).count(), s.blocks.len());
        for &(x, y, z, idx) in &s.blocks {
            let i = (y as usize * l as usize + z as usize) * w as usize + x as usize;
            assert_eq!(entries[i], idx + 1, "block at {x},{y},{z}");
        }
        assert_eq!(region.get("Size"), Some(&vec3(w, h, l)));
    }
}
