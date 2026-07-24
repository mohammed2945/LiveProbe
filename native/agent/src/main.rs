use liveprobe_native_agent::{
    broker::{AgentStatus, BrokerClient, NativeIngest, Registration, is_retryable},
    config::AgentConfig,
    discovery::{self, DiscoveredInstance},
    events::{NativeEvent, ResolutionStatus},
    loader_client::LoaderClient,
    registry::InstanceRegistry,
    resilience::JitteredBackoff,
    runtime::{self, EventFaultBudget, IsolatedDecode, PlannedSite},
    safety::{PreflightDecision, RawHitSample, decide_preflight, sample_raw_hit_rate},
    serializer::{SerializerConfig, sanitize_diagnostic_detail},
    symbols,
};
use liveprobe_native_protocol::{LoaderRequest, LoaderResponse, MAX_EVENT_BATCH};
use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn request_shutdown(_signal: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::Relaxed);
}

struct ActiveSite {
    site: PlannedSite,
    instance: DiscoveredInstance,
    attached_at: Instant,
    last_captures: u64,
    last_raw_sample: Option<RawHitSample>,
    supervisor_ready: bool,
    physical_site_count: u32,
    event_faults: EventFaultBudget,
}

fn main() -> anyhow::Result<()> {
    if !cfg!(target_os = "linux") {
        anyhow::bail!("liveprobe-native-agent only runs on Linux");
    }
    install_shutdown_handlers()?;
    let path = env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("usage: liveprobe-native-agent CONFIG.json"))?;
    let config = AgentConfig::from_path(Path::new(&path))?;
    let token = env::var("LIVEPROBE_NATIVE_CREDENTIAL")
        .map_err(|_| anyhow::anyhow!("LIVEPROBE_NATIVE_CREDENTIAL is required"))?;
    anyhow::ensure!(
        token.starts_with("lp_native_"),
        "LIVEPROBE_NATIVE_CREDENTIAL has the wrong credential type"
    );
    let client = BrokerClient::new(config.broker_url.clone(), Some(token));
    let loader = LoaderClient::new(&config.loader_socket);
    let hostname = std::fs::read_to_string("/etc/hostname")
        .unwrap_or_else(|_| "unknown-linux-host".into())
        .trim()
        .to_owned();
    let registration = Registration {
        agent_id: config.agent_id.clone(),
        hostname,
        backend: "native-ebpf",
        architecture: std::env::consts::ARCH.replace("amd64", "x86_64"),
        capabilities: vec![
            "uprobe",
            "ring-buffer",
            "btf",
            "dwarf",
            "count",
            "snapshot-scalar",
            "log",
            "counter",
            "metric",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        agent_version: env!("CARGO_PKG_VERSION").into(),
    };
    let mut registration_backoff = JitteredBackoff::new(100, 10_000);
    while !SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
        match client.register(&registration) {
            Ok(acceptance) => {
                anyhow::ensure!(
                    acceptance.accepted && acceptance.agent_id == config.agent_id,
                    "native broker registration identity mismatch"
                );
                let allowed: HashSet<_> = acceptance
                    .allowed_service_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                anyhow::ensure!(
                    allowed.contains("*")
                        || config
                            .services
                            .iter()
                            .all(|service| allowed.contains(service.service_id.as_str())),
                    "configured native service selector is outside credential scope"
                );
                break;
            }
            Err(error) => {
                if !is_retryable(&error) {
                    return Err(error.context("permanent native broker registration rejection"));
                }
                let delay = registration_backoff.next_delay_millis(std::process::id().into());
                eprintln!(
                    "native broker registration unavailable; retrying in {delay}ms: {error:#}"
                );
                interruptible_sleep(Duration::from_millis(delay));
            }
        }
    }
    if SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
        return Ok(());
    }
    let mut registry = InstanceRegistry::default();
    let mut assignment_version = 0;
    let mut cached_assignment_version = None;
    let mut cached_desired: HashMap<String, (PlannedSite, DiscoveredInstance)> = HashMap::new();
    let mut active: HashMap<String, ActiveSite> = HashMap::new();
    let mut terminal_sites = HashSet::new();
    let mut pending_detaches: HashSet<String> = HashSet::new();
    let mut terminal_probes = HashSet::new();
    let mut logical_captures: HashMap<String, u64> = HashMap::new();
    let mut serializer = SerializerConfig {
        max_bytes: config.safety.max_event_bytes,
        ..SerializerConfig::default()
    };
    serializer
        .redact_keys
        .extend(config.redact_keys.iter().cloned());
    serializer
        .redact_values
        .extend(config.redact_values.iter().cloned());
    let mut budget_window = Instant::now();
    let monotonic_epoch = Instant::now();
    let mut serializer_millis = 0u128;
    let mut outbound_bytes = 0u64;
    let mut invalid_envelope_count = 0u32;
    let mut capture_subsystem_disabled = false;
    let mut cycle_backoff = JitteredBackoff::new(100, 10_000);
    let mut loader_identity = None;
    let mut loader_available = false;
    let mut loader_retry_at = Instant::now();
    let mut loader_backoff = JitteredBackoff::new(100, 10_000);
    while !SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
        if Instant::now() >= loader_retry_at {
            match loader.verify_compatibility() {
                Ok(identity) => {
                    if loader_identity.is_some_and(|previous| previous != identity) {
                        // Loader-owned links disappear on loader restart. Forget only physical
                        // attachment state; complete broker desired state will recreate it.
                        active.clear();
                        pending_detaches.clear();
                    }
                    loader_identity = Some(identity);
                    loader_available = true;
                    loader_backoff.reset();
                }
                Err(error) => {
                    if error.to_string().contains("abi-incompatible") {
                        return Err(error);
                    }
                    loader_available = false;
                    let delay = loader_backoff.next_delay_millis(std::process::id().into());
                    loader_retry_at = Instant::now() + Duration::from_millis(delay);
                    eprintln!("native loader unavailable; retrying in {delay}ms: {error:#}");
                }
            }
        }
        let cycle_result = (|| -> anyhow::Result<()> {
            if loader_available {
                for site_id in pending_detaches.clone() {
                    if detach_succeeded(&loader, &site_id, "retry-detach") {
                        pending_detaches.remove(&site_id);
                        if active.remove(&site_id).is_some() {
                            terminal_sites.insert(site_id);
                        }
                    }
                }
            }
            if budget_window.elapsed() >= Duration::from_secs(1) {
                budget_window = Instant::now();
                serializer_millis = 0;
                outbound_bytes = 0;
            }
            let now = unix_timestamp();
            let known = registry.values().cloned().collect::<Vec<_>>();
            let discovery = match discovery::discover_with_known(
                Path::new("/proc"),
                &config.services,
                &now,
                &known,
            ) {
                Ok(discovery) => discovery,
                Err(error) => {
                    eprintln!(
                        "temporary procfs discovery failure; retaining known instances: {error:#}"
                    );
                    discovery::DiscoveryReport {
                        instances: known.clone(),
                        issues: Vec::new(),
                    }
                }
            };
            for issue in &discovery.issues {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "type": "native-discovery-status",
                        "pid": issue.pid,
                        "instanceId": issue.instance_id,
                        "serviceId": issue.service_id,
                        "reasonCode": issue.reason_code,
                        "detail": sanitize_diagnostic_detail(Some(issue.detail.clone()), &serializer),
                    })
                );
                let Some(instance) = known.iter().find(|instance| {
                    issue.instance_id.as_deref() == Some(instance.instance_id.as_str())
                        || (issue.instance_id.is_none()
                            && issue.service_id.as_deref() == Some(instance.service_id.as_str())
                            && issue.pid == instance.pid)
                }) else {
                    continue;
                };
                let probes = active
                    .values()
                    .filter(|site| site.instance.instance_id == instance.instance_id)
                    .map(|site| (site.site.probe.id.clone(), site.site.probe.version))
                    .collect::<HashSet<_>>();
                for (probe_id, probe_version) in probes {
                    send_status(
                        &client,
                        &config.agent_id,
                        instance,
                        &probe_id,
                        "error",
                        Some(issue.reason_code),
                        &serializer,
                        Some(issue.detail.clone()),
                        Some(probe_version),
                    )?;
                }
            }
            registry.reconcile(discovery.instances);
            client.flush_pending_ingest();
            // Registration is idempotent and restores ownership after a broker restart.
            // A control-plane outage must not stop local polling or safety supervision.
            let assignments = match client.register(&registration) {
                Ok(_) => match client.replace_instances(
                    &config.agent_id,
                    &registry.values().cloned().collect::<Vec<_>>(),
                ) {
                    Ok(()) => match client.assignments(&config.agent_id, assignment_version) {
                        Ok(assignments) => {
                            assignment_version = assignments.version;
                            Some(assignments)
                        }
                        Err(error) => {
                            eprintln!(
                                "native assignment polling unavailable; retaining cached desired state: {error:#}"
                            );
                            None
                        }
                    },
                    Err(error) => {
                        eprintln!(
                            "native instance reconciliation unavailable; retaining cached desired state: {error:#}"
                        );
                        None
                    }
                },
                Err(error) => {
                    eprintln!(
                        "native broker registration unavailable; retaining cached desired state: {error:#}"
                    );
                    None
                }
            };
            let instances: HashMap<_, _> = registry
                .values()
                .cloned()
                .map(|instance| (instance.instance_id.clone(), instance))
                .collect();
            let desired = if assignments.is_none() {
                cached_desired.clone()
            } else if cached_assignment_version == Some(assignments.as_ref().unwrap().version) {
                cached_desired.clone()
            } else {
                let assignments = assignments.expect("checked as present");
                let mut rebuilt = HashMap::new();
                let mut rebuild_retry_required = false;
                let mut retry_logicals = HashSet::new();
                for assignment in assignments.assignments {
                    let Some(instance) = instances.get(&assignment.instance_id) else {
                        continue;
                    };
                    if instance.build_id != assignment.build_id {
                        continue;
                    }
                    let symbol_dirs = config
                        .symbol_directories
                        .iter()
                        .map(PathBuf::from)
                        .collect::<Vec<_>>();
                    let debug = match symbols::find_or_fetch_debug_artifact(
                        Path::new(&instance.executable_path),
                        &symbol_dirs,
                        config.debuginfod_url.as_deref(),
                        config.symbol_cache_directory.as_deref().map(Path::new),
                    ) {
                        Ok(debug) => debug,
                        Err(error) => {
                            let detail = error.to_string();
                            let reason = permanent_reason_from_error(&detail);
                            if let Some(reason) = reason {
                                for probe in &assignment.probes {
                                    send_status(
                                        &client,
                                        &config.agent_id,
                                        instance,
                                        &probe.id,
                                        "error",
                                        Some(reason),
                                        &serializer,
                                        Some(detail.clone()),
                                        Some(probe.version),
                                    )?;
                                }
                            }
                            if reason.is_none() || reason == Some("no-debug-info") {
                                rebuild_retry_required = true;
                                retry_logicals.extend(
                                    assignment
                                        .probes
                                        .iter()
                                        .map(|probe| assignment_logical_key(probe, instance)),
                                );
                                eprintln!(
                                    "temporary symbol or debuginfod retrieval failure; retaining cached plan: {error:#}"
                                );
                            }
                            continue;
                        }
                    };
                    for probe in assignment.probes {
                        let planned = match debug.as_deref() {
                            Some(path) => runtime::plan_probe(instance, &probe, path),
                            None => Err(anyhow::anyhow!("no-debug-info")),
                        };
                        match planned {
                            Ok(sites) => {
                                for site in sites {
                                    rebuilt.insert(site.site_id.clone(), (site, instance.clone()));
                                }
                            }
                            Err(error) => {
                                let detail = error.to_string();
                                send_status(
                                    &client,
                                    &config.agent_id,
                                    instance,
                                    &probe.id,
                                    "error",
                                    Some(reason_from_error(&detail)),
                                    &serializer,
                                    None,
                                    Some(probe.version),
                                )?;
                                if planning_error_should_retry(&detail) {
                                    rebuild_retry_required = true;
                                    retry_logicals.insert(assignment_logical_key(&probe, instance));
                                }
                            }
                        }
                    }
                }
                if rebuild_retry_required {
                    for (site_id, cached) in &cached_desired {
                        if retry_logicals.contains(&logical_key(&cached.0, &cached.1)) {
                            rebuilt
                                .entry(site_id.clone())
                                .or_insert_with(|| cached.clone());
                        }
                    }
                    cached_assignment_version = None;
                    cached_desired = rebuilt.clone();
                    rebuilt
                } else {
                    cached_assignment_version = Some(assignments.version);
                    cached_desired = rebuilt.clone();
                    rebuilt
                }
            };
            let stale = active
                .keys()
                .filter(|site| !desired.contains_key(*site))
                .cloned()
                .collect::<Vec<_>>();
            for site_id in stale {
                if loader_available && detach_succeeded(&loader, &site_id, "detach") {
                    active.remove(&site_id);
                }
            }
            terminal_sites.retain(|site| desired.contains_key(site));
            let desired_logical = desired
                .values()
                .map(|(site, instance)| logical_key(site, instance))
                .collect::<HashSet<_>>();
            terminal_probes.retain(|probe| desired_logical.contains(probe));
            logical_captures.retain(|probe, _| desired_logical.contains(probe));
            let mut physical_site_counts = HashMap::new();
            for (site, instance) in desired.values() {
                *physical_site_counts
                    .entry(format!("{}\0{}", instance.instance_id, site.probe.id))
                    .or_insert(0u32) += 1;
            }
            for (site_id, (site, instance)) in desired {
                if active.contains_key(&site_id)
                    || terminal_sites.contains(&site_id)
                    || terminal_probes.contains(&logical_key(&site, &instance))
                {
                    continue;
                }
                if !loader_available {
                    continue;
                }
                if capture_subsystem_disabled {
                    send_status(
                        &client,
                        &config.agent_id,
                        &instance,
                        &site.probe.id,
                        "error",
                        Some("capture-event-invalid"),
                        &serializer,
                        Some(
                            "native capture subsystem disabled after repeated invalid envelopes"
                                .into(),
                        ),
                        Some(site.probe.version),
                    )?;
                    continue;
                }
                if active.len() >= config.safety.max_attachments {
                    send_status(
                        &client,
                        &config.agent_id,
                        &instance,
                        &site.probe.id,
                        "error",
                        Some("local-policy-denied"),
                        &serializer,
                        Some("host attachment limit reached".into()),
                        Some(site.probe.version),
                    )?;
                    continue;
                }
                let mut sample_every = 1u32;
                if site.probe.kind != "counter" {
                    let mut preflight = site.attach_request(&instance, true, 1);
                    preflight.site_id = format!("{}:preflight", site.site_id);
                    preflight.request_id = format!("attach:{}", preflight.site_id);
                    preflight.cookie ^= u64::MAX;
                    match loader.call(&LoaderRequest::Attach {
                        request: preflight.clone(),
                    }) {
                        Err(error) => {
                            loader_available = false;
                            let delay = loader_backoff.next_delay_millis(std::process::id().into());
                            loader_retry_at = Instant::now() + Duration::from_millis(delay);
                            eprintln!(
                                "temporary loader connection failure during preflight attach; retrying in {delay}ms: {error:#}"
                            );
                            continue;
                        }
                        Ok(LoaderResponse::Attached { .. }) => {}
                        Ok(LoaderResponse::Error { detail, .. }) => {
                            send_status(
                                &client,
                                &config.agent_id,
                                &instance,
                                &site.probe.id,
                                "error",
                                Some("uprobe-attach-failed"),
                                &serializer,
                                Some(detail),
                                Some(site.probe.version),
                            )?;
                            continue;
                        }
                        Ok(_) => continue,
                    }
                    interruptible_sleep(Duration::from_secs(config.safety.preflight_seconds));
                    if SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let raw_hits = match loader.call(&LoaderRequest::ReadCounters {
                        request_id: format!("preflight-counters:{}", site.site_id),
                        cookie: preflight.cookie,
                    }) {
                        Ok(LoaderResponse::Counters { raw_hits, .. }) => raw_hits,
                        Ok(_) => 0,
                        Err(error) => {
                            pending_detaches.insert(preflight.site_id.clone());
                            eprintln!(
                                "preflight counter read failed and cleanup is pending: {error:#}"
                            );
                            continue;
                        }
                    };
                    if !detach_succeeded(&loader, &preflight.site_id, "preflight-detach") {
                        pending_detaches.insert(preflight.site_id.clone());
                        send_status(
                            &client,
                            &config.agent_id,
                            &instance,
                            &site.probe.id,
                            "error",
                            Some("uprobe-attach-failed"),
                            &serializer,
                            Some("preflight attachment cleanup is pending".into()),
                            Some(site.probe.version),
                        )?;
                        continue;
                    }
                    match decide_preflight(
                        raw_hits,
                        config.safety.preflight_seconds.saturating_mul(1000),
                        config.safety.per_probe_raw_hits_per_second,
                    ) {
                        PreflightDecision::Reject => {
                            send_status(
                                &client,
                                &config.agent_id,
                                &instance,
                                &site.probe.id,
                                "suspended",
                                Some("raw-hit-budget-exceeded"),
                                &serializer,
                                Some(format!("preflight observed {raw_hits} hits")),
                                Some(site.probe.version),
                            )?;
                            continue;
                        }
                        PreflightDecision::Sample { every } => {
                            sample_every = u32::try_from(every).unwrap_or(u32::MAX).max(1);
                        }
                        PreflightDecision::Approve => {}
                    }
                }
                let request = site.attach_request(&instance, false, sample_every);
                match loader.call(&LoaderRequest::Attach {
                    request: request.clone(),
                }) {
                    Ok(LoaderResponse::Attached { .. }) => {
                        let mut site = site;
                        site.generation = request.generation;
                        let count = physical_site_counts
                            .get(&format!("{}\0{}", instance.instance_id, site.probe.id))
                            .copied()
                            .unwrap_or(1);
                        send_site_status(
                            &client,
                            &config.agent_id,
                            &instance,
                            &site,
                            "armed",
                            None,
                            &serializer,
                            Some(format!("site {} build {}", site.site_id, instance.build_id)),
                            Some(count),
                            None,
                            None,
                        )?;
                        active.insert(
                            site_id,
                            ActiveSite {
                                last_raw_sample: Some(RawHitSample {
                                    generation: site.generation,
                                    count: 0,
                                    sampled_at_millis: monotonic_epoch
                                        .elapsed()
                                        .as_millis()
                                        .try_into()
                                        .unwrap_or(u64::MAX),
                                }),
                                site,
                                instance,
                                attached_at: Instant::now(),
                                last_captures: 0,
                                supervisor_ready: false,
                                physical_site_count: count,
                                event_faults: EventFaultBudget::default(),
                            },
                        );
                    }
                    Ok(LoaderResponse::Error { detail, .. }) => send_status(
                        &client,
                        &config.agent_id,
                        &instance,
                        &site.probe.id,
                        "error",
                        Some("uprobe-attach-failed"),
                        &serializer,
                        Some(detail),
                        Some(site.probe.version),
                    )?,
                    Err(error) => {
                        loader_available = false;
                        let delay = loader_backoff.next_delay_millis(std::process::id().into());
                        loader_retry_at = Instant::now() + Duration::from_millis(delay);
                        eprintln!(
                            "temporary loader connection failure during attach; retrying site {site_id} in {delay}ms: {error:#}"
                        );
                    }
                    Ok(_) => {}
                }
            }
            let mut reached_logical_limits = HashSet::new();
            let mut decode_detach = Vec::new();
            for batch in 0..if loader_available { 64 } else { 0 } {
                let records = match loader.call(&LoaderRequest::PollEvents {
                    request_id: format!("poll-events:{batch}"),
                    timeout_millis: if batch == 0 { 100 } else { 0 },
                    max_events: MAX_EVENT_BATCH,
                }) {
                    Ok(LoaderResponse::Events { records, .. }) => records,
                    Ok(_) | Err(_) => break,
                };
                if records.is_empty() {
                    break;
                }
                for record in records {
                    if record.len() < 32 {
                        if capture_subsystem_disabled {
                            continue;
                        }
                        invalid_envelope_count = invalid_envelope_count.saturating_add(1);
                        if invalid_envelope_count >= 5 {
                            capture_subsystem_disabled = true;
                            for (site_id, active_site) in &active {
                                send_site_status(
                                    &client,
                                    &config.agent_id,
                                    &active_site.instance,
                                    &active_site.site,
                                    "error",
                                    Some("capture-event-invalid"),
                                    &serializer,
                                    Some("native ring-buffer record is truncated".into()),
                                    None,
                                    None,
                                    None,
                                )?;
                                decode_detach.push(site_id.clone());
                            }
                        }
                        continue;
                    }
                    let cookie =
                        u64::from_ne_bytes(record[24..32].try_into().expect("cookie bytes"));
                    let Some(site_id) = active.iter().find_map(|(site_id, active)| {
                        (active.site.cookie == cookie).then(|| site_id.clone())
                    }) else {
                        continue;
                    };
                    let Some(site) = active.get_mut(&site_id) else {
                        continue;
                    };
                    let logical = logical_key(&site.site, &site.instance);
                    let accepted = logical_captures.entry(logical.clone()).or_default();
                    if *accepted >= site.site.probe.hit_limit {
                        reached_logical_limits.insert(logical);
                        continue;
                    }
                    let decode_started = Instant::now();
                    let outcome = runtime::decode_event_isolated(
                        &site.site,
                        &record,
                        &serializer,
                        &mut site.event_faults,
                        monotonic_epoch
                            .elapsed()
                            .as_millis()
                            .try_into()
                            .unwrap_or(u64::MAX),
                    );
                    serializer_millis =
                        serializer_millis.saturating_add(decode_started.elapsed().as_millis());
                    match outcome {
                        IsolatedDecode::Filtered => {}
                        IsolatedDecode::Event(event) => {
                            let bytes = serde_json::to_vec(&event)?.len() as u64;
                            if serializer_millis
                                <= u128::from(config.safety.max_serializer_millis_per_second)
                                && outbound_bytes.saturating_add(bytes)
                                    <= config.safety.max_outbound_bytes_per_second
                            {
                                send_events(
                                    &client,
                                    &config.agent_id,
                                    &site.instance,
                                    vec![event],
                                )?;
                                outbound_bytes = outbound_bytes.saturating_add(bytes);
                                *accepted += 1;
                                if *accepted >= site.site.probe.hit_limit {
                                    reached_logical_limits.insert(logical);
                                }
                            }
                        }
                        IsolatedDecode::Failed {
                            reason_code,
                            detail,
                            report,
                            detach,
                        } => {
                            if report || detach {
                                send_site_status(
                                    &client,
                                    &config.agent_id,
                                    &site.instance,
                                    &site.site,
                                    if detach { "suspended" } else { "error" },
                                    Some(reason_code),
                                    &serializer,
                                    Some(detail),
                                    None,
                                    None,
                                    None,
                                )?;
                            }
                            if detach {
                                decode_detach.push(site_id);
                            }
                        }
                    }
                }
            }
            let mut detach = decode_detach;
            let mut safety_terminal_logicals = HashSet::new();
            let mut host_raw_hit_rate = 0f64;
            for (site_id, active_site) in &mut active {
                if !loader_available {
                    break;
                }
                let counters = loader.call(&LoaderRequest::ReadCounters {
                    request_id: format!("counters:{site_id}"),
                    cookie: active_site.site.cookie,
                });
                let Ok(LoaderResponse::Counters {
                    raw_hits,
                    captures,
                    dropped,
                    ..
                }) = counters
                else {
                    continue;
                };
                if active_site.site.probe.kind == "counter" && captures > active_site.last_captures
                {
                    let logical = logical_key(&active_site.site, &active_site.instance);
                    let accepted = logical_captures.entry(logical.clone()).or_default();
                    let delta = (captures - active_site.last_captures)
                        .min(active_site.site.probe.hit_limit.saturating_sub(*accepted));
                    if delta > 0 {
                        send_events(
                            &client,
                            &config.agent_id,
                            &active_site.instance,
                            vec![NativeEvent::Counter {
                                probe_id: active_site.site.probe.id.clone(),
                                probe_version: active_site.site.probe.version,
                                ts: runtime::timestamp(),
                                delta,
                            }],
                        )?;
                        *accepted += delta;
                    }
                    if *accepted >= active_site.site.probe.hit_limit {
                        reached_logical_limits.insert(logical);
                    }
                }
                active_site.last_captures = captures;
                let elapsed = active_site.attached_at.elapsed();
                let rate = sample_raw_hit_rate(
                    &mut active_site.last_raw_sample,
                    active_site.site.generation,
                    raw_hits,
                    monotonic_epoch
                        .elapsed()
                        .as_millis()
                        .try_into()
                        .unwrap_or(u64::MAX),
                )
                .map_or(0.0, |sample| sample.per_second);
                if !active_site.supervisor_ready {
                    send_site_status(
                        &client,
                        &config.agent_id,
                        &active_site.instance,
                        &active_site.site,
                        "armed",
                        None,
                        &serializer,
                        Some("raw-hit safety supervisor initialized".into()),
                        Some(active_site.physical_site_count),
                        Some(rate),
                        Some(dropped),
                    )?;
                    active_site.supervisor_ready = true;
                }
                host_raw_hit_rate += rate;
                let outcome = if elapsed.as_secs() >= active_site.site.probe.ttl_seconds {
                    Some(("expired", None, "TTL elapsed".into()))
                } else if rate > config.safety.per_probe_raw_hits_per_second as f64 {
                    Some((
                        "suspended",
                        Some("raw-hit-budget-exceeded"),
                        format!("raw hits={raw_hits}"),
                    ))
                } else if dropped > 0 {
                    send_site_status(
                        &client,
                        &config.agent_id,
                        &active_site.instance,
                        &active_site.site,
                        "armed",
                        Some("ring-buffer-full"),
                        &serializer,
                        Some(format!("dropped events={dropped}")),
                        Some(active_site.physical_site_count),
                        Some(rate),
                        Some(dropped),
                    )?;
                    None
                } else {
                    None
                };
                if let Some((status, reason, detail)) = outcome {
                    safety_terminal_logicals
                        .insert(logical_key(&active_site.site, &active_site.instance));
                    send_site_status(
                        &client,
                        &config.agent_id,
                        &active_site.instance,
                        &active_site.site,
                        status,
                        reason,
                        &serializer,
                        Some(detail),
                        Some(active_site.physical_site_count),
                        Some(rate),
                        Some(dropped),
                    )?;
                    detach.push(site_id.clone());
                }
            }
            for logical in safety_terminal_logicals {
                detach.extend(
                    active
                        .iter()
                        .filter(|(_, active_site)| {
                            logical_key(&active_site.site, &active_site.instance) == logical
                        })
                        .map(|(site_id, _)| site_id.clone()),
                );
                terminal_probes.insert(logical);
            }
            if host_raw_hit_rate > config.safety.max_raw_hits_per_second as f64 {
                for (site_id, active_site) in &active {
                    if detach.contains(site_id) {
                        continue;
                    }
                    send_site_status(
                        &client,
                        &config.agent_id,
                        &active_site.instance,
                        &active_site.site,
                        "suspended",
                        Some("raw-hit-budget-exceeded"),
                        &serializer,
                        Some(format!("host raw hit rate={host_raw_hit_rate:.1}/s")),
                        None,
                        Some(host_raw_hit_rate),
                        None,
                    )?;
                    detach.push(site_id.clone());
                }
            }
            for logical in reached_logical_limits {
                if terminal_probes.contains(&logical) {
                    continue;
                }
                if let Some(active_site) = active.values().find(|active_site| {
                    logical_key(&active_site.site, &active_site.instance) == logical
                }) {
                    send_site_status(
                        &client,
                        &config.agent_id,
                        &active_site.instance,
                        &active_site.site,
                        "hit-limit-reached",
                        None,
                        &serializer,
                        Some("logical hit limit reached".into()),
                        None,
                        None,
                        None,
                    )?;
                }
                detach.extend(
                    active
                        .iter()
                        .filter(|(_, active_site)| {
                            logical_key(&active_site.site, &active_site.instance) == logical
                        })
                        .map(|(site_id, _)| site_id.clone()),
                );
                terminal_probes.insert(logical);
            }
            detach.sort();
            detach.dedup();
            for site_id in detach {
                if detach_succeeded(&loader, &site_id, "safety-detach") {
                    active.remove(&site_id);
                    terminal_sites.insert(site_id);
                } else if let Some(active_site) = active.get(&site_id) {
                    pending_detaches.insert(site_id.clone());
                    send_site_status(
                        &client,
                        &config.agent_id,
                        &active_site.instance,
                        &active_site.site,
                        "error",
                        Some("uprobe-attach-failed"),
                        &serializer,
                        Some("attachment cleanup failed and will be retried".into()),
                        None,
                        None,
                        None,
                    )?;
                }
            }
            Ok(())
        })();
        match cycle_result {
            Ok(()) => {
                cycle_backoff.reset();
                interruptible_sleep(Duration::from_millis(config.safety.poll_interval_millis));
            }
            Err(error) => {
                let delay = cycle_backoff.next_delay_millis(std::process::id().into());
                eprintln!("native reconciliation cycle failed; retrying in {delay}ms: {error:#}");
                interruptible_sleep(Duration::from_millis(delay));
            }
        }
    }
    Ok(())
}

