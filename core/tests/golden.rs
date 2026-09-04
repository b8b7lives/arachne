use arachne_core::data::{BlockData, CandidateBlock};
use arachne_core::litematic::{LitematicMeta, bits_for, schem_to_litematic, unpack};
use arachne_core::nbt::{Tag, read_root, write_root};
use arachne_core::palette::Tone;
use arachne_core::quantize::Grid;
use arachne_core::schem::{SchemConfig, build_schem, schem_to_nbt};
use arachne_core::staircase::HeightMode;
use arachne_core::support::SupportMode;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};

const AUTHOR: &str = "arachne";

fn gz(bytes: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

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
        assert_eq!(
            cand.support_mandatory, s.support_mandatory,
            "fixture selection drifted from block data: {}",
            s.block_id
        );
        out.insert(s.color_id, &*Box::leak(Box::new(cand.clone())));
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
        data_version: data.meta.data_version,
        author: AUTHOR.into(),
    }
}

type BlockMap = HashMap<(i32, i32, i32), (String, Vec<(String, String)>)>;

fn resolve_palette(palette: &[Tag]) -> Vec<(String, Vec<(String, String)>)> {
    palette
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
        .collect()
}

fn semantic_blocks(tag: &Tag) -> (BlockMap, [i32; 3], i32) {
    let Some(Tag::List(_, palette)) = tag.get("palette") else {
        panic!("palette")
    };
    let resolved = resolve_palette(palette);
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
fn classic_full_layer() {
    assert_schem_matches(
        "nbt-classic-alldouble.nbt.gz",
        "materials-classic-alldouble.json",
        HeightMode::Stepped { cliff_cap: Some(1) },
        SupportMode::FullLayer,
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
    let tag = arachne_core::mapdat::mapdat_to_nbt(&grid, load_data().meta.data_version);
    let ours = write_root("", &tag);
    let theirs = fixture_bytes("mapdat.dat.gz");
    assert_eq!(ours, theirs, "map.dat byte-exact regression");
}

#[test]
#[ignore = "regenerates every fixture from the current pipeline: cargo test -p arachne-core --test golden bless_fixtures -- --ignored"]
fn bless_fixtures() {
    use arachne_core::image::LinImage;
    use arachne_core::palette::Palette;
    use arachne_core::quantize::{Dither, FLOYD_STEINBERG, quantize};

    let data = load_data();
    let all_ids: Vec<u8> = data.buildable_colors().map(|c| c.id).collect();
    let (w, h) = (128usize, 128usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for z in 0..h {
        for x in 0..w {
            rgba.push(((x * 2 + (z * 7) % 61) % 256) as u8);
            rgba.push(
                ((z as f32 * 2.0 + 127.0 * (x as f32 / 9.0).sin() + 128.0).rem_euclid(256.0)) as u8,
            );
            rgba.push(((x + z + (x * z) % 37) % 256) as u8);
            rgba.push(255);
        }
    }
    let img = LinImage::from_srgb_rgba(w, h, &rgba);
    let fs = Dither::Diffusion {
        kernel: FLOYD_STEINBERG,
        serpentine: true,
    };
    let grids = [
        (
            "grid-classic.json",
            quantize(
                &img,
                &Palette::build(&data, &all_ids, &[Tone::Dark, Tone::Normal, Tone::Light]),
                &fs,
                None,
            ),
        ),
        (
            "grid-flat.json",
            quantize(
                &img,
                &Palette::build(&data, &all_ids, &[Tone::Normal]),
                &fs,
                None,
            ),
        ),
        (
            "grid-mapdat.json",
            quantize(
                &img,
                &Palette::build(
                    &data,
                    &all_ids,
                    &[Tone::Dark, Tone::Normal, Tone::Light, Tone::Unobtainable],
                ),
                &fs,
                None,
            ),
        ),
    ];
    let write = |name: &str, bytes: &[u8]| std::fs::write(fixture_path(name), bytes).unwrap();
    for (name, grid) in &grids {
        let mut colors = Vec::with_capacity(grid.cells.len());
        let mut tones = Vec::with_capacity(grid.cells.len());
        for cell in grid.cells.iter().flatten() {
            colors.push(cell.0);
            tones.push(cell.1.mapdat_offset());
        }
        let doc = serde_json::json!({
            "width": grid.width, "height": grid.height,
            "colors": colors, "tones": tones,
        });
        write(name, serde_json::to_string(&doc).unwrap().as_bytes());
    }

    let mut selection_doc = serde_json::Map::new();
    for c in &data.colors {
        let cands: Vec<&CandidateBlock> = data.candidates_for(c.id).collect();
        if cands.is_empty() {
            continue;
        }
        let pick = if c.id % 3 == 0 {
            cands
                .iter()
                .find(|b| b.support_mandatory)
                .copied()
                .unwrap_or(cands[0])
        } else {
            cands[0]
        };
        selection_doc.insert(
            c.id.to_string(),
            serde_json::json!({
                "color_id": c.id,
                "block_id": pick.block_id,
                "properties": pick.properties,
                "support_mandatory": pick.support_mandatory,
            }),
        );
    }
    write(
        "selection.json",
        serde_json::to_string(&serde_json::Value::Object(selection_doc))
            .unwrap()
            .as_bytes(),
    );

    let cases: [(&str, &str, HeightMode, SupportMode); 4] = [
        (
            "nbt-classic-none.nbt.gz",
            "materials-classic-none.json",
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::None,
        ),
        (
            "nbt-classic-important.nbt.gz",
            "materials-classic-important.json",
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::Important,
        ),
        (
            "nbt-classic-alldouble.nbt.gz",
            "materials-classic-alldouble.json",
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::FullLayer,
        ),
        (
            "nbt-flat-important.nbt.gz",
            "materials-flat-important.json",
            HeightMode::Flat,
            SupportMode::Important,
        ),
    ];
    for (nbt_name, mats_name, height_mode, support_mode) in cases {
        let grid = load_grid(if matches!(height_mode, HeightMode::Flat) {
            "grid-flat.json"
        } else {
            "grid-classic.json"
        });
        let cfg = config(&data, height_mode, support_mode);
        let schem = build_schem(&grid, &cfg);
        let tag = schem_to_nbt(&schem, &cfg);
        write(nbt_name, &gz(&write_root("", &tag)));
        let mats: HashMap<String, u32> = schem
            .materials
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect();
        let doc = serde_json::json!({
            "materials": mats, "support_count": schem.support_count,
        });
        write(mats_name, serde_json::to_string(&doc).unwrap().as_bytes());
    }

    let grid = load_grid("grid-mapdat.json");
    let tag = arachne_core::mapdat::mapdat_to_nbt(&grid, data.meta.data_version);
    write("mapdat.dat.gz", &gz(&write_root("", &tag)));
}

fn litematic_blocks(tag: &Tag) -> (BlockMap, [i32; 3], i32) {
    let Some(Tag::Int(dv)) = tag.get("MinecraftDataVersion") else {
        panic!("MinecraftDataVersion")
    };
    let Some(Tag::Compound(regions)) = tag.get("Regions") else {
        panic!("Regions")
    };
    assert_eq!(regions.len(), 1, "one region per file");
    let region = &regions[0].1;
    let Some(Tag::List(_, palette)) = region.get("BlockStatePalette") else {
        panic!("BlockStatePalette")
    };
    assert_eq!(
        palette[0].get("Name"),
        Some(&Tag::String("minecraft:air".into()))
    );
    let resolved = resolve_palette(palette);
    let size = region.get("Size").expect("Size");
    let dim = |k: &str| match size.get(k) {
        Some(Tag::Int(v)) => *v,
        other => panic!("Size.{k}: {other:?}"),
    };
    let (w, h, l) = (dim("x"), dim("y"), dim("z"));
    let Some(Tag::LongArray(longs)) = region.get("BlockStates") else {
        panic!("BlockStates")
    };
    let entries = unpack(bits_for(palette.len()), (w * h * l) as usize, longs);
    let mut map = HashMap::new();
    for (i, &e) in entries.iter().enumerate() {
        if e == 0 {
            continue;
        }
        let i = i as i32;
        let (x, z, y) = (i % w, (i / w) % l, i / (w * l));
        map.insert((x, y, z), resolved[e as usize].clone());
    }
    (map, [w, h, l], *dv)
}

#[test]
fn litematic_matches_the_structure_on_a_real_grid() {
    let data = load_data();
    let cases = [
        (
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::Important,
        ),
        (HeightMode::Flat, SupportMode::Important),
        (
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::FullLayer,
        ),
    ];
    for (height_mode, support_mode) in cases {
        let grid = load_grid(if matches!(height_mode, HeightMode::Flat) {
            "grid-flat.json"
        } else {
            "grid-classic.json"
        });
        let cfg = config(&data, height_mode, support_mode);
        let schem = build_schem(&grid, &cfg);
        let nbt = schem_to_nbt(&schem, &cfg);
        let meta = LitematicMeta {
            name: "fixture",
            description: "",
            time_ms: 0,
        };
        let (_, lit) =
            read_root(&write_root("", &schem_to_litematic(&schem, &cfg, &meta))).unwrap();
        let (a, sa, dva) = semantic_blocks(&nbt);
        let (b, sb, dvb) = litematic_blocks(&lit);
        assert_eq!(sa, sb, "size");
        assert_eq!(dva, dvb, "data version");
        assert_eq!(a.len(), b.len(), "block count");
        for (pos, block) in &a {
            assert_eq!(b.get(pos), Some(block), "at {pos:?}");
        }
    }
}

#[test]
#[ignore = "size report, not an assertion: cargo test -p arachne-core --test golden size_report -- --ignored --nocapture"]
fn size_report() {
    let data = load_data();
    let cases: [(&str, HeightMode, SupportMode); 4] = [
        (
            "classic none",
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::None,
        ),
        (
            "classic important",
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::Important,
        ),
        (
            "classic full layer",
            HeightMode::Stepped { cliff_cap: Some(1) },
            SupportMode::FullLayer,
        ),
        ("flat important", HeightMode::Flat, SupportMode::Important),
    ];
    eprintln!(
        "{:<20} {:>7} {:>9} {:>7} {:>11} {:>7}",
        "128x128 fixture", "blocks", "nbt raw", "nbt gz", "litematic", "lit gz"
    );
    for (label, height_mode, support_mode) in cases {
        let grid = load_grid(if matches!(height_mode, HeightMode::Flat) {
            "grid-flat.json"
        } else {
            "grid-classic.json"
        });
        let cfg = config(&data, height_mode, support_mode);
        let schem = build_schem(&grid, &cfg);
        let nbt = write_root("", &schem_to_nbt(&schem, &cfg));
        let meta = LitematicMeta {
            name: "fixture",
            description: "",
            time_ms: 0,
        };
        let lit = write_root("", &schem_to_litematic(&schem, &cfg, &meta));
        eprintln!(
            "{:<20} {:>7} {:>9} {:>7} {:>11} {:>7}",
            label,
            schem.blocks.len(),
            nbt.len(),
            gz(&nbt).len(),
            lit.len(),
            gz(&lit).len()
        );
    }
}

#[test]
#[ignore = "writes the fixture as both formats for an in-game check: ARACHNE_SAMPLE_DIR=<dir> cargo test -p arachne-core --test golden write_samples -- --ignored"]
fn write_samples() {
    let Ok(dir) = std::env::var("ARACHNE_SAMPLE_DIR") else {
        eprintln!("ARACHNE_SAMPLE_DIR is not set; nothing written");
        return;
    };
    let data = load_data();
    let grid = load_grid("grid-classic.json");
    let cfg = config(
        &data,
        HeightMode::Stepped { cliff_cap: Some(1) },
        SupportMode::Important,
    );
    let schem = build_schem(&grid, &cfg);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let meta = LitematicMeta {
        name: "arachne-fixture",
        description: "golden fixture, classic staircase, filler where needed",
        time_ms: now,
    };
    let lit = gz(&write_root("", &schem_to_litematic(&schem, &cfg, &meta)));
    let nbt = gz(&write_root("", &schem_to_nbt(&schem, &cfg)));
    std::fs::write(format!("{dir}/arachne-fixture.litematic"), lit).unwrap();
    std::fs::write(format!("{dir}/arachne-fixture.nbt"), nbt).unwrap();
    eprintln!(
        "wrote {dir}/arachne-fixture.litematic and arachne-fixture.nbt ({} blocks)",
        schem.blocks.len()
    );
}
