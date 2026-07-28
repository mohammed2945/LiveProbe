use object::{Object, ObjectSection, SectionKind};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let bpf_dir = manifest.join("../bpf");
    let source = manifest.join("../bpf/src/liveprobe.bpf.c");
    let header = manifest.join("../bpf/include/liveprobe.h");
    let object =
        PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR")).join("liveprobe.bpf.o");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", header.display());
    println!("cargo:rerun-if-env-changed=CLANG");
    println!("cargo:rerun-if-env-changed=LIVEPROBE_BPF_MULTIARCH");
    audit_source(&source);
    audit_source(&header);
    compile_bpf(&bpf_dir, &source, &object);
    let bytes = fs::read(&object)
        .unwrap_or_else(|error| panic!("cannot read generated {}: {error}", object.display()));
    assert!(
        bytes.starts_with(b"\x7fELF"),
        "approved BPF object is not an ELF file"
    );
    audit_forbidden_helpers(&bytes);
    let digest = Sha256::digest(&bytes);
    println!("cargo:rustc-env=LIVEPROBE_APPROVED_BPF_SHA256={digest:x}");
}

fn audit_source(path: &Path) {
    let bytes =
        fs::read(path).unwrap_or_else(|error| panic!("cannot audit {}: {error}", path.display()));
    assert!(
        !bytes
            .windows(b"bpf_probe_write_user".len())
            .any(|window| window == b"bpf_probe_write_user"),
        "approved BPF source {} references forbidden bpf_probe_write_user",
        path.display()
    );
}

fn compile_bpf(bpf_dir: &Path, source: &Path, object: &Path) {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    assert!(
        target_os == "linux" && target_arch == "x86_64",
        "the native eBPF loader currently supports only Linux x86-64 targets"
    );
    let clang = env::var_os("CLANG").unwrap_or_else(|| "clang".into());
    let multiarch = env::var_os("LIVEPROBE_BPF_MULTIARCH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/include/x86_64-linux-gnu"));
    let output = Command::new(&clang)
        .args(["-O2", "-g", "-target", "bpf", "-D__TARGET_ARCH_x86"])
        .args(["-Wall", "-Werror", "-c"])
        .arg(source)
        .arg("-I")
        .arg(bpf_dir.join("include"))
        .arg("-I")
        .arg(&multiarch)
        .arg("-o")
        .arg(object)
        .output()
        .unwrap_or_else(|error| panic!("cannot run {:?}: {error}", clang));
    assert!(
        output.status.success(),
        "failed to compile approved BPF object with {:?}:\n{}{}",
        clang,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn audit_forbidden_helpers(bytes: &[u8]) {
    let file = object::File::parse(bytes)
        .unwrap_or_else(|error| panic!("approved BPF object cannot be parsed: {error}"));
    let mut audited_instructions = 0usize;
    for section in file
        .sections()
        .filter(|section| section.kind() == SectionKind::Text)
    {
        let data = section
            .data()
            .unwrap_or_else(|error| panic!("cannot read BPF text section: {error}"));
        assert_eq!(
            data.len() % 8,
            0,
            "BPF text section has a partial instruction"
        );
        for instruction in data.chunks_exact(8) {
            audited_instructions += 1;
            let immediate = if file.is_little_endian() {
                i32::from_le_bytes(instruction[4..8].try_into().expect("BPF immediate"))
            } else {
                i32::from_be_bytes(instruction[4..8].try_into().expect("BPF immediate"))
            };
            assert!(
                instruction[0] != 0x85 || immediate != 36,
                "approved BPF object calls forbidden helper 36 (bpf_probe_write_user)"
            );
        }
    }
    assert!(
        audited_instructions > 0,
        "approved BPF object contains no auditable text instructions"
    );
}
