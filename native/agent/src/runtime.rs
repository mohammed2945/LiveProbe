use crate::{
    broker::ProbeAssignment,
    decoder,
    discovery::DiscoveredInstance,
    dwarf,
    events::{NativeEvent, render_log},
    planner,
    serializer::{
        SanitizedNode, SerializerConfig, UnavailableValue, condition_matches, sanitize_roots,
        sanitize_values,
    },
    symbols,
};
use liveprobe_native_protocol::{
    ABI_VERSION, ApprovedProgram, AttachRequest, MAX_CAPTURE_SLOTS, NormalizedOp, ProcessIdentity,
    RawEvent,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Debug)]
pub struct PlannedSite {
    pub probe: ProbeAssignment,
    pub site_id: String,
    pub cookie: u64,
    pub generation: u32,
    pub offset: u64,
    pub operations: Vec<NormalizedOp>,
    pub slot_paths: BTreeMap<u8, String>,
    pub slot_kinds: BTreeMap<u8, dwarf::ValueKind>,
    pub unavailable: BTreeMap<String, SanitizedNode>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EventFaultBudget {
    failures: u32,
    last_report_millis: Option<u64>,
}

#[derive(Debug)]
pub enum IsolatedDecode {
    Filtered,
    Event(NativeEvent),
    Failed {
        reason_code: &'static str,
        detail: String,
        report: bool,
        detach: bool,
    },
}

pub fn decode_event_isolated(
    site: &PlannedSite,
    bytes: &[u8],
    config: &SerializerConfig,
    faults: &mut EventFaultBudget,
    now_millis: u64,
) -> IsolatedDecode {
    match decode_event(site, bytes, config) {
        Ok(Some(event)) => IsolatedDecode::Event(event),
        Ok(None) => IsolatedDecode::Filtered,
        Err(error) => {
            faults.failures = faults.failures.saturating_add(1);
            let report = faults
                .last_report_millis
                .is_none_or(|last| now_millis.saturating_sub(last) >= 30_000);
            if report {
                faults.last_report_millis = Some(now_millis);
            }
            IsolatedDecode::Failed {
                reason_code: "capture-event-invalid",
                detail: error.to_string(),
                report,
                detach: faults.failures >= 5,
            }
        }
    }
}

pub fn plan_probe(
    instance: &DiscoveredInstance,
    probe: &ProbeAssignment,
    debug_artifact: &Path,
) -> anyhow::Result<Vec<PlannedSite>> {
    let sites = dwarf::resolve_line(debug_artifact, &probe.file, probe.line)?;
    let paths = capture_paths(probe)?;
    let mut planned = Vec::new();
    for (index, site) in sites.into_iter().enumerate() {
        let site_id = physical_site_id(instance, probe, index);
        let mut operations = Vec::new();
        let mut slot_paths = BTreeMap::new();
        let mut slot_kinds = BTreeMap::new();
        let mut unavailable = BTreeMap::new();
        for (slot, path) in paths.iter().enumerate() {
            match dwarf::resolve_variable(debug_artifact, site.address, path) {
                Ok(resolved) => match planner::normalize(path, &resolved.operations, slot as u8) {
                    Ok(plan) => {
                        operations.extend(plan.operations);
                        slot_paths.insert(slot as u8, path.clone());
                        slot_kinds.insert(slot as u8, resolved.kind);
                    }
                    Err(error) => {
                        unavailable.insert(
                            path.clone(),
                            SanitizedNode::Unavailable {
                                v: UnavailableValue {
                                    reason_code: reason_code(&error),
                                    detail: None,
                                    site_id: Some(site_id.clone()),
                                    build_id: Some(instance.build_id.clone()),
                                },
                            },
                        );
                    }
                },
                Err(error) => {
                    unavailable.insert(
                        path.clone(),
                        SanitizedNode::Unavailable {
                            v: UnavailableValue {
                                reason_code: reason_code(&error),
                                detail: None,
                                site_id: Some(site_id.clone()),
                                build_id: Some(instance.build_id.clone()),
                            },
                        },
                    );
                }
            }
        }
        planner::validate_plan_bounds(&[planner::CapturePathPlan {
            path: "combined".into(),
            operations: operations.clone(),
        }])?;
        planned.push(PlannedSite {
            cookie: cookie(&probe.id, &site_id, &instance.build_id),
            generation: probe.version as u32,
            offset: symbols::executable_file_offset(
                &Path::new(&instance.executable_path),
                site.address,
            )?,
            probe: probe.clone(),
            site_id,
            operations,
            slot_paths,
            slot_kinds,
            unavailable,
        });
    }
    anyhow::ensure!(
        !planned.is_empty(),
        "no-executable-address: no site has a supported capture plan"
    );
    Ok(planned)
}

impl PlannedSite {
    pub fn attach_request(
        &self,
        instance: &DiscoveredInstance,
        count_only: bool,
        sample_every: u32,
    ) -> AttachRequest {
        let capture_ceiling = if self.probe.kind == "counter" {
            self.probe.hit_limit
        } else {
            self.probe.hit_limit.saturating_mul(100).max(100)
        };
        AttachRequest {
            abi_version: ABI_VERSION,
            request_id: format!("attach:{}", self.site_id),
            service_id: instance.service_id.clone(),
            site_id: self.site_id.clone(),
            cookie: self.cookie,
            offset: self.offset,
            target: ProcessIdentity {
                pid: instance.pid,
                process_start_time: instance.process_start_time.clone(),
                executable_path: instance.executable_path.clone(),
                executable_device: Some(instance.executable_device.clone()),
                executable_inode: Some(instance.executable_inode.clone()),
                build_id: instance.build_id.clone(),
            },
            program: if count_only || self.probe.kind == "counter" {
                ApprovedProgram::CountOnly
            } else {
                ApprovedProgram::ScalarSnapshot
            },
            plan: if count_only {
                Vec::new()
            } else {
                self.operations.clone()
            },
            generation: physical_generation(self.probe.version, sample_every),
            hit_limit: capture_ceiling,
            refill_per_second: 10,
            burst: 10,
            sample_every,
            cgroup_id: 0,
        }
    }
}

fn physical_generation(probe_version: u64, sample_every: u32) -> u32 {
    let version = probe_version as u32;
    version.wrapping_mul(16_777_619).rotate_left(5) ^ sample_every
}

fn capture_paths(probe: &ProbeAssignment) -> anyhow::Result<Vec<String>> {
    let outbound = outbound_paths(probe)?;
    let mut paths = outbound.into_iter().collect::<BTreeSet<_>>();
    if let Some(condition) = &probe.condition {
        paths.insert(condition.path.clone());
    }
    Ok(paths.into_iter().collect())
}

fn outbound_paths(probe: &ProbeAssignment) -> anyhow::Result<BTreeSet<String>> {
    let paths = match probe.kind.as_str() {
        "counter" => {
            anyhow::ensure!(
                probe.condition.is_none(),
                "unsupported-location-expression: conditional native counters cannot aggregate in BPF"
            );
            BTreeSet::new()
        }
        "snapshot" => {
            let paths = probe.watch_paths.clone().unwrap_or_default();
            anyhow::ensure!(!paths.is_empty(), "native snapshots require watchPaths");
            paths.into_iter().collect()
        }
        "metric" => [probe
            .metric_path
            .clone()
            .ok_or_else(|| anyhow::anyhow!("metricPath is required"))?]
        .into_iter()
        .collect(),
        "log" => {
            let template = probe
                .template
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("template is required"))?;
            let regex = regex::Regex::new(r"\$\{([^.}]+(?:\.[^.}]+)*)\}").expect("constant regex");
            regex
                .captures_iter(template)
                .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_owned()))
                .collect()
        }
        other => anyhow::bail!("unsupported probe type {other}"),
    };
    Ok(paths)
}

