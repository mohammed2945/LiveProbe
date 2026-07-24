use liveprobe_bpf_loader::{
    bpf::BpfManager,
    ipc::{read_request, write_response},
    policy::LoaderPolicy,
};
use liveprobe_native_protocol::{ABI_VERSION, IPC_PROTOCOL_VERSION, LoaderRequest, LoaderResponse};
use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
use std::{
    env,
    ffi::CString,
    fs,
    io::ErrorKind,
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

fn main() -> anyhow::Result<()> {
    if !cfg!(target_os = "linux") {
        anyhow::bail!("liveprobe-bpf-loader only runs on Linux");
    }
    if env::args().nth(1).as_deref() == Some("--verify-embedded") {
        BpfManager::verify_approved_integrity()?;
        println!(
            "approved embedded BPF sha256={}",
            BpfManager::approved_object_digest()
        );
        return Ok(());
    }
    let socket_path = env::args().nth(1).ok_or_else(|| {
        anyhow::anyhow!("usage: liveprobe-bpf-loader SOCKET WORKER_UID WORKER_GID TARGET...")
    })?;
    let worker_uid: u32 = env::args()
        .nth(2)
        .ok_or_else(|| anyhow::anyhow!("missing worker uid"))?
        .parse()?;
    let worker_gid: u32 = env::args()
        .nth(3)
        .ok_or_else(|| anyhow::anyhow!("missing worker gid"))?
        .parse()?;
    let targets = env::args().skip(4).map(PathBuf::from).collect();
    let policy = LoaderPolicy::new(targets, worker_uid)?;
    let mut manager = BpfManager::load_approved()?;
    if Path::new(&socket_path).exists() {
        let metadata = fs::symlink_metadata(&socket_path)?;
        anyhow::ensure!(
            metadata.file_type().is_socket() && metadata.uid() == 0,
            "refusing to replace non-loader socket path"
        );
        anyhow::ensure!(
            UnixStream::connect(&socket_path).is_err(),
            "refusing to replace active loader socket"
        );
        fs::remove_file(&socket_path)?;
    }
    let listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
    let _socket_guard = SocketGuard(PathBuf::from(&socket_path));
    let socket_c = CString::new(Path::new(&socket_path).as_os_str().as_bytes())?;
    let chown_result = unsafe { libc::chown(socket_c.as_ptr(), 0, worker_gid) };
    if chown_result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o660))?;
    listener.set_nonblocking(true)?;
    let mut worker_pid = None;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Err(error) = handle(&mut stream, &policy, &mut manager, &mut worker_pid) {
                    eprintln!("liveprobe loader request rejected: {error:#}");
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if worker_pid.is_some_and(|pid| !Path::new(&format!("/proc/{pid}")).exists()) {
                    manager.detach_all();
                    worker_pid = None;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn handle(
    stream: &mut UnixStream,
    policy: &LoaderPolicy,
    manager: &mut BpfManager,
    worker_pid: &mut Option<i32>,
) -> anyhow::Result<()> {
    let credentials = getsockopt(stream, PeerCredentials)?;
    policy.validate_peer(credentials.uid())?;
    let peer_pid = credentials.pid();
    anyhow::ensure!(
        worker_pid.is_none_or(|expected| expected == peer_pid),
        "local-policy-denied: loader is already paired with another worker process"
    );
    *worker_pid = Some(peer_pid);
    let request = read_request(stream)?;
    let response = match request {
        LoaderRequest::GetInfo { request_id } => LoaderResponse::Info {
            request_id,
            protocol_version: IPC_PROTOCOL_VERSION,
            binary_abi_version: ABI_VERSION,
        },
        LoaderRequest::Attach { request } => {
            let id = request.request_id.clone();
            let site = request.site_id.clone();
            match policy
                .validate_attach(&request)
                .and_then(|_| manager.attach(&request))
            {
                Ok(()) => LoaderResponse::Attached {
                    request_id: id,
                    site_id: site,
                },
                Err(error) => LoaderResponse::Error {
                    request_id: id,
                    reason_code: "local-policy-denied".into(),
                    detail: error.to_string(),
                },
            }
        }
        LoaderRequest::Detach {
            request_id,
            site_id,
        } => {
            manager.detach(&site_id);
            LoaderResponse::Detached {
                request_id,
                site_id,
            }
        }
        LoaderRequest::ReadCounters { request_id, cookie } => match manager.counters(cookie) {
            Ok((raw_hits, captures, dropped)) => LoaderResponse::Counters {
                request_id,
                raw_hits,
                captures,
                dropped,
            },
            Err(error) => LoaderResponse::Error {
                request_id,
                reason_code: "local-policy-denied".into(),
                detail: error.to_string(),
            },
        },
        LoaderRequest::PollEvents {
            request_id,
            timeout_millis,
            max_events,
        } => match manager.poll_events(timeout_millis, max_events) {
            Ok(records) => LoaderResponse::Events {
                request_id,
                records,
            },
            Err(error) => LoaderResponse::Error {
                request_id,
                reason_code: "local-policy-denied".into(),
                detail: error.to_string(),
            },
        },
        LoaderRequest::Shutdown { request_id } => LoaderResponse::Error {
            request_id,
            reason_code: "local-policy-denied".into(),
            detail: "remote shutdown is not permitted".into(),
        },
    };
    write_response(stream, &response)
}
