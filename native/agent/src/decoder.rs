use crate::{dwarf::ValueKind, serializer::SanitizedNode};
use liveprobe_native_protocol::{ABI_VERSION, MAX_CAPTURE_SLOTS, RawEvent};

#[derive(Clone, Debug, PartialEq)]
pub enum DecodedValue {
    Signed(i64),
    Unsigned(u64),
    Boolean(bool),
    Pointer(u64),
    CString(String),
}

pub fn decode_unsigned(event: &RawEvent, slot: usize) -> anyhow::Result<u64> {
    anyhow::ensure!(
        event.abi_version == ABI_VERSION,
        "unsupported native event ABI"
    );
    anyhow::ensure!(
        slot < usize::from(event.slot_count) && slot < MAX_CAPTURE_SLOTS,
        "slot is unavailable"
    );
    let width = usize::from(event.widths[slot]);
    anyhow::ensure!(matches!(width, 1 | 2 | 4 | 8), "unsupported scalar width");
    let mut bytes = [0u8; 8];
    bytes[..width].copy_from_slice(&event.values[slot][..width]);
    Ok(u64::from_ne_bytes(bytes))
}

pub fn decode_bounded_c_string(bytes: &[u8], max: usize) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len())
        .min(max);
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

pub fn decode_node(
    event: &RawEvent,
    slot: usize,
    kind: ValueKind,
) -> anyhow::Result<SanitizedNode> {
    anyhow::ensure!(
        event.abi_version == ABI_VERSION,
        "unsupported native event ABI"
    );
    anyhow::ensure!(
        slot < usize::from(event.slot_count) && slot < MAX_CAPTURE_SLOTS,
        "slot is unavailable"
    );
    let width = usize::from(event.widths[slot]);
    anyhow::ensure!(
        width > 0 && width <= event.values[slot].len(),
        "unsupported scalar width"
    );
    if kind == ValueKind::CString {
        return Ok(SanitizedNode::Str {
            v: decode_bounded_c_string(&event.values[slot][..width], width),
        });
    }
    anyhow::ensure!(matches!(width, 1 | 2 | 4 | 8), "unsupported scalar width");
    let unsigned = decode_unsigned(event, slot)?;
    Ok(match kind {
        ValueKind::Signed => {
            let shift = 64usize.saturating_sub(width * 8);
            SanitizedNode::Num {
                v: (((unsigned << shift) as i64) >> shift) as f64,
            }
        }
        ValueKind::Unsigned => SanitizedNode::Num { v: unsigned as f64 },
        ValueKind::Boolean => SanitizedNode::Bool { v: unsigned != 0 },
        ValueKind::Pointer => SanitizedNode::Str {
            v: format!("0x{unsigned:x}"),
        },
        ValueKind::CString => unreachable!(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(width: u8, bytes: &[u8]) -> RawEvent {
        let mut event: RawEvent = unsafe { std::mem::zeroed() };
        event.abi_version = ABI_VERSION;
        event.slot_count = 1;
        event.widths[0] = width;
        event.values[0][..bytes.len()].copy_from_slice(bytes);
        event
    }

    #[test]
    fn decodes_signed_boolean_pointer_and_bounded_string() {
        assert_eq!(
            decode_node(&event(1, &[0xff]), 0, ValueKind::Signed).unwrap(),
            SanitizedNode::Num { v: -1.0 }
        );
        assert_eq!(
            decode_node(&event(1, &[1]), 0, ValueKind::Boolean).unwrap(),
            SanitizedNode::Bool { v: true }
        );
        assert_eq!(
            decode_node(&event(8, &42u64.to_ne_bytes()), 0, ValueKind::Pointer).unwrap(),
            SanitizedNode::Str { v: "0x2a".into() }
        );
        assert_eq!(
            decode_node(&event(6, b"hello\0"), 0, ValueKind::CString).unwrap(),
            SanitizedNode::Str { v: "hello".into() }
        );
    }
}