fn physical_site_id(
    instance: &DiscoveredInstance,
    probe: &ProbeAssignment,
    index: usize,
) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        probe.id, probe.version, instance.instance_id, instance.build_id, index
    )
}

fn cookie(probe_id: &str, site_id: &str, build_id: &str) -> u64 {
    let digest = Sha256::digest(format!("{probe_id}\0{site_id}\0{build_id}"));
    u64::from_le_bytes(digest[..8].try_into().expect("8 bytes"))
}
fn reason_code(error: &dwarf::LocationError) -> String {
    match error {
        dwarf::LocationError::OptimizedOut => "variable-optimized-out",
        dwarf::LocationError::FloatingPointRegister => "floating-point-register-unavailable",
        dwarf::LocationError::Unsupported(detail) if detail.starts_with("variable-not-found") => {
            "variable-not-found"
        }
        dwarf::LocationError::Unsupported(detail) if detail.contains("unsupported-type") => {
            "unsupported-type"
        }
        dwarf::LocationError::Unsupported(detail)
            if detail.contains("unsupported-register-piece") =>
        {
            "unsupported-register-piece"
        }
        dwarf::LocationError::Unsupported(_) => "unsupported-location-expression",
    }
    .into()
}

pub fn decode_event(
    site: &PlannedSite,
    bytes: &[u8],
    config: &SerializerConfig,
) -> anyhow::Result<Option<NativeEvent>> {
    anyhow::ensure!(
        bytes.len() == size_of::<RawEvent>(),
        "unexpected native record size"
    );
    let raw = unsafe { (bytes.as_ptr().cast::<RawEvent>()).read_unaligned() };
    anyhow::ensure!(
        raw.abi_version == ABI_VERSION && raw.cookie == site.cookie,
        "native record identity mismatch"
    );
    anyhow::ensure!(
        usize::from(raw.slot_count) <= MAX_CAPTURE_SLOTS,
        "native record slot count exceeds ABI bounds"
    );
    anyhow::ensure!(
        raw.generation == site.generation,
        "native record generation mismatch"
    );
    anyhow::ensure!(raw.flags == 0, "native capture operation failed");
    // Decoded values remain local and unsanitized only long enough to evaluate
    // the condition. The outbound representation is built separately below.
    let mut raw_values = site.unavailable.clone();
    for (slot, path) in &site.slot_paths {
        let kind = site
            .slot_kinds
            .get(slot)
            .copied()
            .unwrap_or(dwarf::ValueKind::Unsigned);
        raw_values.insert(
            path.clone(),
            decoder::decode_node(&raw, usize::from(*slot), kind)?,
        );
    }
    if let Some(condition) = &site.probe.condition {
        if !raw_values
            .get(&condition.path)
            .is_some_and(|value| condition_matches(value, &condition.op, &condition.value))
        {
            return Ok(None);
        }
    }
    let outbound_paths = outbound_paths(&site.probe)?;
    let outbound_raw = raw_values
        .iter()
        .filter(|(path, _)| outbound_paths.contains(*path))
        .map(|(path, value)| (path.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let outbound_values = sanitize_values(outbound_raw, config);
    let now = timestamp();
    let event = match site.probe.kind.as_str() {
        "snapshot" => {
            let variables = sanitize_roots(outbound_values.clone(), config);
            NativeEvent::Snapshot {
                probe_id: site.probe.id.clone(),
                probe_version: site.probe.version,
                ts: now,
                variables,
                watches: outbound_values,
                stack: Vec::new(),
            }
        }
        "log" => NativeEvent::Log {
            probe_id: site.probe.id.clone(),
            probe_version: site.probe.version,
            ts: now,
            message: render_log(
                site.probe.template.as_deref().unwrap_or(""),
                &outbound_values,
            ),
            level: "info".into(),
        },
        "metric" => {
            let path = site.probe.metric_path.as_deref().unwrap_or("");
            let Some(SanitizedNode::Num { v }) = outbound_values.get(path) else {
                return Ok(None);
            };
            NativeEvent::Metric {
                probe_id: site.probe.id.clone(),
                probe_version: site.probe.version,
                ts: now,
                count: 1,
                sum: *v,
                min: *v,
                max: *v,
                last: *v,
            }
        }
        "counter" => return Ok(None),
        _ => anyhow::bail!("unsupported probe type"),
    };
    anyhow::ensure!(
        serde_json::to_vec(&event)?.len() <= config.max_bytes,
        "serialized event exceeds absolute byte budget"
    );
    Ok(Some(event))
}

pub fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC3339")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{broker::Condition, config::NativeLanguage, dwarf::ValueKind, events::NativeEvent};
    use liveprobe_native_protocol::RawEvent;
    use std::collections::HashMap;

    fn instance(id: &str, pid: u32, start: &str) -> DiscoveredInstance {
        DiscoveredInstance {
            instance_id: id.into(),
            service_id: "svc".into(),
            language: NativeLanguage::Rust,
            pid,
            process_start_time: start.into(),
            executable_path: "/opt/svc".into(),
            executable_device: "1:2".into(),
            executable_inode: "3".into(),
            build_id: "same-build".into(),
            architecture: "x86_64".into(),
            cgroup: None,
            last_seen: "now".into(),
        }
    }

    fn probe(kind: &str) -> ProbeAssignment {
        ProbeAssignment {
            id: "probe".into(),
            version: 7,
            kind: kind.into(),
            file: "src/main.rs".into(),
            line: 10,
            watch_paths: None,
            template: None,
            metric_path: None,
            condition: None,
            hit_limit: 3,
            ttl_seconds: 30,
        }
    }

    fn site(
        probe: ProbeAssignment,
        paths: &[(&str, ValueKind)],
        unavailable: BTreeMap<String, SanitizedNode>,
    ) -> PlannedSite {
        PlannedSite {
            probe,
            site_id: "site".into(),
            cookie: 99,
            generation: 7,
            offset: 1,
            operations: Vec::new(),
            slot_paths: paths
                .iter()
                .enumerate()
                .map(|(slot, (path, _))| (slot as u8, (*path).into()))
                .collect(),
            slot_kinds: paths
                .iter()
                .enumerate()
                .map(|(slot, (_, kind))| (slot as u8, *kind))
                .collect(),
            unavailable,
        }
    }

    fn record(cookie: u64, values: &[&[u8]]) -> Vec<u8> {
        let mut raw: RawEvent = unsafe { std::mem::zeroed() };
        raw.abi_version = ABI_VERSION;
        raw.cookie = cookie;
        raw.generation = 7;
        raw.slot_count = values.len() as u8;
        for (slot, value) in values.iter().enumerate() {
            raw.widths[slot] = value.len() as u8;
            raw.values[slot][..value.len()].copy_from_slice(value);
        }
        unsafe {
            std::slice::from_raw_parts(
                (&raw as *const RawEvent).cast::<u8>(),
                size_of::<RawEvent>(),
            )
            .to_vec()
        }
    }

    #[test]
    fn physical_sites_are_distinct_for_same_build_instances() {
        let probe = probe("counter");
        let first = instance("svc-41-100", 41, "100");
        let second = instance("svc-42-100", 42, "100");
        let first_id = physical_site_id(&first, &probe, 0);
        let second_id = physical_site_id(&second, &probe, 0);
        assert_ne!(first_id, second_id);
        let desired = HashMap::from([
            (first_id.clone(), first.instance_id.clone()),
            (second_id.clone(), second.instance_id.clone()),
        ]);
        assert_eq!(desired.len(), 2);
        assert_eq!(desired.get(&first_id), Some(&first.instance_id));
        assert_eq!(desired.get(&second_id), Some(&second.instance_id));

        let active = desired.clone();
        let desired_after_exit = HashMap::from([(second_id.clone(), second.instance_id.clone())]);
        let stale = active
            .keys()
            .filter(|site| !desired_after_exit.contains_key(*site))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(stale, vec![first_id]);

        let restarted = instance("svc-41-200", 41, "200");
        let restarted_id = physical_site_id(&restarted, &probe, 0);
        assert_ne!(restarted_id, second_id);
        assert_ne!(restarted_id, stale[0]);
    }

    #[test]
    fn condition_only_path_is_captured_but_not_emitted() {
        let mut assignment = probe("snapshot");
        assignment.watch_paths = Some(vec!["public".into()]);
        assignment.condition = Some(Condition {
            path: "guard".into(),
            op: "eq".into(),
            value: serde_json::json!(1),
        });
        assert_eq!(capture_paths(&assignment).unwrap(), vec!["guard", "public"]);
        assert_eq!(
            outbound_paths(&assignment).unwrap(),
            BTreeSet::from(["public".into()])
        );
        let planned = site(
            assignment,
            &[
                ("guard", ValueKind::Unsigned),
                ("public", ValueKind::Unsigned),
            ],
            BTreeMap::new(),
        );
        let one = 1u64.to_ne_bytes();
        let seven = 7u64.to_ne_bytes();
        let event = decode_event(
            &planned,
            &record(planned.cookie, &[&one, &seven]),
            &SerializerConfig::default(),
        )
        .unwrap()
        .unwrap();
        let NativeEvent::Snapshot { watches, .. } = event else {
            panic!("snapshot expected")
        };
        assert!(!watches.contains_key("guard"));
        assert_eq!(watches["public"], SanitizedNode::Num { v: 7.0 });

        let zero = 0u64.to_ne_bytes();
        assert!(
            decode_event(
                &planned,
                &record(planned.cookie, &[&zero, &seven]),
                &SerializerConfig::default(),
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn snapshot_and_log_never_emit_raw_redacted_values() {
        let mut config = SerializerConfig::default();
        config.redact_values.insert("exact-value".into());
        let mut snapshot = probe("snapshot");
        snapshot.watch_paths = Some(vec![
            "password".into(),
            "nested.token".into(),
            "public".into(),
        ]);
        snapshot.condition = Some(Condition {
            path: "secret.condition".into(),
            op: "eq".into(),
            value: serde_json::json!("allow"),
        });
        let planned = site(
            snapshot,
            &[
                ("nested.token", ValueKind::CString),
                ("password", ValueKind::CString),
                ("public", ValueKind::CString),
                ("secret.condition", ValueKind::CString),
            ],
            BTreeMap::new(),
        );
        let event = decode_event(
            &planned,
            &record(
                planned.cookie,
                &[
                    b"token-value\0",
                    b"password-value\0",
                    b"exact-value\0",
                    b"allow\0",
                ],
            ),
            &config,
        )
        .unwrap()
        .unwrap();
        let encoded = serde_json::to_string(&event).unwrap();
        for secret in ["token-value", "password-value", "exact-value", "allow"] {
            assert!(!encoded.contains(secret));
        }
        let NativeEvent::Snapshot {
            variables, watches, ..
        } = event
        else {
            panic!("snapshot expected")
        };
        assert_eq!(watches["password"], SanitizedNode::Redacted);
        assert_eq!(watches["nested.token"], SanitizedNode::Redacted);
        assert_eq!(watches["public"], SanitizedNode::Redacted);
        assert!(!watches.contains_key("secret.condition"));
        let SanitizedNode::Obj { c } = variables else {
            panic!("object expected")
        };
        assert_eq!(c, watches);

        let mut log = probe("log");
        log.template = Some("pw=${password} token=${nested.token} safe=${public}".into());
        let planned = site(
            log,
            &[
                ("nested.token", ValueKind::CString),
                ("password", ValueKind::CString),
                ("public", ValueKind::CString),
            ],
            BTreeMap::new(),
        );
        let event = decode_event(
            &planned,
            &record(
                planned.cookie,
                &[b"token-value\0", b"password-value\0", b"exact-value\0"],
            ),
            &config,
        )
        .unwrap()
        .unwrap();
        let NativeEvent::Log { message, .. } = event else {
            panic!("log expected")
        };
        assert_eq!(message, "pw=[complex] token=[complex] safe=[complex]");
    }

    #[test]
    fn redacted_metric_is_not_emitted() {
        let mut assignment = probe("metric");
        assignment.metric_path = Some("requests".into());
        let planned = site(
            assignment,
            &[("requests", ValueKind::Unsigned)],
            BTreeMap::new(),
        );
        let value = 4242u64.to_ne_bytes();
        let mut config = SerializerConfig::default();
        config.redact_values.insert("4242".into());
        assert!(
            decode_event(&planned, &record(planned.cookie, &[&value]), &config,)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn conditional_native_counter_is_rejected_instead_of_silently_undercounted() {
        let mut assignment = probe("counter");
        assignment.condition = Some(Condition {
            path: "enabled".into(),
            op: "eq".into(),
            value: serde_json::json!(1),
        });
        let error = capture_paths(&assignment).unwrap_err().to_string();
        assert!(error.contains("conditional native counters cannot aggregate in BPF"));
    }

    #[test]
    fn sampling_plan_changes_the_physical_generation_and_preserves_abi() {
        let target = instance("svc-1-10", 1, "10");
        let mut snapshot = probe("snapshot");
        snapshot.watch_paths = Some(vec!["value".into()]);
        let mut planned = site(snapshot, &[("value", ValueKind::Unsigned)], BTreeMap::new());
        let every_one = planned.attach_request(&target, false, 1);
        let every_two = planned.attach_request(&target, false, 2);
        let larger = planned.attach_request(&target, false, 97);
        assert_eq!(every_one.abi_version, ABI_VERSION);
        assert_eq!(every_one.sample_every, 1);
        assert_eq!(every_two.sample_every, 2);
        assert_eq!(larger.sample_every, 97);
        assert_ne!(every_one.generation, every_two.generation);
        assert_ne!(every_two.generation, larger.generation);

        planned.generation = every_two.generation;
        let mut raw_hit_baseline = Some(crate::safety::RawHitSample {
            generation: planned.generation,
            count: 0,
            sampled_at_millis: 0,
        });
        let first_interval = crate::safety::sample_raw_hit_rate(
            &mut raw_hit_baseline,
            planned.generation,
            200,
            1_000,
        )
        .expect("physical generation must preserve the first safety interval");
        assert_eq!(first_interval.hits, 200);
        assert_eq!(first_interval.per_second, 200.0);

        let value = 4242u64.to_ne_bytes();
        let mut current = record(planned.cookie, &[&value]);
        current[4..8].copy_from_slice(&every_two.generation.to_ne_bytes());
        assert!(decode_event(&planned, &current, &SerializerConfig::default()).is_ok());
        let mut stale = current;
        stale[4..8].copy_from_slice(&every_one.generation.to_ne_bytes());
        assert!(decode_event(&planned, &stale, &SerializerConfig::default()).is_err());
    }

    #[test]
    fn zero_operation_literal_log_and_unavailable_snapshot_are_valid() {
        let target = instance("svc-1-10", 1, "10");
        let mut log = probe("log");
        log.template = Some("literal message".into());
        assert!(capture_paths(&log).unwrap().is_empty());
        let planned_log = site(log, &[], BTreeMap::new());
        assert!(
            planned_log
                .attach_request(&target, false, 1)
                .plan
                .is_empty()
        );
        let event = decode_event(
            &planned_log,
            &record(planned_log.cookie, &[]),
            &SerializerConfig::default(),
        )
        .unwrap()
        .unwrap();
        assert!(matches!(
            event,
            NativeEvent::Log { ref message, .. } if message == "literal message"
        ));

        let mut snapshot = probe("snapshot");
        snapshot.watch_paths = Some(vec!["missing".into()]);
        let unavailable = BTreeMap::from([(
            "missing".into(),
            SanitizedNode::Unavailable {
                v: UnavailableValue {
                    reason_code: "variable-optimized-out".into(),
                    detail: Some("secret resolver detail".into()),
                    site_id: Some("site".into()),
                    build_id: Some("same-build".into()),
                },
            },
        )]);
        let planned_snapshot = site(snapshot, &[], unavailable);
        assert!(
            planned_snapshot
                .attach_request(&target, false, 1)
                .plan
                .is_empty()
        );
        let event = decode_event(
            &planned_snapshot,
            &record(planned_snapshot.cookie, &[]),
            &SerializerConfig::default(),
        )
        .unwrap()
        .unwrap();
        let encoded = serde_json::to_string(&event).unwrap();
        assert!(encoded.contains("variable-optimized-out"));
        assert!(!encoded.contains("secret resolver detail"));
    }

    #[test]
    fn malformed_and_failed_events_do_not_block_a_later_valid_event() {
        let mut assignment = probe("snapshot");
        assignment.watch_paths = Some(vec!["value".into()]);
        let planned = site(
            assignment,
            &[("value", ValueKind::Unsigned)],
            BTreeMap::new(),
        );
        let value = 42u64.to_ne_bytes();
        let valid = record(planned.cookie, &[&value]);
        let config = SerializerConfig::default();
        let mut faults = EventFaultBudget::default();

        assert!(matches!(
            decode_event_isolated(&planned, &[1, 2, 3], &config, &mut faults, 0),
            IsolatedDecode::Failed { detach: false, .. }
        ));
        let mut bad_abi = valid.clone();
        bad_abi[0] = 0xff;
        assert!(matches!(
            decode_event_isolated(&planned, &bad_abi, &config, &mut faults, 1),
            IsolatedDecode::Failed { detach: false, .. }
        ));
        let mut unsupported = valid.clone();
        let widths_offset = 32;
        unsupported[widths_offset] = 3;
        assert!(matches!(
            decode_event_isolated(&planned, &unsupported, &config, &mut faults, 2),
            IsolatedDecode::Failed { detach: false, .. }
        ));
        let tiny = SerializerConfig {
            max_bytes: 1,
            ..SerializerConfig::default()
        };
        assert!(matches!(
            decode_event_isolated(&planned, &valid, &tiny, &mut faults, 3),
            IsolatedDecode::Failed { detach: false, .. }
        ));
        assert!(matches!(
            decode_event_isolated(&planned, &valid, &config, &mut faults, 4),
            IsolatedDecode::Event(NativeEvent::Snapshot { .. })
        ));
    }

    #[test]
    fn repeated_site_failures_are_rate_limited_and_eventually_detach() {
        let mut assignment = probe("snapshot");
        assignment.watch_paths = Some(vec!["value".into()]);
        let planned = site(
            assignment,
            &[("value", ValueKind::Unsigned)],
            BTreeMap::new(),
        );
        let mut faults = EventFaultBudget::default();
        for attempt in 0..5 {
            let result = decode_event_isolated(
                &planned,
                &[0],
                &SerializerConfig::default(),
                &mut faults,
                attempt as u64,
            );
            let IsolatedDecode::Failed { report, detach, .. } = result else {
                panic!("failure expected")
            };
            assert_eq!(report, attempt == 0);
            assert_eq!(detach, attempt == 4);
        }
    }
}
