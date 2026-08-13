use crate::nbt::Tag;
use crate::quantize::Grid;

pub fn mapdat_to_nbt(grid: &Grid, data_version: i32) -> Tag {
    assert_eq!(
        (grid.width, grid.height),
        (128, 128),
        "map.dat is one map tile"
    );
    let mut colors = vec![0u8; 128 * 128];
    for x in 0..128 {
        for z in 0..128 {
            colors[z * 128 + x] = match grid.cell(x, z) {
                None => 1,
                Some((cid, tone)) => cid * 4 + tone.mapdat_offset(),
            };
        }
    }
    let dimension = if data_version >= 2566 {
        ("dimension", Tag::String("minecraft:overworld".into()))
    } else {
        ("dimension", Tag::Byte(0))
    };
    Tag::compound(vec![
        (
            "data",
            Tag::compound(vec![
                ("scale", Tag::Byte(0)),
                dimension,
                ("unlimitedTracking", Tag::Byte(0)),
                ("trackingPosition", Tag::Byte(0)),
                ("locked", Tag::Byte(1)),
                ("height", Tag::Short(128)),
                ("width", Tag::Short(128)),
                ("xCenter", Tag::Int(0)),
                ("zCenter", Tag::Int(0)),
                ("colors", Tag::ByteArray(colors)),
            ]),
        ),
        ("DataVersion", Tag::Int(data_version)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::palette::Tone;

    #[test]
    fn bytes_encode_color_and_tone() {
        let mut cells = vec![None; 128 * 128];
        cells[0] = Some((8u8, Tone::Light));
        cells[128] = Some((29u8, Tone::Dark));
        let grid = Grid {
            width: 128,
            height: 128,
            cells,
        };
        let tag = mapdat_to_nbt(&grid, 4903);
        let Some(data) = tag.get("data") else {
            panic!()
        };
        let Some(Tag::ByteArray(colors)) = data.get("colors") else {
            panic!()
        };
        assert_eq!(colors[0], 8 * 4 + 2);
        assert_eq!(colors[128], 29 * 4);
        assert_eq!(colors[1], 1);
        assert_eq!(tag.get("DataVersion"), Some(&Tag::Int(4903)));
    }
}
