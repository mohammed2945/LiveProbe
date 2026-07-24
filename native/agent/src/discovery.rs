use crate::{
    config::{NativeLanguage, ServiceConfig},
    symbols,
};
use serde::Serialize;
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredInstance {
    pub instance_id: String,
    pub service_id: String,
    pub language: NativeLanguage,
    pub pid: u32,
    pub process_start_time: String,
    pub executable_path: String,
    pub executable_device: String,
    pub executable_inode: String,
    pub build_id: String,
    pub architecture: String,
    pub cgroup: Option<String>,
    pub last_seen: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryIssue {
    pub pid: u32,
    pub instance_id: Option<String>,
    pub service_id: Option<String>,
    pub reason_code: &'static str,
    pub detail: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiscoveryReport {
    pub instances: Vec<DiscoveredInstance>,
    pub issues: Vec<DiscoveryIssue>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MatchError {
    #[error("service-not-found: {0}")]
    NotFound(String),
    #[error("ambiguous-service-match: pid {pid} matches {services:?}")]
    Ambiguous { pid: u32, services: Vec<String> },
}

pub fn discover(
    proc_root: &Path,
    services: &[ServiceConfig],
    now: &str,
) -> anyhow::Result<Vec<DiscoveredInstance>> {
    Ok(discover_with_known(proc_root, services, now, &[])?.instances)
}

pub fn discover_with_known(
    proc_root: &Path,
    services: &[ServiceConfig],
    now: &str,
    known: &[DiscoveredInstance],
) -> anyhow::Result<DiscoveryReport> {
    let mut found = Vec::new();
    let mut issues = Vec::new();
    for entry in fs::read_dir(proc_root)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if process_disappeared(&error) => continue,
            Err(error) => return Err(error.into()),
        };
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let process_dir = entry.path();
        let exe = match fs::read_link(process_dir.join("exe")) {
            Ok(exe) => exe,
            Err(error) if process_disappeared(&error) => continue,
            Err(error) if permission_denied(&error) => {
                record_permission_issue(&mut issues, known, pid, "executable link");
                continue;
            }
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    None,
                    "process-inspection-failed",
                    format!("unable to read executable link: {error}"),
                ));
                continue;
            }
        };
        let cgroup = match fs::read_to_string(process_dir.join("cgroup")) {
            Ok(cgroup) => Some(cgroup),
            Err(error) if process_disappeared(&error) => continue,
            Err(error) if permission_denied(&error) => {
                record_permission_issue(&mut issues, known, pid, "cgroup metadata");
                continue;
            }
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    None,
                    "process-inspection-failed",
                    format!("unable to read cgroup metadata: {error}"),
                ));
                continue;
            }
        };
        let matching: Vec<_> = services
            .iter()
            .filter(|service| matches_selector(service, &exe, cgroup.as_deref()))
            .collect();
        if matching.len() > 1 {
            let services = matching
                .iter()
                .map(|service| service.service_id.clone())
                .collect::<Vec<_>>();
            issues.push(candidate_issue(
                known,
                pid,
                None,
                "ambiguous-service-match",
                MatchError::Ambiguous { pid, services }.to_string(),
            ));
            continue;
        }
        let Some(service) = matching.first() else {
            continue;
        };
        let stat = match fs::read_to_string(process_dir.join("stat")) {
            Ok(stat) => stat,
            Err(error) if process_disappeared(&error) => continue,
            Err(error) if permission_denied(&error) => {
                record_configured_permission_issue(
                    &mut issues,
                    known,
                    pid,
                    service,
                    "process stat",
                );
                continue;
            }
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    Some(service),
                    "process-inspection-failed",
                    format!("unable to read process stat: {error}"),
                ));
                continue;
            }
        };
        let start_time = match proc_start_time(&stat) {
            Ok(start_time) => start_time.to_string(),
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    Some(service),
                    "process-metadata-invalid",
                    error.to_string(),
                ));
                continue;
            }
        };
        let metadata = match fs::metadata(&exe) {
            Ok(metadata) => metadata,
            Err(error) if process_disappeared(&error) => continue,
            Err(error) if permission_denied(&error) => {
                record_configured_permission_issue(
                    &mut issues,
                    known,
                    pid,
                    service,
                    "executable metadata",
                );
                continue;
            }
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    Some(service),
                    "process-metadata-invalid",
                    format!("invalid executable metadata: {error}"),
                ));
                continue;
            }
        };
        let build_id = match symbols::build_id(&exe) {
            Ok(build_id) => build_id,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(process_disappeared) =>
            {
                continue;
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(permission_denied) =>
            {
                record_configured_permission_issue(
                    &mut issues,
                    known,
                    pid,
                    service,
                    "executable build identity",
                );
                continue;
            }
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    Some(service),
                    "invalid-build-identity",
                    error.to_string(),
                ));
                continue;
            }
        }
        .unwrap_or_default();
        if build_id.is_empty() {
            issues.push(candidate_issue(
                known,
                pid,
                Some(service),
                "no-build-id",
                "executable has no usable build ID".into(),
            ));
            continue;
        }
        let architecture = match symbols::architecture(&exe) {
            Ok(architecture) => architecture,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(process_disappeared) =>
            {
                continue;
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(permission_denied) =>
            {
                record_configured_permission_issue(
                    &mut issues,
                    known,
                    pid,
                    service,
                    "executable architecture",
                );
                continue;
            }
            Err(error) => {
                issues.push(candidate_issue(
                    known,
                    pid,
                    Some(service),
                    "unsupported-architecture",
                    error.to_string(),
                ));
                continue;
            }
        };
        found.push(DiscoveredInstance {
            instance_id: format!("{}-{pid}-{start_time}", service.service_id),
            service_id: service.service_id.clone(),
            language: service.language,
            pid,
            process_start_time: start_time,
            executable_path: exe.to_string_lossy().into_owned(),
            executable_device: format!(
                "{}:{}",
                libc::major(metadata.dev()),
                libc::minor(metadata.dev())
            ),
            executable_inode: metadata.ino().to_string(),
            build_id,
            architecture,
            cgroup,
            last_seen: now.to_owned(),
        });
    }
    Ok(DiscoveryReport {
        instances: found,
        issues,
    })
}