fn install_shutdown_handlers() -> anyhow::Result<()> {
    for signal in [libc::SIGINT, libc::SIGTERM] {
        let previous =
            unsafe { libc::signal(signal, request_shutdown as *const () as libc::sighandler_t) };
        anyhow::ensure!(
            previous != libc::SIG_ERR,
            "unable to install shutdown signal handler"
        );
    }
    Ok(())
}

fn interruptible_sleep(duration: Duration) {
    let deadline = Instant::now() + duration;
    while !SHUTDOWN_REQUESTED.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(50)));
    }
}

fn detach_succeeded(loader: &LoaderClient, site_id: &str, request_prefix: &str) -> bool {
    matches!(
        loader.call(&LoaderRequest::Detach {
            request_id: format!("{request_prefix}:{site_id}"),
            site_id: site_id.to_owned(),
        }),
        Ok(LoaderResponse::Detached { .. })
    )
}

fn send_events(
    client: &BrokerClient,
    agent_id: &str,
    instance: &DiscoveredInstance,
    events: Vec<NativeEvent>,
) -> anyhow::Result<()> {
    client.ingest(&NativeIngest {
        agent_id: agent_id.into(),
        service_id: instance.service_id.clone(),
        instance_id: instance.instance_id.clone(),
        build_id: instance.build_id.clone(),
        backend: "native-ebpf",
        agent_status: AgentStatus {
            state: "green",
            detail: None,
        },
        events,
    })
}

