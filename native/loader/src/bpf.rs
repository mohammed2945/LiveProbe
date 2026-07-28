use libbpf_rs::{
    Link, MapCore, MapFlags, Object, ObjectBuilder, RingBuffer, RingBufferBuilder, UprobeOpts,
};
use liveprobe_native_protocol::{
    ABI_VERSION, ApprovedProgram, AttachRequest, CaptureOp, CapturePlan, MAX_CAPTURE_OPS,
    MAX_EVENT_BATCH,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

const APPROVED_BPF_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/liveprobe.bpf.o"));
const APPROVED_BPF_SHA256: &str = env!("LIVEPROBE_APPROVED_BPF_SHA256");

pub struct BpfManager {
    object: Object,
    links: HashMap<String, (Link, u64)>,
    ring: RingBuffer<'static>,
    queued_events: Arc<Mutex<VecDeque<Vec<u8>>>>,
}
#[repr(C)]
struct ProbeState {
    generation: u32,
    disabled: u32,
    captures: u64,
    accepted_raw_hits: u64,
}
impl BpfManager {
    pub fn approved_object_digest() -> &'static str {
        APPROVED_BPF_SHA256
    }
    pub fn verify_approved_integrity() -> anyhow::Result<()> {
        validate_approved_object(APPROVED_BPF_BYTES)
    }
    pub fn load_approved() -> anyhow::Result<Self> {
        Self::verify_approved_integrity()?;
        let object = ObjectBuilder::default()
            .open_memory(APPROVED_BPF_BYTES)?
            .load()?;
        let queued_events = Arc::new(Mutex::new(VecDeque::new()));
        let queue = Arc::clone(&queued_events);
        let mut builder = RingBufferBuilder::new();
        let events = object
            .maps()
            .find(|map| map.name().to_string_lossy() == "events")
            .ok_or_else(|| anyhow::anyhow!("events ring buffer missing"))?;
        builder.add(&events, move |record| {
            if let Ok(mut queue) = queue.lock() {
                if queue.len() < 1024 {
                    queue.push_back(record.to_vec());
                }
            }
            0
        })?;
        let ring = builder.build()?;
        Ok(Self {
            object,
            links: HashMap::new(),
            ring,
            queued_events,
        })
    }
    pub fn attach(&mut self, request: &AttachRequest) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.links.contains_key(&request.site_id),
            "site is already attached"
        );
        let plan = capture_plan(request)?;
        let key = request.cookie.to_ne_bytes();
        let bytes = unsafe {
            std::slice::from_raw_parts(
                (&plan as *const CapturePlan).cast::<u8>(),
                size_of::<CapturePlan>(),
            )
        };
        self.object
            .maps_mut()
            .find(|map| map.name().to_string_lossy() == "probe_plans")
            .ok_or_else(|| anyhow::anyhow!("probe_plans map missing"))?
            .update(&key, bytes, MapFlags::ANY)?;
        let attach_result = (|| -> anyhow::Result<Link> {
            let state = ProbeState {
                generation: plan.generation,
                disabled: 0,
                captures: 0,
                accepted_raw_hits: 0,
            };
            let state_bytes = unsafe {
                std::slice::from_raw_parts(
                    (&state as *const ProbeState).cast::<u8>(),
                    size_of::<ProbeState>(),
                )
            };
            self.object
                .maps_mut()
                .find(|map| map.name().to_string_lossy() == "probe_state")
                .ok_or_else(|| anyhow::anyhow!("probe_state map missing"))?
                .update(&key, state_bytes, MapFlags::ANY)?;
            let program_name = match request.program {
                ApprovedProgram::CountOnly => "liveprobe_count",
                ApprovedProgram::ScalarSnapshot => "liveprobe_snapshot",
            };
            let program = self
                .object
                .progs_mut()
                .find(|program| program.name().to_string_lossy() == program_name)
                .ok_or_else(|| anyhow::anyhow!("approved program missing"))?;
            let opts = UprobeOpts {
                func_name: None,
                retprobe: false,
                cookie: request.cookie,
                ..Default::default()
            };
            let offset = usize::try_from(request.offset)?;
            Ok(program.attach_uprobe_with_opts(
                request.target.pid as i32,
                &request.target.executable_path,
                offset,
                opts,
            )?)
        })();
        let link = match attach_result {
            Ok(link) => link,
            Err(error) => {
                self.cleanup_cookie(request.cookie);
                return Err(error);
            }
        };
        self.links
            .insert(request.site_id.clone(), (link, request.cookie));
        Ok(())
    }
    pub fn detach(&mut self, site_id: &str) -> bool {
        let Some((_link, cookie)) = self.links.remove(site_id) else {
            return false;
        };
        self.cleanup_cookie(cookie);
        true
    }
    fn cleanup_cookie(&mut self, cookie: u64) {
        let key = cookie.to_ne_bytes();
        for name in [
            "probe_plans",
            "probe_state",
            "raw_hit_counters",
            "capture_counters",
            "rate_limit_state",
            "dropped_event_counters",
            "counter_aggregates",
        ] {
            if let Some(map) = self
                .object
                .maps_mut()
                .find(|map| map.name().to_string_lossy() == name)
            {
                let _ = map.delete(&key);
            }
        }
    }
    pub fn detach_all(&mut self) {
        let sites = self.links.keys().cloned().collect::<Vec<_>>();
        for site in sites {
            self.detach(&site);
        }
    }
    pub fn poll_events(
        &mut self,
        timeout_millis: u32,
        max_events: u16,
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        anyhow::ensure!(
            timeout_millis <= 5_000 && max_events > 0 && max_events <= MAX_EVENT_BATCH,
            "bounded poll parameters required"
        );
        self.ring
            .poll(Duration::from_millis(u64::from(timeout_millis)))?;
        let mut queue = self
            .queued_events
            .lock()
            .map_err(|_| anyhow::anyhow!("event queue lock poisoned"))?;
        Ok((0..max_events).filter_map(|_| queue.pop_front()).collect())
    }
    pub fn counters(&self, cookie: u64) -> anyhow::Result<(u64, u64, u64)> {
        fn sum(map: &dyn MapCore, key: &[u8]) -> anyhow::Result<u64> {
            Ok(map
                .lookup_percpu(key, MapFlags::ANY)?
                .unwrap_or_default()
                .iter()
                .filter_map(|value| value.get(..8))
                .map(|bytes| u64::from_ne_bytes(bytes.try_into().expect("8 bytes")))
                .sum())
        }
        let key = cookie.to_ne_bytes();
        let raw = self
            .object
            .maps()
            .find(|map| map.name().to_string_lossy() == "raw_hit_counters")
            .ok_or_else(|| anyhow::anyhow!("raw counter map missing"))?;
        let capture = self
            .object
            .maps()
            .find(|map| map.name().to_string_lossy() == "capture_counters")
            .ok_or_else(|| anyhow::anyhow!("capture counter map missing"))?;
        let dropped = self
            .object
            .maps()
            .find(|map| map.name().to_string_lossy() == "dropped_event_counters")
            .ok_or_else(|| anyhow::anyhow!("drop counter map missing"))?;
        Ok((sum(&raw, &key)?, sum(&capture, &key)?, sum(&dropped, &key)?))
    }
}