fn process_disappeared(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

fn permission_denied(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(libc::EACCES) | Some(libc::EPERM))
}

fn record_permission_issue(
    issues: &mut Vec<DiscoveryIssue>,
    known: &[DiscoveredInstance],
    pid: u32,
    operation: &str,
) {
    if let Some(instance) = known.iter().find(|instance| instance.pid == pid) {
        issues.push(permission_issue(pid, instance, operation));
    }
}

fn record_configured_permission_issue(
    issues: &mut Vec<DiscoveryIssue>,
    known: &[DiscoveredInstance],
    pid: u32,
    service: &ServiceConfig,
    operation: &str,
) {
    if let Some(instance) = known.iter().find(|instance| instance.pid == pid) {
        issues.push(permission_issue(pid, instance, operation));
    } else {
        issues.push(DiscoveryIssue {
            pid,
            instance_id: None,
            service_id: Some(service.service_id.clone()),
            reason_code: "process-inspection-permission-denied",
            detail: format!("permission denied while reading {operation}"),
        });
    }
}

fn permission_issue(pid: u32, instance: &DiscoveredInstance, operation: &str) -> DiscoveryIssue {
    DiscoveryIssue {
        pid,
        instance_id: Some(instance.instance_id.clone()),
        service_id: Some(instance.service_id.clone()),
        reason_code: "process-inspection-permission-denied",
        detail: format!("permission denied while reading {operation}"),
    }
}

fn candidate_issue(
    known: &[DiscoveredInstance],
    pid: u32,
    service: Option<&ServiceConfig>,
    reason_code: &'static str,
    detail: String,
) -> DiscoveryIssue {
    let previous = known.iter().find(|instance| instance.pid == pid);
    DiscoveryIssue {
        pid,
        instance_id: previous.map(|instance| instance.instance_id.clone()),
        service_id: previous
            .map(|instance| instance.service_id.clone())
            .or_else(|| service.map(|service| service.service_id.clone())),
        reason_code,
        detail,
    }
}

fn matches_selector(service: &ServiceConfig, exe: &Path, cgroup: Option<&str>) -> bool {
    let has_path = service.executable_path.is_some();
    let has_cgroup = service.cgroup_prefix.is_some();
    let path_match = service
        .executable_path
        .as_ref()
        .is_some_and(|configured| PathBuf::from(configured) == exe);
    let cgroup_match = service.cgroup_prefix.as_ref().is_some_and(|prefix| {
        cgroup.is_some_and(|value| {
            value.lines().any(|line| {
                line.split_once("::")
                    .map(|(_, path)| path.starts_with(prefix))
                    .unwrap_or(false)
            })
        })
    });
    (has_path || has_cgroup) && (!has_path || path_match) && (!has_cgroup || cgroup_match)
}

