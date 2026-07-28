use serde::{Deserialize, Serialize};

pub const ABI_VERSION: u16 = 2;
pub const IPC_PROTOCOL_VERSION: u16 = 2;
pub const MAX_CAPTURE_OPS: usize = 8;
pub const MAX_CAPTURE_SLOTS: usize = 8;
pub const MAX_SLOT_BYTES: usize = 64;
pub const MAX_IPC_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_BATCH: u16 = 16;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum OpCode {
    #[default]
    ReadRegister = 1,
    ReadFrameBase = 2,
    AddConstant = 3,
    DereferenceFixed = 4,
    StackValue = 5,
    ReadPiece = 6,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaptureOp {
    pub code: u8,
    pub register: u8,
    pub width: u8,
    pub destination_slot: u8,
    pub offset: i32,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapturePlan {
    pub abi_version: u16,
    pub operation_count: u8,
    pub slot_count: u8,
    pub generation: u32,
    pub pid: u32,
    pub program_kind: u32,
    pub cgroup_id: u64,
    pub hit_limit: u64,
    pub refill_per_second: u32,
    pub burst: u32,
    pub sample_every: u32,
    pub reserved: u32,
    pub operations: [CaptureOp; MAX_CAPTURE_OPS],
}

impl Default for CapturePlan {
    fn default() -> Self {
        Self {
            abi_version: ABI_VERSION,
            operation_count: 0,
            slot_count: 0,
            generation: 0,
            pid: 0,
            program_kind: 0,
            cgroup_id: 0,
            hit_limit: 1,
            refill_per_second: 1,
            burst: 1,
            sample_every: 1,
            reserved: 0,
            operations: [CaptureOp::default(); MAX_CAPTURE_OPS],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawEvent {
    pub abi_version: u16,
    pub slot_count: u8,
    pub flags: u8,
    pub generation: u32,
    pub pid: u32,
    pub tid: u32,
    pub timestamp_ns: u64,
    pub cookie: u64,
    pub widths: [u8; MAX_CAPTURE_SLOTS],
    pub values: [[u8; MAX_SLOT_BYTES]; MAX_CAPTURE_SLOTS],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub process_start_time: String,
    pub executable_path: String,
    pub executable_device: Option<String>,
    pub executable_inode: Option<String>,
    pub build_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovedProgram {
    CountOnly,
    ScalarSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachRequest {
    pub abi_version: u16,
    pub request_id: String,
    pub service_id: String,
    pub site_id: String,
    pub cookie: u64,
    pub offset: u64,
    pub target: ProcessIdentity,
    pub program: ApprovedProgram,
    pub plan: Vec<NormalizedOp>,
    pub generation: u32,
    pub hit_limit: u64,
    pub refill_per_second: u32,
    pub burst: u32,
    pub sample_every: u32,
    pub cgroup_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedOp {
    pub code: OpCode,
    pub register: u8,
    pub width: u8,
    pub destination_slot: u8,
    pub offset: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum LoaderRequest {
    GetInfo {
        request_id: String,
    },
    Attach {
        request: AttachRequest,
    },
    Detach {
        request_id: String,
        site_id: String,
    },
    ReadCounters {
        request_id: String,
        cookie: u64,
    },
    PollEvents {
        request_id: String,
        timeout_millis: u32,
        max_events: u16,
    },
    Shutdown {
        request_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case", deny_unknown_fields)]
pub enum LoaderResponse {
    Info {
        request_id: String,
        protocol_version: u16,
        binary_abi_version: u16,
    },
    Attached {
        request_id: String,
        site_id: String,
    },
    Detached {
        request_id: String,
        site_id: String,
    },
    Counters {
        request_id: String,
        raw_hits: u64,
        captures: u64,
        dropped: u64,
    },
    Events {
        request_id: String,
        records: Vec<Vec<u8>>,
    },
    Error {
        request_id: String,
        reason_code: String,
        detail: String,
    },
}

const _: () = {
    assert!(core::mem::size_of::<CaptureOp>() == 12);
    assert!(core::mem::size_of::<CapturePlan>() == 144);
    assert!(core::mem::size_of::<RawEvent>() == 552);
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_layout_is_stable() {
        assert_eq!(size_of::<CaptureOp>(), 12);
        assert_eq!(size_of::<CapturePlan>(), 144);
        assert_eq!(size_of::<RawEvent>(), 552);
    }

    #[test]
    fn ipc_rejects_unknown_fields() {
        let json = r#"{"operation":"detach","requestId":"1","siteId":"a","shell":"id"}"#;
        assert!(serde_json::from_str::<LoaderRequest>(json).is_err());
        let path = r#"{"operation":"get-info","requestId":"1","bpfObjectPath":"/tmp/evil.o"}"#;
        assert!(serde_json::from_str::<LoaderRequest>(path).is_err());
        let bytes = r#"{"operation":"get-info","requestId":"1","bpfBytes":"f0VMRg=="}"#;
        assert!(serde_json::from_str::<LoaderRequest>(bytes).is_err());
    }
}
