use crate::dwarf::{LocationError, LocationOperation, validate_location};
use liveprobe_native_protocol::{MAX_CAPTURE_OPS, MAX_CAPTURE_SLOTS, NormalizedOp, OpCode};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturePathPlan {
    pub path: String,
    pub operations: Vec<NormalizedOp>,
}

pub fn normalize(
    path: &str,
    operations: &[LocationOperation],
    slot: u8,
) -> Result<CapturePathPlan, LocationError> {
    validate_location(operations)?;
    if usize::from(slot) >= MAX_CAPTURE_SLOTS {
        return Err(LocationError::Unsupported(
            "capture slot limit exceeded".into(),
        ));
    }
    let mut normalized = Vec::with_capacity(operations.len());
    for operation in operations.iter().take(MAX_CAPTURE_OPS) {
        let (code, register, width, offset) = match operation {
            LocationOperation::Register(value) => (
                OpCode::ReadRegister,
                u8::try_from(*value)
                    .map_err(|_| LocationError::Unsupported("register number".into()))?,
                8,
                0,
            ),
            LocationOperation::FrameOffset(_) => {
                return Err(LocationError::Unsupported(
                    "unresolved DW_OP_fbreg frame base".into(),
                ));
            }
            LocationOperation::AddConstant(value) => (
                OpCode::AddConstant,
                0,
                8,
                i32::try_from(*value)
                    .map_err(|_| LocationError::Unsupported("constant offset".into()))?,
            ),
            LocationOperation::Dereference { bytes } => (OpCode::DereferenceFixed, 0, *bytes, 0),
            LocationOperation::StackValue => (OpCode::StackValue, 0, 8, 0),
            LocationOperation::Piece { .. } => {
                return Err(LocationError::Unsupported(
                    "unsupported-register-piece: DW_OP_piece source semantics are unproven".into(),
                ));
            }
            LocationOperation::Unsupported(opcode) => {
                return Err(LocationError::Unsupported(format!("DWARF opcode {opcode}")));
            }
        };
        normalized.push(NormalizedOp {
            code,
            register,
            width,
            destination_slot: slot,
            offset,
        });
    }
    Ok(CapturePathPlan {
        path: path.to_owned(),
        operations: normalized,
    })
}

pub fn validate_plan_bounds(plans: &[CapturePathPlan]) -> Result<(), LocationError> {
    if plans.len() > MAX_CAPTURE_SLOTS {
        return Err(LocationError::Unsupported(
            "capture slot limit exceeded".into(),
        ));
    }
    let operations: usize = plans.iter().map(|plan| plan.operations.len()).sum();
    if operations > MAX_CAPTURE_OPS {
        return Err(LocationError::Unsupported(
            "operation limit exceeded".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_plan_over_bounds() {
        let plans = (0..9)
            .map(|i| CapturePathPlan {
                path: format!("x{i}"),
                operations: vec![],
            })
            .collect::<Vec<_>>();
        assert!(validate_plan_bounds(&plans).is_err());
    }

    #[test]
    fn rejects_piece_sources_as_structured_unavailable() {
        let error = normalize("piece", &[LocationOperation::Piece { bytes: 4 }], 0)
            .unwrap_err()
            .to_string();
        assert!(error.contains("unsupported-register-piece"));
    }
}