pub fn proc_start_time(stat: &str) -> anyhow::Result<u64> {
    let close = stat
        .rfind(')')
        .ok_or_else(|| anyhow::anyhow!("malformed proc stat"))?;
    let fields: Vec<_> = stat[close + 1..].split_whitespace().collect();
    fields
        .get(19)
        .ok_or_else(|| anyhow::anyhow!("proc stat lacks starttime"))?
        .parse()
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(pid: u32) -> DiscoveredInstance {
        DiscoveredInstance {
            instance_id: format!("test-{pid}-42"),
            service_id: "test".into(),
            language: NativeLanguage::Rust,
            pid,
            process_start_time: "42".into(),
            executable_path: "/opt/test".into(),
            executable_device: "1:2".into(),
            executable_inode: "3".into(),
            build_id: "0123456789abcdef".into(),
            architecture: "x86_64".into(),
            cgroup: None,
            last_seen: "now".into(),
        }
    }
    #[test]
    fn parses_start_time_with_spaces_in_comm() {
        assert_eq!(
            proc_start_time("1 (a hard name) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4242").unwrap(),
            4242
        );
    }

    #[test]
    fn combined_selector_requires_path_and_cgroup() {
        let service = ServiceConfig {
            service_id: "orders".into(),
            language: NativeLanguage::Rust,
            executable_path: Some("/opt/orders".into()),
            cgroup_prefix: Some("/services/orders".into()),
        };
        assert!(matches_selector(
            &service,
            Path::new("/opt/orders"),
            Some("0::/services/orders/worker\n")
        ));
        assert!(!matches_selector(
            &service,
            Path::new("/opt/other"),
            Some("0::/services/orders/worker\n")
        ));
        assert!(!matches_selector(
            &service,
            Path::new("/opt/orders"),
            Some("0::/services/other\n")
        ));
    }

    #[test]
    fn vanished_candidates_are_normal_discovery_churn() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let service = ServiceConfig {
            service_id: "test".into(),
            language: NativeLanguage::Rust,
            executable_path: Some(executable.to_string_lossy().into_owned()),
            cgroup_prefix: None,
        };
        for pid in 1000..1100 {
            let directory = root.path().join(pid.to_string());
            fs::create_dir(&directory).unwrap();
            symlink(&executable, directory.join("exe")).unwrap();
            fs::write(directory.join("cgroup"), "0::/test\n").unwrap();
            // Deliberately omit stat, modelling exit after exe/cgroup reads.
        }
        assert!(
            discover(root.path(), std::slice::from_ref(&service), "now")
                .unwrap()
                .is_empty()
        );
        // A second pass proves the discovery loop remains usable.
        assert!(
            discover(root.path(), &[service], "later")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn permission_failures_skip_unrelated_and_report_known_targets() {
        let mut issues = Vec::new();
        record_permission_issue(&mut issues, &[], 10, "executable link");
        assert!(issues.is_empty());

        let target = known(11);
        record_permission_issue(
            &mut issues,
            std::slice::from_ref(&target),
            11,
            "process stat",
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].instance_id.as_deref(), Some("test-11-42"));
        assert_eq!(
            issues[0].reason_code,
            "process-inspection-permission-denied"
        );
        assert!(permission_denied(&std::io::Error::from_raw_os_error(
            libc::EACCES
        )));
        assert!(permission_denied(&std::io::Error::from_raw_os_error(
            libc::EPERM
        )));
    }

    #[test]
    fn malformed_metadata_remains_visible() {
        assert!(proc_start_time("malformed").is_err());
        assert!(proc_start_time("1 (short) S 0").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn inaccessible_candidate_does_not_hide_later_valid_candidate() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let inaccessible = root.path().join("100");
        fs::create_dir(&inaccessible).unwrap();
        fs::set_permissions(&inaccessible, fs::Permissions::from_mode(0)).unwrap();

        let malformed = root.path().join("150");
        fs::create_dir(&malformed).unwrap();
        symlink(&executable, malformed.join("exe")).unwrap();
        fs::write(malformed.join("cgroup"), "0::/test\n").unwrap();
        fs::write(malformed.join("stat"), "malformed proc stat").unwrap();

        let valid = root.path().join("200");
        fs::create_dir(&valid).unwrap();
        symlink(&executable, valid.join("exe")).unwrap();
        fs::write(valid.join("cgroup"), "0::/test\n").unwrap();
        fs::write(
            valid.join("stat"),
            "200 (valid) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4242",
        )
        .unwrap();
        let service = ServiceConfig {
            service_id: "test".into(),
            language: NativeLanguage::Rust,
            executable_path: Some(executable.to_string_lossy().into_owned()),
            cgroup_prefix: None,
        };
        let report = discover_with_known(
            root.path(),
            std::slice::from_ref(&service),
            "now",
            &[known(100)],
        )
        .unwrap();
        fs::set_permissions(&inaccessible, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(report.instances.len(), 1);
        assert_eq!(report.instances[0].pid, 200);
        assert!(
            report.issues.iter().any(|issue| {
                issue.pid == 150 && issue.reason_code == "process-metadata-invalid"
            })
        );
        // Root can inspect mode-000 directories; unprivileged runs exercise
        // the structured issue while both modes prove the later PID is found.
        if unsafe { libc::geteuid() } != 0 {
            assert!(report.issues.iter().any(|issue| {
                issue.pid == 100 && issue.instance_id.as_deref() == Some("test-100-42")
            }));
        }
    }
}
