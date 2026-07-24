use liveprobe_native_protocol::{
    ABI_VERSION, IPC_PROTOCOL_VERSION, LoaderRequest, LoaderResponse, MAX_IPC_BYTES,
};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    os::unix::net::UnixStream,
    path::Path,
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoaderIdentity {
    pub device: u64,
    pub inode: u64,
}

pub struct LoaderClient {
    socket_path: String,
}
impl LoaderClient {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            socket_path: path.as_ref().to_string_lossy().into_owned(),
        }
    }
    pub fn call(&self, request: &LoaderRequest) -> anyhow::Result<LoaderResponse> {
        let body = serde_json::to_vec(request)?;
        anyhow::ensure!(
            body.len() <= MAX_IPC_BYTES,
            "loader request exceeds IPC bound"
        );
        let mut stream = UnixStream::connect(&self.socket_path)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(&(body.len() as u32).to_be_bytes())?;
        stream.write_all(&body)?;
        stream.flush()?;
        let mut size = [0u8; 4];
        stream.read_exact(&mut size)?;
        let size = u32::from_be_bytes(size) as usize;
        anyhow::ensure!(
            size > 0 && size <= MAX_IPC_BYTES,
            "loader response exceeds IPC bound"
        );
        let mut response = vec![0; size];
        stream.read_exact(&mut response)?;
        Ok(serde_json::from_slice(&response)?)
    }

    pub fn verify_compatibility(&self) -> anyhow::Result<LoaderIdentity> {
        let metadata = fs::metadata(&self.socket_path)?;
        match self.call(&LoaderRequest::GetInfo {
            request_id: "abi-check".into(),
        })? {
            LoaderResponse::Info {
                protocol_version,
                binary_abi_version,
                ..
            } => {
                anyhow::ensure!(
                    protocol_version == IPC_PROTOCOL_VERSION,
                    "abi-incompatible: loader IPC protocol {protocol_version}, agent requires {IPC_PROTOCOL_VERSION}"
                );
                anyhow::ensure!(
                    binary_abi_version == ABI_VERSION,
                    "abi-incompatible: loader BPF ABI {binary_abi_version}, agent requires {ABI_VERSION}"
                );
                Ok(LoaderIdentity {
                    device: metadata.dev(),
                    inode: metadata.ino(),
                })
            }
            response => anyhow::bail!("abi-incompatible: unexpected loader response {response:?}"),
        }
    }
}
