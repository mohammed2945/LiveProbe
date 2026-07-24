use crate::discovery::DiscoveredInstance;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct InstanceRegistry {
    instances: BTreeMap<String, DiscoveredInstance>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReconcileResult {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub replaced: Vec<String>,
}

impl InstanceRegistry {
    pub fn reconcile(&mut self, current: Vec<DiscoveredInstance>) -> ReconcileResult {
        let next: BTreeMap<_, _> = current
            .into_iter()
            .map(|item| (item.instance_id.clone(), item))
            .collect();
        let mut result = ReconcileResult {
            added: vec![],
            removed: vec![],
            replaced: vec![],
        };
        for (id, old) in &self.instances {
            match next.get(id) {
                None => result.removed.push(id.clone()),
                Some(new)
                    if old.pid == new.pid && old.process_start_time != new.process_start_time =>
                {
                    result.replaced.push(id.clone())
                }
                _ => {}
            }
        }
        for id in next.keys() {
            if !self.instances.contains_key(id) {
                result.added.push(id.clone());
            }
        }
        self.instances = next;
        result
    }

    pub fn values(&self) -> impl Iterator<Item = &DiscoveredInstance> {
        self.instances.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NativeLanguage;

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
            build_id: "abcd".into(),
            architecture: "x86_64".into(),
            cgroup: None,
            last_seen: "now".into(),
        }
    }

    #[test]
    fn detects_pid_reuse_and_process_exit() {
        let mut registry = InstanceRegistry::default();
        assert_eq!(
            registry
                .reconcile(vec![instance("stable", 42, "100")])
                .added,
            vec!["stable"]
        );
        assert_eq!(
            registry
                .reconcile(vec![instance("stable", 42, "200")])
                .replaced,
            vec!["stable"]
        );
        assert_eq!(registry.reconcile(vec![]).removed, vec!["stable"]);
    }
}
