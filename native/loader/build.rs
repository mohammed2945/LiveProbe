use object::{Object, ObjectSection, SectionKind};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let object = manifest.join("../bpf/liveprobe.bpf.o");
    let source = manifest.join("../bpf/src/liveprobe.bpf.c");
    println!("cargo:rerun-if-changed={}", object.display());
    println!("cargo:rerun-if-changed={}", source.display());
    let source_bytes = fs::read(&source)
        .unwrap_or_else(|error| panic!("cannot audit {}: {error}", source.display()));
    assert!(
        !source_bytes
            .windows(b"bpf_probe_write_user".len())
            .any(|window| window == b"bpf_probe_write_user"),
        "approved BPF source references forbidden bpf_probe_write_user"
    );
    let bytes = fs::read(&object).unwrap_or_else(|error| {
        panic!(
            "approved BPF object {} is required; run `make -C native/bpf audit` first: {error}",
            object.display()
        )
    });
    assert!(
        bytes.starts_with(b"\x7fELF"),
        "approved BPF object is not an ELF file"
    );
    audit_forbidden_helpers(&bytes);
    let digest = Sha256::digest(&bytes);
    println!("cargo:rustc-env=LIVEPROBE_APPROVED_BPF_SHA256={digest:x}");
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
