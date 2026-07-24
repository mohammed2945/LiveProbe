use object::{Object, ObjectSegment};
use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub fn build_id(path: &Path) -> anyhow::Result<Option<String>> {
    let data = fs::read(path)?;
    let file = object::File::parse(data.as_slice())?;
    Ok(file.build_id()?.map(hex::encode))
}

pub fn architecture(path: &Path) -> anyhow::Result<String> {
    let data = fs::read(path)?;
    let file = object::File::parse(data.as_slice())?;
    Ok(match file.architecture() {
        object::Architecture::X86_64 => "x86_64",
        object::Architecture::Aarch64 => "aarch64",
        other => anyhow::bail!("unsupported architecture {other:?}"),
    }
    .to_owned())
}

pub fn executable_file_offset(path: &Path, address: u64) -> anyhow::Result<u64> {
    let data = fs::read(path)?;
    let file = object::File::parse(data.as_slice())?;
    for segment in file.segments() {
        let start = segment.address();
        let size = segment.size();
        if address >= start && address < start.saturating_add(size) {
            let (file_offset, file_size) = segment.file_range();
            let delta = address - start;
            anyhow::ensure!(
                delta < file_size,
                "no-executable-address: address is not file-backed"
            );
            return Ok(file_offset + delta);
        }
    }
    anyhow::bail!("no-executable-address: address is outside load segments")
}

pub fn has_embedded_dwarf(path: &Path) -> anyhow::Result<bool> {
    let data = fs::read(path)?;
    let file = object::File::parse(data.as_slice())?;
    Ok(file.section_by_name(".debug_info").is_some())
}