fn send_status(
    client: &BrokerClient,
    agent_id: &str,
    instance: &DiscoveredInstance,
    probe_id: &str,
    status: &str,
    reason: Option<&str>,
    serializer: &SerializerConfig,
    detail: Option<String>,
    probe_version: Option<u64>,
) -> anyhow::Result<()> {
    send_events(
        client,
        agent_id,
        instance,
        vec![NativeEvent::Status {
            probe_id: probe_id.into(),
            ts: runtime::timestamp(),
            status: status.into(),
            reason_code: reason.map(str::to_owned),
            agent_id: agent_id.into(),
            instance_id: instance.instance_id.clone(),
            build_id: instance.build_id.clone(),
            probe_version: probe_version.unwrap_or(1),
            site_id: None,
            physical_site_count: None,
            resolution: None,
            raw_hit_rate: None,
            dropped_event_count: None,
            detail: sanitize_diagnostic_detail(detail, serializer),
        }],
    )
}

#[allow(clippy::too_many_arguments)]
fn send_site_status(
    client: &BrokerClient,
    agent_id: &str,
    instance: &DiscoveredInstance,
    site: &PlannedSite,
    status: &str,
    reason: Option<&str>,
    serializer: &SerializerConfig,
    detail: Option<String>,
    physical_site_count: Option<u32>,
    raw_hit_rate: Option<f64>,
    dropped_event_count: Option<u64>,
) -> anyhow::Result<()> {
    send_events(
        client,
        agent_id,
        instance,
        vec![NativeEvent::Status {
            probe_id: site.probe.id.clone(),
            ts: runtime::timestamp(),
            status: status.into(),
            reason_code: reason.map(str::to_owned),
            agent_id: agent_id.into(),
            instance_id: instance.instance_id.clone(),
            build_id: instance.build_id.clone(),
            probe_version: site.probe.version,
            site_id: Some(site.site_id.clone()),
            physical_site_count,
            resolution: Some(ResolutionStatus {
                source_file: site.probe.file.clone(),
                line: site.probe.line,
                resolved_site_count: physical_site_count.unwrap_or(1),
                requested_path_count: u32::try_from(
                    site.slot_paths.len().saturating_add(site.unavailable.len()),
                )
                .unwrap_or(u32::MAX),
            }),
            raw_hit_rate,
            dropped_event_count,
            detail: sanitize_diagnostic_detail(detail, serializer),
        }],
    )
}

