#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    String(String),
    List(u8, Vec<Tag>),
    Compound(Vec<(String, Tag)>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl Tag {
    pub fn type_id(&self) -> u8 {
        match self {
            Tag::Byte(_) => 1,
            Tag::Short(_) => 2,
            Tag::Int(_) => 3,
            Tag::Long(_) => 4,
            Tag::Float(_) => 5,
            Tag::Double(_) => 6,
            Tag::ByteArray(_) => 7,
            Tag::String(_) => 8,
            Tag::List(..) => 9,
            Tag::Compound(_) => 10,
            Tag::IntArray(_) => 11,
            Tag::LongArray(_) => 12,
        }
    }

    pub fn compound(pairs: Vec<(&str, Tag)>) -> Tag {
        Tag::Compound(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn list_of(type_id: u8, items: Vec<Tag>) -> Tag {
        debug_assert!(items.iter().all(|t| t.type_id() == type_id));
        Tag::List(type_id, items)
    }

    pub fn get(&self, key: &str) -> Option<&Tag> {
        match self {
            Tag::Compound(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

pub fn write_root(name: &str, root: &Tag) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(root.type_id());
    write_string(&mut out, name);
    write_payload(&mut out, root);
    out
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    out.extend_from_slice(&(u16::try_from(bytes.len()).expect("string fits u16")).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn write_payload(out: &mut Vec<u8>, tag: &Tag) {
    match tag {
        Tag::Byte(v) => out.push(*v as u8),
        Tag::Short(v) => out.extend_from_slice(&v.to_be_bytes()),
        Tag::Int(v) => out.extend_from_slice(&v.to_be_bytes()),
        Tag::Long(v) => out.extend_from_slice(&v.to_be_bytes()),
        Tag::Float(v) => out.extend_from_slice(&v.to_be_bytes()),
        Tag::Double(v) => out.extend_from_slice(&v.to_be_bytes()),
        Tag::ByteArray(v) => {
            out.extend_from_slice(&(v.len() as i32).to_be_bytes());
            out.extend_from_slice(v);
        }
        Tag::String(v) => write_string(out, v),
        Tag::List(type_id, items) => {
            out.push(*type_id);
            out.extend_from_slice(&(items.len() as i32).to_be_bytes());
            for item in items {
                write_payload(out, item);
            }
        }
        Tag::Compound(pairs) => {
            for (k, v) in pairs {
                out.push(v.type_id());
                write_string(out, k);
                write_payload(out, v);
            }
            out.push(0);
        }
        Tag::IntArray(v) => {
            out.extend_from_slice(&(v.len() as i32).to_be_bytes());
            for i in v {
                out.extend_from_slice(&i.to_be_bytes());
            }
        }
        Tag::LongArray(v) => {
            out.extend_from_slice(&(v.len() as i32).to_be_bytes());
            for i in v {
                out.extend_from_slice(&i.to_be_bytes());
            }
        }
    }
}

pub fn read_root(data: &[u8]) -> Result<(String, Tag), String> {
    let mut r = Reader { data, pos: 0 };
    let type_id = r.u8()?;
    let name = r.string()?;
    let tag = r.payload(type_id)?;
    Ok((name, tag))
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let s = self
            .data
            .get(self.pos..self.pos + n)
            .ok_or("truncated NBT")?;
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn i16(&mut self) -> Result<i16, String> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String, String> {
        let len = self.i16()? as usize;
        String::from_utf8(self.take(len)?.to_vec()).map_err(|e| e.to_string())
    }
    fn payload(&mut self, type_id: u8) -> Result<Tag, String> {
        Ok(match type_id {
            1 => Tag::Byte(self.u8()? as i8),
            2 => Tag::Short(self.i16()?),
            3 => Tag::Int(self.i32()?),
            4 => Tag::Long(self.i64()?),
            5 => Tag::Float(f32::from_be_bytes(self.take(4)?.try_into().unwrap())),
            6 => Tag::Double(f64::from_be_bytes(self.take(8)?.try_into().unwrap())),
            7 => {
                let len = self.i32()? as usize;
                Tag::ByteArray(self.take(len)?.to_vec())
            }
            8 => Tag::String(self.string()?),
            9 => {
                let elem = self.u8()?;
                let len = self.i32()? as usize;
                let mut items = Vec::with_capacity(len);
                for _ in 0..len {
                    items.push(self.payload(elem)?);
                }
                Tag::List(elem, items)
            }
            10 => {
                let mut pairs = Vec::new();
                loop {
                    let t = self.u8()?;
                    if t == 0 {
                        break;
                    }
                    let k = self.string()?;
                    pairs.push((k, self.payload(t)?));
                }
                Tag::Compound(pairs)
            }
            11 => {
                let len = self.i32()? as usize;
                let mut v = Vec::with_capacity(len);
                for _ in 0..len {
                    v.push(self.i32()?);
                }
                Tag::IntArray(v)
            }
            12 => {
                let len = self.i32()? as usize;
                let mut v = Vec::with_capacity(len);
                for _ in 0..len {
                    v.push(self.i64()?);
                }
                Tag::LongArray(v)
            }
            t => return Err(format!("unknown tag type {t}")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let root = Tag::compound(vec![
            ("name", Tag::String("arachne".into())),
            ("n", Tag::Int(4903)),
            (
                "list",
                Tag::list_of(3, vec![Tag::Int(1), Tag::Int(2), Tag::Int(3)]),
            ),
            ("bytes", Tag::ByteArray(vec![1, 2, 255])),
            (
                "nested",
                Tag::compound(vec![("b", Tag::Byte(-1)), ("s", Tag::Short(128))]),
            ),
        ]);
        let bytes = write_root("", &root);
        let (name, parsed) = read_root(&bytes).unwrap();
        assert_eq!(name, "");
        assert_eq!(parsed, root);
    }
}
