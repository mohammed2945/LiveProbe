use liveprobe_native_protocol::{LoaderRequest, LoaderResponse, MAX_IPC_BYTES};
use std::io::{Read, Write};

pub fn read_request(reader: &mut impl Read) -> anyhow::Result<LoaderRequest> {
    let mut size = [0u8; 4];
    reader.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    anyhow::ensure!(
        size > 0 && size <= MAX_IPC_BYTES,
        "IPC message exceeds bounded size"
    );
    let mut body = vec![0; size];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

pub fn write_response(writer: &mut impl Write, response: &LoaderResponse) -> anyhow::Result<()> {
    let body = serde_json::to_vec(response)?;
    anyhow::ensure!(
        body.len() <= MAX_IPC_BYTES,
        "IPC response exceeds bounded size"
    );
    writer.write_all(&(body.len() as u32).to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_oversized_message() {
        let size = ((MAX_IPC_BYTES as u32) + 1).to_be_bytes();
        let mut data = size.as_slice();
        assert!(read_request(&mut data).is_err());
    }
}
