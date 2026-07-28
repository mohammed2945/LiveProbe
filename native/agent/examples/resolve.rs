use liveprobe_native_agent::{dwarf, symbols};
use std::{env, path::Path};

fn main() -> anyhow::Result<()> {
    let executable = env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("usage: resolve EXECUTABLE SOURCE LINE WATCH..."))?;
    let source = env::args()
        .nth(2)
        .ok_or_else(|| anyhow::anyhow!("missing source"))?;
    let line: u64 = env::args()
        .nth(3)
        .ok_or_else(|| anyhow::anyhow!("missing line"))?
        .parse()?;
    let sites = dwarf::resolve_line(Path::new(&executable), &source, line)?;
    for site in &sites {
        println!(
            "site address=0x{:x} offset=0x{:x} {}:{}",
            site.address,
            symbols::executable_file_offset(Path::new(&executable), site.address)?,
            site.file,
            site.line
        );
        for watch in env::args().skip(4) {
            match dwarf::resolve_variable(Path::new(&executable), site.address, &watch) {
                Ok(plan) => println!(
                    "watch {watch}: width={} operations={:?}",
                    plan.byte_width, plan.operations
                ),
                Err(error) => println!("watch {watch}: unavailable={error}"),
            }
        }
    }
    Ok(())
}
