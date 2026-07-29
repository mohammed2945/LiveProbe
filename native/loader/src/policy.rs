use liveprobe_native_protocol::{
    ABI_VERSION, AttachRequest, MAX_CAPTURE_OPS, MAX_CAPTURE_SLOTS, OpCode,
};
use object::{Object, ObjectSegment};
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf};

#[derive(Clone, Debug)]
pub struct LoaderPolicy {
    allowed_targets: Vec<PathBuf>,
    worker_uid: u32,
}
impl LoaderPolicy {
    pub fn new(allowed_targets: Vec<PathBuf>, worker_uid: u32) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !allowed_targets.is_empty(),
            "loader target allowlist must not be empty"
        );
        // Allowlist entries may name a path inside a container's mount namespace,
        // which does not resolve here. Canonicalise what exists locally so host
        // targets still tolerate symlinked paths, and keep the rest literal.
        let allowed_targets = allowed_targets
            .into_iter()
            .map(|target| fs::canonicalize(&target).unwrap_or(target))
            .collect::<Vec<_>>();
        Ok(Self {
            allowed_targets,
            worker_uid,
        })
    }
    pub fn validate_peer(&self, uid: u32) -> anyhow::Result<()> {
        anyhow::ensure!(
            uid == self.worker_uid,
            "local-policy-denied: unexpected IPC peer uid"
        );
        Ok(())
    }
    pub fn validate_attach(&self, request: &AttachRequest) -> anyhow::Result<()> {
        anyhow::ensure!(
            request.abi_version == ABI_VERSION,
            "abi-incompatible: loader binary ABI {ABI_VERSION}, agent requested {}",
            request.abi_version
        );
        anyhow::ensure!(
            request.plan.len() <= MAX_CAPTURE_OPS,
            "local-policy-denied: capture operation limit"
        );
        anyhow::ensure!(
            request
                .plan
                .iter()
                .all(|op| usize::from(op.destination_slot) < MAX_CAPTURE_SLOTS
                    && matches!(op.width, 1 | 2 | 4 | 8 | 64)),
            "local-policy-denied: invalid capture slot or width"
        );
        anyhow::ensure!(
            request.plan.iter().all(|op| op.code != OpCode::ReadPiece),
            "unsupported-register-piece: DW_OP_piece capture is not approved"
        );
        anyhow::ensure!(
            request.sample_every > 0,
            "local-policy-denied: invalid sampling plan"
        );
        // Ask the kernel what this process is actually running rather than
        // trusting the path the agent sent. `/proc/<pid>/exe` opens the executed
        // inode from any mount namespace, so a containerised target is readable
        // here even though its own path does not exist in the loader's root.
        let target = proc_exe_path(request.target.pid);
        let in_namespace = fs::read_link(&target)?;
        anyhow::ensure!(
            in_namespace == PathBuf::from(&request.target.executable_path),
            "target-instance-changed: proc executable changed"
        );
        anyhow::ensure!(
            self.allowed_targets
                .iter()
                .any(|allowed| allowed == &in_namespace),
            "local-policy-denied: executable is not allowlisted"
        );
        let stat = fs::read_to_string(format!("/proc/{}/stat", request.target.pid))?;
        let start = liveprobe_proc_start_time(&stat)?;
        anyhow::ensure!(
            start == request.target.process_start_time,
            "target-instance-changed: process start time changed"
        );
        let metadata = fs::metadata(&target)?;
        if let Some(inode) = &request.target.executable_inode {
            anyhow::ensure!(
                metadata.ino().to_string() == *inode,
                "target-instance-changed: inode changed"
            );
        }
        let bytes = fs::read(&target)?;
        let object = object::File::parse(bytes.as_slice())?;
        let id = object
            .build_id()?
            .map(hex_bytes)
            .ok_or_else(|| anyhow::anyhow!("no-build-id"))?;
        anyhow::ensure!(id == request.target.build_id, "build-mismatch");
        let offset_ok = object.segments().any(|segment| {
            let (offset, size) = segment.file_range();
            request.offset >= offset && request.offset < offset.saturating_add(size)
        });
        anyhow::ensure!(
            offset_ok,
            "local-policy-denied: offset is outside file-backed load segments"
        );
        Ok(())
    }
}

/// The kernel's magic symlink for a process's executable. Resolves to the
/// executed inode regardless of which mount namespace the reader is in, and is
/// race-free against the on-disk file being replaced after discovery.
pub fn proc_exe_path(pid: u32) -> PathBuf {
    PathBuf::from(format!("/proc/{pid}/exe"))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 15) as usize] as char);
    }
    out
}
fn liveprobe_proc_start_time(stat: &str) -> anyhow::Result<String> {
    let close = stat
        .rfind(')')
        .ok_or_else(|| anyhow::anyhow!("malformed proc stat"))?;
    Ok(stat[close + 1..]
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| anyhow::anyhow!("missing start time"))?
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_validation_is_exact() {
        let policy = LoaderPolicy {
            allowed_targets: vec![PathBuf::from("/bin/true")],
            worker_uid: 1000,
        };
        assert!(policy.validate_peer(1000).is_ok());
        assert!(policy.validate_peer(0).is_err());
    }
}
