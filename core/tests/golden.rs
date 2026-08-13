use arachne_core::data::{BlockData, CandidateBlock};
use arachne_core::nbt::{Tag, read_root, write_root};
use arachne_core::palette::Tone;
use arachne_core::quantize::Grid;
use arachne_core::schem::{SchemConfig, build_schem, schem_to_nbt};
use arachne_core::staircase::HeightMode;
use arachne_core::support::SupportMode;
use flate2::read::GzDecoder;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;

const AUTHOR: &str = "rebane2001.com/mapartcraft";
const DATA_VERSION: i32 = 3463;

fn fixture_path(name: &str) -> String {
    format!("{}/../golden/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    let raw = std::fs::read(fixture_path(name)).expect("fixture present (run gen-fixtures.mjs)");
    if name.ends_with(".gz") {
        let mut out = Vec::new();
        GzDecoder::new(&raw[..]).read_to_end(&mut out).unwrap();
        out
    } else {
        raw
    }
}

#[derive(Deserialize)]
struct FixtureGrid {
    width: usize,
    height: usize,
    colors: Vec<u8>,
    tones: Vec<u8>,
}

fn load_grid(name: &str) -> Grid {
    let g: FixtureGrid = serde_json::from_slice(&fixture_bytes(name)).unwrap();
    let tone = |t: u8| match t {
        0 => Tone::Dark,
        1 => Tone::Normal,
        2 => Tone::Light,
        _ => Tone::Unobtainable,
    };
    Grid {
        width: g.width,
        height: g.height,
        cells: g
            .colors
            .iter()
            .zip(g.tones.iter())
            .map(|(&c, &t)| Some((c, tone(t))))
            .collect(),
    }
}

#[derive(Deserialize)]
struct FixtureSelection {
    color_id: u8,
    block_id: String,
    properties: HashMap<String, String>,
    support_mandatory: bool,
}

fn load_data() -> BlockData {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../data/blocks-26.2.json"
    ))
    .unwrap();
    BlockData::from_json(&json).unwrap()
}

fn load_selection(data: &BlockData) -> BTreeMap<u8, &'static CandidateBlock> {
    let sel: HashMap<String, FixtureSelection> =
        serde_json::from_slice(&fixture_bytes("selection.json")).unwrap();
    let mut out = BTreeMap::new();
    for s in sel.values() {
        let cand = data
            .blocks
            .iter()
            .find(|b| {
                b.color_id == s.color_id && b.block_id == s.block_id && b.properties == s.properties
            })
            .unwrap_or_else(|| panic!("candidate {} for color {}", s.block_id, s.color_id));
        let mut patched = cand.clone();
        patched.support_mandatory = s.support_mandatory;
        out.insert(s.color_id, &*Box::leak(Box::new(patched)));
    }
    out
}

fn config<'a>(
    data: &'a BlockData,
    height_mode: HeightMode,
    support_mode: SupportMode,
) -> SchemConfig<'a> {
    SchemConfig {
        height_mode,
        support_mode,
        support_block_id: "cobblestone".into(),
        selection: load_selection(data),
        data_version: DATA_VERSION,
        author: AUTHOR.into(),
    }
}

type BlockMap = HashMap<(i32, i32, i32), (String, Vec<(String, String)>)>;

fn semantic_blocks(tag: &Tag) -> (BlockMap, [i32; 3], i32) {
    let Some(Tag::List(_, palette)) = tag.get("palette") else {
        panic!("palette")
    };
    let resolved: Vec<(String, Vec<(String, String)>)> = palette
        .iter()
        .map(|p| {
            let Some(Tag::String(name)) = p.get("Name") else {
                panic!("Name")
            };
            let mut props = Vec::new();
            if let Some(Tag::Compound(pairs)) = p.get("Properties") {
                for (k, v) in pairs {
                    let Tag::String(v) = v else { panic!("prop") };
                    props.push((k.clone(), v.clone()));
                }
                props.sort();
            }
            (name.clone(), props)
        })
        .collect();
    let Some(Tag::List(_, blocks)) = tag.get("blocks") else {
        panic!("blocks")
    };
    let mut map = HashMap::new();
    for b in blocks {
        let Some(Tag::List(_, pos)) = b.get("pos") else {
            panic!("pos")
        };
        let p: Vec<i32> = pos
            .iter()
            .map(|t| if let Tag::Int(v) = t { *v } else { panic!() })
            .collect();
        let Some(Tag::Int(state)) = b.get("state") else {
            panic!("state")
        };
        let prev = map.insert((p[0], p[1], p[2]), resolved[*state as usize].clone());
        assert!(prev.is_none(), "duplicate position {p:?}");
    }
    let Some(Tag::List(_, size)) = tag.get("size") else {
        panic!("size")
    };
    let s: Vec<i32> = size
        .iter()
        .map(|t| if let Tag::Int(v) = t { *v } else { panic!() })
        .collect();
    let Some(Tag::Int(dv)) = tag.get("DataVersion") else {
        panic!("DataVersion")
    };
    (map, [s[0], s[1], s[2]], *dv)
}

