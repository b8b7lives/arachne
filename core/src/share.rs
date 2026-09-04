use crate::data::{BlockData, CandidateBlock};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const VERSION: char = '2';
const FP_CHARS: usize = 4;
const CK_CHARS: usize = 2;
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedPalette {
    pub enabled: Vec<u8>,
    pub picks: BTreeMap<String, String>,
    #[serde(default)]
    pub version: Option<String>,
}

pub struct Slot {
    pub color_id: u8,
    pub keys: Vec<String>,
}

pub fn block_key(b: &CandidateBlock) -> String {
    if b.properties.is_empty() {
        return b.block_id.clone();
    }
    let mut props: Vec<(&String, &String)> = b.properties.iter().collect();
    props.sort();
    let joined: Vec<String> = props.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{}[{}]", b.block_id, joined.join(","))
}

pub fn slots(data: &BlockData) -> Vec<Slot> {
    let mut ids: Vec<u8> = data.colors.iter().map(|c| c.id).collect();
    ids.sort_unstable();
    ids.into_iter()
        .map(|color_id| {
            let mut keys: Vec<String> = data.candidates_for(color_id).map(block_key).collect();
            keys.sort();
            Slot { color_id, keys }
        })
        .collect()
}

fn fnv1a(seed: u64, bytes: &[u8]) -> u64 {
    let mut h = seed;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

fn fingerprint(slots: &[Slot]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325;
    for slot in slots {
        h = fnv1a(h, &[slot.color_id]);
        for k in &slot.keys {
            h = fnv1a(h, k.as_bytes());
            h = fnv1a(h, b"\x1f");
        }
        h = fnv1a(h, b"\x1e");
    }
    h
}

fn to_base64url(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        let chars = match chunk.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };
        for i in 0..chars {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn from_base64url(s: &str) -> Result<Vec<u8>, String> {
    let mut vals = Vec::with_capacity(s.len());
    for c in s.chars() {
        let v = ALPHABET
            .iter()
            .position(|&a| a as char == c)
            .ok_or_else(|| format!("share code has a character that is not in it: {c:?}"))?;
        vals.push(v as u32);
    }
    let mut out = Vec::new();
    for chunk in vals.chunks(4) {
        if chunk.len() == 1 {
            return Err("share code is truncated".to_string());
        }
        let mut n = 0u32;
        for (i, v) in chunk.iter().enumerate() {
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() >= 3 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() == 4 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn mul_add(value: &mut Vec<u8>, mul: u32, add: u32) {
    let mut carry = add as u64;
    for byte in value.iter_mut() {
        let cur = (*byte as u64) * (mul as u64) + carry;
        *byte = cur as u8;
        carry = cur >> 8;
    }
    while carry > 0 {
        value.push(carry as u8);
        carry >>= 8;
    }
}

fn div_rem(value: &mut Vec<u8>, div: u32) -> u32 {
    let mut rem = 0u64;
    for byte in value.iter_mut().rev() {
        let cur = (rem << 8) | (*byte as u64);
        *byte = (cur / div as u64) as u8;
        rem = cur % div as u64;
    }
    while value.last() == Some(&0) {
        value.pop();
    }
    rem as u32
}

fn checksum(body: &str) -> String {
    let h = fnv1a(0xcbf2_9ce4_8422_2325, body.as_bytes());
    let bits = (h & 0xfff) as u32;
    let mut out = String::new();
    out.push(ALPHABET[((bits >> 6) & 63) as usize] as char);
    out.push(ALPHABET[(bits & 63) as usize] as char);
    out
}

fn fp_string(slots: &[Slot]) -> String {
    let h = fingerprint(slots);
    let bits = (h & 0xff_ffff) as u32;
    let mut out = String::new();
    for i in 0..FP_CHARS {
        out.push(ALPHABET[((bits >> (18 - 6 * i)) & 63) as usize] as char);
    }
    out
}

pub fn encode(data: &BlockData, palette: &SharedPalette) -> Result<String, String> {
    let slots = slots(data);
    let mut digits: Vec<u32> = Vec::with_capacity(slots.len());
    for slot in &slots {
        let cid = slot.color_id.to_string();
        let digit = if !palette.enabled.contains(&slot.color_id) {
            0
        } else {
            let key = palette.picks.get(&cid).ok_or_else(|| {
                format!("color {cid} is on but has no block; resolve the pick before sharing")
            })?;
            let at = slot
                .keys
                .iter()
                .position(|k| k == key)
                .ok_or_else(|| format!("color {cid}: {key} is not a candidate"))?;
            (at + 1) as u32
        };
        digits.push(digit);
    }

    let mut value: Vec<u8> = Vec::new();
    for (slot, digit) in slots.iter().zip(&digits).rev() {
        mul_add(&mut value, slot.keys.len() as u32 + 1, *digit);
    }
    while value.last() == Some(&0) {
        value.pop();
    }

    let at = match &palette.version {
        None => 0,
        Some(v) => {
            data.version_index(v)
                .ok_or_else(|| format!("{v} is not a release this data knows"))?
                + 1
        }
    };
    if at >= ALPHABET.len() {
        return Err("too many releases to carry in a share code".to_string());
    }
    let stamp = ALPHABET[at] as char;
    let body = format!(
        "{VERSION}{stamp}{}{}",
        fp_string(&slots),
        to_base64url(&value)
    );
    Ok(format!("{body}{}", checksum(&body)))
}

pub fn decode(data: &BlockData, code: &str) -> Result<SharedPalette, String> {
    let code = code.trim();
    if code.len() < 2 + FP_CHARS + CK_CHARS {
        return Err("share code is too short to be one".to_string());
    }
    let (body, ck) = code.split_at(code.len() - CK_CHARS);
    if checksum(body) != ck {
        return Err("share code is damaged; it may have been cut short in transit".to_string());
    }
    let mut chars = body.chars();
    if chars.next() != Some(VERSION) {
        return Err("share code came from a different version of Arachne".to_string());
    }
    let stamp = chars.next().ok_or("share code is missing its release")?;
    let at = ALPHABET
        .iter()
        .position(|c| *c as char == stamp)
        .ok_or("share code names no release")?;
    let version = match at {
        0 => None,
        n => Some(
            data.meta
                .versions
                .get(n - 1)
                .ok_or("share code names a release this data does not have")?
                .clone(),
        ),
    };
    let slots = slots(data);
    let fp: String = chars.by_ref().take(FP_CHARS).collect();
    if fp != fp_string(&slots) {
        return Err(
            "share code was made against a different block list, so it would decode to \
             different blocks"
                .to_string(),
        );
    }
    let payload: String = chars.collect();
    let mut value = from_base64url(&payload)?;

    let mut enabled = Vec::new();
    let mut picks = BTreeMap::new();
    for slot in &slots {
        let radix = slot.keys.len() as u32 + 1;
        let digit = div_rem(&mut value, radix);
        if digit == 0 {
            continue;
        }
        let key = slot
            .keys
            .get((digit - 1) as usize)
            .ok_or_else(|| format!("color {}: share code names no such block", slot.color_id))?;
        enabled.push(slot.color_id);
        picks.insert(slot.color_id.to_string(), key.clone());
    }
    if !value.is_empty() {
        return Err("share code carries more than this palette has room for".to_string());
    }
    Ok(SharedPalette {
        enabled,
        picks,
        version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> BlockData {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../data/blocks-26.2.json"
        ))
        .expect("blocks data");
        BlockData::from_json(&json).expect("parse")
    }

    fn full(data: &BlockData) -> SharedPalette {
        let mut enabled = Vec::new();
        let mut picks = BTreeMap::new();
        for slot in slots(data) {
            if slot.keys.is_empty() {
                continue;
            }
            enabled.push(slot.color_id);
            picks.insert(slot.color_id.to_string(), slot.keys[0].clone());
        }
        SharedPalette {
            enabled,
            picks,
            version: None,
        }
    }

    #[test]
    fn round_trips_a_full_palette() {
        let d = data();
        let p = full(&d);
        let code = encode(&d, &p).expect("encode");
        let back = decode(&d, &code).expect("decode");
        assert_eq!(back.enabled, p.enabled);
        assert_eq!(back.picks, p.picks);
    }

    #[test]
    fn a_full_palette_fits_in_a_short_code() {
        let d = data();
        let code = encode(&d, &full(&d)).expect("encode");
        assert!(code.len() <= 40, "{} chars: {code}", code.len());
    }

    #[test]
    fn round_trips_a_sparse_palette() {
        let d = data();
        let all = full(&d);
        let keep: Vec<u8> = all.enabled.iter().copied().take(3).collect();
        let picks: BTreeMap<String, String> = keep
            .iter()
            .map(|c| {
                let k = c.to_string();
                (k.clone(), all.picks[&k].clone())
            })
            .collect();
        let p = SharedPalette {
            enabled: keep.clone(),
            picks,
            version: None,
        };
        let code = encode(&d, &p).expect("encode");
        let back = decode(&d, &code).expect("decode");
        assert_eq!(back.enabled, keep);
        assert_eq!(back.picks, p.picks);
    }

    #[test]
    fn an_empty_palette_still_round_trips() {
        let d = data();
        let p = SharedPalette {
            enabled: vec![],
            picks: BTreeMap::new(),
            version: None,
        };
        let code = encode(&d, &p).expect("encode");
        let back = decode(&d, &code).expect("decode");
        assert!(back.enabled.is_empty() && back.picks.is_empty());
    }

    #[test]
    fn the_last_color_survives_the_round_trip() {
        let d = data();
        let all = slots(&d);
        let last = all.last().expect("a last slot");
        let mut picks = BTreeMap::new();
        picks.insert(
            last.color_id.to_string(),
            last.keys.last().expect("a candidate").clone(),
        );
        let p = SharedPalette {
            enabled: vec![last.color_id],
            picks: picks.clone(),
            version: None,
        };
        let back = decode(&d, &encode(&d, &p).expect("encode")).expect("decode");
        assert_eq!(back.picks, picks);
    }

    #[test]
    fn a_truncated_code_is_refused() {
        let d = data();
        let code = encode(&d, &full(&d)).expect("encode");
        let cut = &code[..code.len() - 3];
        assert!(decode(&d, cut).is_err());
    }

    #[test]
    fn a_typo_is_refused() {
        let d = data();
        let code = encode(&d, &full(&d)).expect("encode");
        let mut bytes: Vec<char> = code.chars().collect();
        let i = bytes.len() / 2;
        bytes[i] = if bytes[i] == 'A' { 'B' } else { 'A' };
        let typo: String = bytes.into_iter().collect();
        assert!(decode(&d, &typo).is_err(), "{typo}");
    }

    #[test]
    fn a_code_against_a_different_block_list_is_refused() {
        let d = data();
        let code = encode(&d, &full(&d)).expect("encode");
        let mut thinner = data();
        let victim = thinner.blocks.iter().position(|b| {
            thinner
                .blocks
                .iter()
                .filter(|o| o.color_id == b.color_id)
                .count()
                > 1
        });
        thinner.blocks.remove(victim.expect("a color with spares"));
        let err = decode(&thinner, &code).expect_err("must refuse");
        assert!(err.contains("different block list"), "{err}");
    }

    #[test]
    fn ordering_ignores_where_a_block_sits_in_the_array() {
        let d = data();
        let code = encode(&d, &full(&d)).expect("encode");
        let mut shuffled = data();
        shuffled.blocks.reverse();
        assert_eq!(
            decode(&shuffled, &code).expect("decode").picks,
            decode(&d, &code).expect("decode").picks,
            "a reordered blocks[] must not change what a code means"
        );
    }

    #[test]
    fn an_unresolved_pick_is_refused_rather_than_defaulted() {
        let d = data();
        let slot = slots(&d).into_iter().find(|s| !s.keys.is_empty()).unwrap();
        let p = SharedPalette {
            enabled: vec![slot.color_id],
            picks: BTreeMap::new(),
            version: None,
        };
        let err = encode(&d, &p).expect_err("must refuse");
        assert!(err.contains("resolve the pick"), "{err}");
    }

    #[test]
    fn the_release_rides_along_and_survives_the_trip() {
        let d = data();
        for want in [
            None,
            Some("1.13".to_string()),
            Some("1.16".to_string()),
            Some("26.2".to_string()),
        ] {
            let p = SharedPalette {
                version: want.clone(),
                ..full(&d)
            };
            let code = encode(&d, &p).expect("encodes");
            let back = decode(&d, &code).expect("decodes");
            assert_eq!(back.version, want, "code {code}");
            assert_eq!(back.enabled, p.enabled);
            assert_eq!(back.picks, p.picks);
        }
    }

    #[test]
    fn a_release_costs_one_character() {
        let d = data();
        let p = full(&d);
        let bare = encode(&d, &p).expect("encodes").len();
        let stamped = encode(
            &d,
            &SharedPalette {
                version: Some("1.16".into()),
                ..p
            },
        )
        .expect("encodes")
        .len();
        assert_eq!(bare, stamped, "the release is a fixed-width stamp");
    }

    #[test]
    fn a_release_this_data_lacks_is_refused() {
        let d = data();
        let p = SharedPalette {
            version: Some("1.7.10".into()),
            ..full(&d)
        };
        assert!(encode(&d, &p).is_err());
    }
}