fn reason_from_error(error: &str) -> &'static str {
    [
        "no-debug-info",
        "no-line-info",
        "source-file-not-found",
        "source-file-ambiguous",
        "no-executable-address",
        "variable-not-found",
        "variable-optimized-out",
        "unsupported-location-expression",
        "unsupported-register-piece",
        "unsupported-type",
    ]
    .into_iter()
    .find(|reason| error.contains(reason))
    .unwrap_or("unsupported-location-expression")
}

fn permanent_reason_from_error(error: &str) -> Option<&'static str> {
    [
        "build-mismatch",
        "no-debug-info",
        "no-line-info",
        "source-file-not-found",
        "source-file-ambiguous",
        "no-executable-address",
        "variable-not-found",
        "variable-optimized-out",
        "unsupported-location-expression",
        "unsupported-register-piece",
        "unsupported-type",
    ]
    .into_iter()
    .find(|reason| error.contains(reason))
}

fn planning_error_should_retry(error: &str) -> bool {
    permanent_reason_from_error(error).is_none() || error.contains("no-debug-info")
}

fn assignment_logical_key(
    probe: &liveprobe_native_agent::broker::ProbeAssignment,
    instance: &DiscoveredInstance,
) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        instance.instance_id, instance.build_id, probe.id, probe.version
    )
}

fn logical_key(site: &PlannedSite, instance: &DiscoveredInstance) -> String {
    assignment_logical_key(&site.probe, instance)
}

fn unix_timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC3339 formatting cannot fail")
}

#[cfg(test)]
mod tests {
    use super::planning_error_should_retry;

    #[test]
    fn retries_missing_or_temporarily_unreadable_debug_artifacts() {
        assert!(planning_error_should_retry("no-debug-info"));
        assert!(planning_error_should_retry("temporary permission denied"));
        assert!(!planning_error_should_retry("source-file-ambiguous"));
        assert!(!planning_error_should_retry("unsupported-register-piece"));
    }
}