#[derive(Deserialize)]
struct FixtureMaterials {
    materials: HashMap<String, u32>,
    support_count: u32,
}

fn assert_schem_matches(
    fixture: &str,
    materials_fixture: &str,
    height_mode: HeightMode,
    support_mode: SupportMode,
) {
    let data = load_data();
    let grid = load_grid(if matches!(height_mode, HeightMode::Flat) {
        "grid-flat.json"
    } else {
        "grid-classic.json"
    });
    let cfg = config(&data, height_mode, support_mode);
    let schem = build_schem(&grid, &cfg);
    let ours = schem_to_nbt(&schem, &cfg);

    let theirs_bytes = fixture_bytes(fixture);
    let (_, theirs) = read_root(&theirs_bytes).unwrap();
    let (our_blocks, our_size, our_dv) = semantic_blocks(&ours);
    let (their_blocks, their_size, their_dv) = semantic_blocks(&theirs);
    assert_eq!(our_dv, their_dv);
    assert_eq!(our_size, their_size, "{fixture} size");
    assert_eq!(
        our_blocks.len(),
        their_blocks.len(),
        "{fixture} block count"
    );
    for (pos, block) in &their_blocks {
        assert_eq!(our_blocks.get(pos), Some(block), "{fixture} at {pos:?}");
    }

    let m: FixtureMaterials = serde_json::from_slice(&fixture_bytes(materials_fixture)).unwrap();
    assert_eq!(
        m.support_count, schem.support_count,
        "{materials_fixture} supports"
    );
    let theirs_mats: BTreeMap<u8, u32> = m
        .materials
        .iter()
        .map(|(k, v)| (k.parse().unwrap(), *v))
        .collect();
    assert_eq!(theirs_mats, schem.materials, "{materials_fixture}");
}

#[test]
fn classic_none() {
    assert_schem_matches(
        "nbt-classic-none.nbt.gz",
        "materials-classic-none.json",
        HeightMode::Stepped { cliff_cap: Some(1) },
        SupportMode::None,
    );
}

#[test]
fn classic_important() {
    assert_schem_matches(
        "nbt-classic-important.nbt.gz",
        "materials-classic-important.json",
        HeightMode::Stepped { cliff_cap: Some(1) },
        SupportMode::Important,
    );
}

#[test]
fn classic_all_optimized() {
    assert_schem_matches(
        "nbt-classic-allopt.nbt.gz",
        "materials-classic-allopt.json",
        HeightMode::Stepped { cliff_cap: Some(1) },
        SupportMode::AllOptimized,
    );
}

#[test]
fn classic_all_double_optimized() {
    assert_schem_matches(
        "nbt-classic-alldouble.nbt.gz",
        "materials-classic-alldouble.json",
        HeightMode::Stepped { cliff_cap: Some(1) },
        SupportMode::AllDoubleOptimized,
    );
}

#[test]
fn flat_important() {
    assert_schem_matches(
        "nbt-flat-important.nbt.gz",
        "materials-flat-important.json",
        HeightMode::Flat,
        SupportMode::Important,
    );
}

#[test]
fn mapdat_bytes_exact() {
    let grid = load_grid("grid-mapdat.json");
    let tag = arachne_core::mapdat::mapdat_to_nbt(&grid, DATA_VERSION);
    let ours = write_root("", &tag);
    let theirs = fixture_bytes("mapdat.dat.gz");
    assert_eq!(ours, theirs, "map.dat byte-exact parity");
}