pub fn find_debug_artifact(
    executable: &Path,
    symbol_dirs: &[PathBuf],
) -> anyhow::Result<Option<PathBuf>> {
    if has_embedded_dwarf(executable)? {
        return Ok(Some(executable.to_owned()));
    }
    let data = fs::read(executable)?;
    let file = object::File::parse(data.as_slice())?;
    let executable_build_id = file.build_id()?;
    if let Some((name, crc)) = file.gnu_debuglink()? {
        let name = String::from_utf8_lossy(name);
        let debuglink_path = Path::new(name.as_ref());
        anyhow::ensure!(
            !debuglink_path.is_absolute()
                && debuglink_path
                    .parent()
                    .is_none_or(|parent| parent.as_os_str().is_empty()),
            "no-debug-info: invalid GNU debuglink filename"
        );
        for candidate in [
            executable
                .parent()
                .unwrap_or(Path::new("."))
                .join(name.as_ref()),
            executable
                .parent()
                .unwrap_or(Path::new("."))
                .join(".debug")
                .join(name.as_ref()),
        ] {
            if candidate.is_file()
                && debug_artifact_is_valid(&candidate, Some(crc), executable_build_id)?
            {
                return Ok(Some(candidate));
            }
        }
    }
    if let Some(id) = executable_build_id {
        let hex = hex::encode(id);
        anyhow::ensure!(hex.len() >= 3, "no-debug-info: invalid ELF build ID");
        for root in symbol_dirs {
            let candidate = root
                .join(".build-id")
                .join(&hex[..2])
                .join(format!("{}.debug", &hex[2..]));
            if candidate.is_file() && debug_artifact_is_valid(&candidate, None, Some(id))? {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

fn debug_artifact_is_valid(
    candidate: &Path,
    expected_crc: Option<u32>,
    executable_build_id: Option<&[u8]>,
) -> std::io::Result<bool> {
    let bytes = fs::read(candidate)?;
    if expected_crc.is_some_and(|expected| gnu_debuglink_crc32(&bytes) != expected) {
        return Ok(false);
    }
    let Ok(file) = object::File::parse(bytes.as_slice()) else {
        return Ok(false);
    };
    if file.section_by_name(".debug_info").is_none() {
        return Ok(false);
    }
    let Ok(candidate_build_id) = file.build_id() else {
        return Ok(false);
    };
    if let (Some(expected), Some(actual)) = (executable_build_id, candidate_build_id) {
        if expected != actual {
            return Ok(false);
        }
    }
    Ok(true)
}

fn gnu_debuglink_crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, entry) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(value & 1);
            value = (value >> 1) ^ (0xedb8_8320 & mask);
        }
        *entry = value;
    }
    let mut crc = u32::MAX;
    for byte in bytes {
        crc = table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

pub fn find_or_fetch_debug_artifact(
    executable: &Path,
    symbol_dirs: &[PathBuf],
    debuginfod_url: Option<&str>,
    cache_directory: Option<&Path>,
) -> anyhow::Result<Option<PathBuf>> {
    if let Some(local) = find_debug_artifact(executable, symbol_dirs)? {
        return Ok(Some(local));
    }
    let (Some(base_url), Some(cache_directory), Some(id)) =
        (debuginfod_url, cache_directory, build_id(executable)?)
    else {
        return Ok(None);
    };
    anyhow::ensure!(id.len() >= 3, "invalid ELF build ID");
    anyhow::ensure!(
        base_url.starts_with("https://") || base_url.starts_with("http://"),
        "debuginfod URL must be HTTP(S)"
    );
    let destination = cache_directory
        .join(".build-id")
        .join(&id[..2])
        .join(format!("{}.debug", &id[2..]));
    if destination.is_file()
        && has_embedded_dwarf(&destination)?
        && build_id(&destination)?.as_deref() == Some(&id)
    {
        return Ok(Some(destination));
    }
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .new_agent();
    let mut response = agent
        .get(format!(
            "{}/buildid/{id}/debuginfo",
            base_url.trim_end_matches('/')
        ))
        .call()?;
    let bytes = response
        .body_mut()
        .with_config()
        .limit(512 * 1024 * 1024)
        .read_to_vec()?;
    let downloaded = object::File::parse(bytes.as_slice())?;
    anyhow::ensure!(
        downloaded.build_id()?.map(hex::encode).as_deref() == Some(&id),
        "build-mismatch: debuginfod artifact build ID differs"
    );
    anyhow::ensure!(
        downloaded.section_by_name(".debug_info").is_some(),
        "no-debug-info: debuginfod artifact has no DWARF"
    );
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow::anyhow!("invalid symbol cache path"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp-{}", &id[2..], std::process::id()));
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &destination)?;
    Ok(Some(destination))
}

pub fn section_data<'a>(file: &'a object::File<'a>, name: &str) -> Cow<'a, [u8]> {
    use object::ObjectSection;
    file.section_by_name(name)
        .and_then(|section| section.uncompressed_data().ok())
        .unwrap_or(Cow::Borrowed(&[]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use object::ObjectSection;
    use std::process::Command;

    #[test]
    fn extracts_build_id_and_translates_load_address() {
        let executable = std::env::current_exe().unwrap();
        assert!(build_id(&executable).unwrap().is_some());
        let data = fs::read(&executable).unwrap();
        let file = object::File::parse(data.as_slice()).unwrap();
        let segment = file
            .segments()
            .find(|segment| segment.file_range().1 > 0)
            .expect("file-backed load segment");
        assert_eq!(
            executable_file_offset(&executable, segment.address()).unwrap(),
            segment.file_range().0
        );
    }

    fn debug_fixture() -> (tempfile::TempDir, PathBuf, Vec<u8>, Vec<u8>) {
        let directory = tempfile::tempdir().unwrap();
        let source = std::env::current_exe().unwrap();
        let bytes = fs::read(&source).unwrap();
        let file = object::File::parse(bytes.as_slice()).unwrap();
        assert!(file.section_by_name(".debug_info").is_some());
        let build_id = file.build_id().unwrap().unwrap().to_vec();
        let candidate = directory.path().join("application.debug");
        fs::write(&candidate, &bytes).unwrap();
        (directory, candidate, bytes, build_id)
    }

    #[test]
    fn validates_debuglink_filename_crc_and_build_identity() {
        assert_eq!(gnu_debuglink_crc32(b"123456789"), 0xcbf4_3926);
        let (_directory, candidate, bytes, build_id) = debug_fixture();
        let crc = gnu_debuglink_crc32(&bytes);
        assert_eq!(candidate.file_name().unwrap(), "application.debug");
        assert!(debug_artifact_is_valid(&candidate, Some(crc), Some(&build_id)).unwrap());
        assert!(!debug_artifact_is_valid(&candidate, Some(crc ^ 1), Some(&build_id)).unwrap());
    }

    #[test]
    fn rejects_truncated_unrelated_and_build_mismatched_artifacts() {
        let (directory, candidate, bytes, build_id) = debug_fixture();
        let truncated = directory.path().join("truncated.debug");
        fs::write(&truncated, &bytes[..32]).unwrap();
        assert!(
            !debug_artifact_is_valid(
                &truncated,
                Some(gnu_debuglink_crc32(&bytes[..32])),
                Some(&build_id)
            )
            .unwrap()
        );

        let unrelated = Path::new("/bin/true");
        let unrelated_bytes = fs::read(unrelated).unwrap();
        assert!(
            !debug_artifact_is_valid(
                unrelated,
                Some(gnu_debuglink_crc32(&unrelated_bytes)),
                Some(&build_id)
            )
            .unwrap()
        );

        let file = object::File::parse(bytes.as_slice()).unwrap();
        let note = file.section_by_name(".note.gnu.build-id").unwrap();
        let (offset, size) = note.file_range().unwrap();
        let mut mismatched = bytes.clone();
        let range = offset as usize..(offset + size) as usize;
        let position = mismatched[range.clone()]
            .windows(build_id.len())
            .position(|window| window == build_id)
            .expect("build ID bytes in note");
        mismatched[range.start + position] ^= 1;
        let mismatch_path = directory.path().join("mismatch.debug");
        fs::write(&mismatch_path, &mismatched).unwrap();
        assert!(
            !debug_artifact_is_valid(
                &mismatch_path,
                Some(gnu_debuglink_crc32(&mismatched)),
                Some(&build_id)
            )
            .unwrap()
        );

        // An invalid debuglink candidate does not prevent trying a later,
        // independently valid build-ID symbol source.
        assert!(
            !debug_artifact_is_valid(&truncated, None, Some(&build_id)).unwrap()
                && debug_artifact_is_valid(&candidate, None, Some(&build_id)).unwrap()
        );
    }

    #[test]
    fn find_debug_artifact_validates_crc_and_falls_back_to_build_id_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("fixture.c");
        let executable = directory.path().join("fixture");
        let debug = directory.path().join("fixture.debug");
        fs::write(&source, "int main(void) { return 0; }\n").unwrap();
        assert!(
            Command::new("cc")
                .args(["-g", "-Wl,--build-id=sha1"])
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("objcopy")
                .arg("--only-keep-debug")
                .arg(&executable)
                .arg(&debug)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("objcopy")
                .current_dir(directory.path())
                .args(["--strip-debug", "--add-gnu-debuglink=fixture.debug"])
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );

        assert_eq!(
            find_debug_artifact(&executable, &[]).unwrap(),
            Some(debug.clone())
        );
        let valid_debug = fs::read(&debug).unwrap();
        fs::write(&debug, [valid_debug.as_slice(), b"stale"].concat()).unwrap();
        assert_eq!(find_debug_artifact(&executable, &[]).unwrap(), None);

        let id = build_id(&executable).unwrap().unwrap();
        let symbols = directory.path().join("symbols");
        let fallback = symbols
            .join(".build-id")
            .join(&id[..2])
            .join(format!("{}.debug", &id[2..]));
        fs::create_dir_all(fallback.parent().unwrap()).unwrap();
        fs::write(&fallback, valid_debug).unwrap();
        assert_eq!(
            find_debug_artifact(&executable, &[symbols]).unwrap(),
            Some(fallback)
        );
    }
}