fn validate_approved_object(bytes: &[u8]) -> anyhow::Result<()> {
    anyhow::ensure!(
        bytes.starts_with(b"\x7fELF"),
        "approved BPF data is not ELF"
    );
    let actual = format!("{:x}", Sha256::digest(bytes));
    anyhow::ensure!(
        actual == APPROVED_BPF_SHA256,
        "approved BPF data failed embedded digest validation"
    );
    Ok(())
}

#[cfg(test)]
mod integrity_tests {
    use super::*;

    #[test]
    fn embedded_object_matches_build_approval() {
        validate_approved_object(APPROVED_BPF_BYTES).unwrap();
        assert_eq!(BpfManager::approved_object_digest().len(), 64);
    }

    #[test]
    fn tampered_object_is_rejected() {
        let mut tampered = APPROVED_BPF_BYTES.to_vec();
        let index = tampered.len() / 2;
        tampered[index] ^= 1;
        assert!(validate_approved_object(&tampered).is_err());
    }
}

fn capture_plan(request: &AttachRequest) -> anyhow::Result<CapturePlan> {
    anyhow::ensure!(
        request.plan.len() <= MAX_CAPTURE_OPS,
        "capture plan operation limit"
    );
    let mut plan = CapturePlan {
        pid: request.target.pid,
        generation: request.generation,
        hit_limit: request.hit_limit,
        refill_per_second: request.refill_per_second,
        burst: request.burst,
        sample_every: request.sample_every,
        cgroup_id: request.cgroup_id,
        operation_count: request.plan.len() as u8,
        slot_count: request
            .plan
            .iter()
            .map(|op| op.destination_slot)
            .max()
            .map_or(0, |slot| slot + 1),
        ..CapturePlan::default()
    };
    anyhow::ensure!(
        plan.hit_limit > 0 && plan.refill_per_second > 0 && plan.burst > 0 && plan.sample_every > 0,
        "invalid safety limits"
    );
    for (destination, source) in plan.operations.iter_mut().zip(&request.plan) {
        *destination = CaptureOp {
            code: source.code as u8,
            register: source.register,
            width: source.width,
            destination_slot: source.destination_slot,
            offset: source.offset,
            reserved: 0,
        };
    }
    anyhow::ensure!(plan.abi_version == ABI_VERSION, "capture plan ABI");
    Ok(plan)
}
