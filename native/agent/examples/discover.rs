//! Print what the agent's process discovery finds, without contacting a broker
//! or loading any BPF.
//!
//! This is the cheapest way to answer "can the agent see my service?" — the
//! question that finding 2 of `docs/k8s-dogfood-findings.md` is about. It is
//! also how the container-awareness behaviour is verified: run it inside a
//! container that shares a PID namespace with the target and confirm that a
//! build ID is read even though the target's executable path does not exist in
//! this mount namespace.
//!
//! ```sh
//! discover '{"serviceId":"user-service","language":"cpp","cgroupPrefix":"/kubepods"}'
//! ```

use liveprobe_native_agent::{config::ServiceConfig, discovery, dwarf, symbols};
use std::{env, path::Path};

fn main() -> anyhow::Result<()> {
    let services = env::args()
        .skip(1)
        .take_while(|argument| argument.starts_with('{'))
        .map(|argument| serde_json::from_str::<ServiceConfig>(&argument))
        .collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        !services.is_empty(),
        "usage: discover '<service selector JSON>'... [SOURCE LINE]"
    );
    let probe: Vec<String> = env::args().skip(1).skip(services.len()).collect();

    let report = discovery::discover_with_known(Path::new("/proc"), &services, "now", &[])?;
    for issue in &report.issues {
        println!(
            "issue pid={} service={:?} reason={} detail={}",
            issue.pid, issue.service_id, issue.reason_code, issue.detail
        );
    }
    anyhow::ensure!(
        !report.instances.is_empty(),
        "no matching process found; check the selector and that the PID namespace is shared"
    );

    for instance in &report.instances {
        println!(
            "found service={} pid={} arch={} build-id={}",
            instance.service_id, instance.pid, instance.architecture, instance.build_id
        );
        // The distinction this example exists to demonstrate.
        println!(
            "  reported path (target's view): {}",
            instance.executable_path
        );
        println!(
            "  opened path   (agent's view):  {}",
            instance.open_path().display()
        );
        println!(
            "  debug search root:             {}",
            instance.debug_search_root().display()
        );
        println!(
            "  embedded DWARF:                {}",
            symbols::has_embedded_dwarf(instance.open_path())?
        );
        // Reading the reported path directly is what a namespace-unaware agent
        // would do. It succeeds for a host process and fails for a container,
        // which makes this line the quickest way to tell the two cases apart.
        match std::fs::metadata(&instance.executable_path) {
            Ok(_) => println!("  target namespace:              shared with agent (host process)"),
            Err(error) => println!(
                "  target namespace:              separate ({error}); reading via {}",
                instance.open_path().display()
            ),
        }

        let [source, line] = &probe[..] else { continue };
        let line: u64 = line.parse()?;
        match dwarf::resolve_line(instance.open_path(), source, line) {
            Ok(sites) => {
                for site in &sites {
                    println!(
                        "  resolved {}:{} -> address=0x{:x} offset=0x{:x}",
                        site.file,
                        site.line,
                        site.address,
                        symbols::executable_file_offset(instance.open_path(), site.address)?
                    );
                }
            }
            Err(error) => println!("  {source}:{line} unresolved: {error}"),
        }
    }
    Ok(())
}
