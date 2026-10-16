use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Error, ErrorKind, Read};
use std::path::Path;

mod format {
    include!(concat!(env!("OUT_DIR"), "/v2_generated.rs"));
}

fn collect(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
    visited: &mut usize,
) -> Result<(), Box<dyn std::error::Error>> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path.strip_prefix(root)?;
        *visited += 1;
        if relative.components().count() > 16 || *visited > 256 {
            return Err(
                Error::new(ErrorKind::InvalidInput, "Notice tree exceeds its limits").into(),
            );
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect(root, &path, files, total, visited)?;
        } else if kind.is_file() {
            let remaining = 4_194_304usize.saturating_sub(*total);
            let mut bytes = Vec::new();
            std::fs::File::open(&path)?
                .take(u64::try_from(remaining)? + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > remaining {
                return Err(Error::new(ErrorKind::InvalidInput, "Notices exceed 4 MiB").into());
            }
            let name = relative
                .to_str()
                .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Notice path is not UTF-8"))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            *total += bytes.len();
            files.insert(format!("share/boxes-sh/{name}"), bytes);
        } else {
            return Err(
                Error::new(ErrorKind::InvalidInput, "Notices require regular files").into(),
            );
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "usage: boxes-guest-pack <sh.wasm> <notices-directory> <output.aospkg>",
        )
        .into());
    }
    let limit: usize =
        serde_json::from_slice(include_bytes!("../../../src/wasm-module-bytes.json"))?;
    let mut binary = Vec::new();
    std::fs::File::open(&args[0])?
        .take(u64::try_from(limit)? + 1)
        .read_to_end(&mut binary)?;
    if binary.len() > limit || !binary.starts_with(b"\0asm\x01\0\0\0") {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "Shell requires a Wasm v1 binary within the module byte limit",
        )
        .into());
    }
    let shell_hash = format!("{:x}", Sha256::digest(&binary));
    let mut files = BTreeMap::from([("bin/sh".to_string(), binary)]);
    let notices = Path::new(&args[1]);
    let mut notice_bytes = 0;
    let mut visited = 0;
    collect(
        notices,
        notices,
        &mut files,
        &mut notice_bytes,
        &mut visited,
    )?;
    if !files.contains_key("share/boxes-sh/NOTICE") {
        return Err(Error::new(ErrorKind::InvalidInput, "A guest NOTICE file is required").into());
    }
    let mut directories = BTreeSet::new();
    for file in files.keys() {
        let mut parent = Path::new(file).parent();
        while let Some(path) = parent.filter(|path| !path.as_os_str().is_empty()) {
            directories.insert(path.to_string_lossy().into_owned());
            parent = path.parent();
        }
    }
    let mut archive = tar::Builder::new(Vec::new());
    let mut entries = Vec::new();
    for directory in directories {
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o555);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        archive.append_data(&mut header, &directory, std::io::empty())?;
        entries.push(format::TarEntry {
            path: format!("/{directory}"),
            kind: format::TarEntryKind::Directory,
            offset: 0,
            size: 0,
            mode: 0o40555,
            uid: 0,
            gid: 0,
            mtime: 0,
            link_target: None,
        });
    }
    for (path, bytes) in files {
        let mode = if path == "bin/sh" { 0o555 } else { 0o444 };
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(u64::try_from(bytes.len())?);
        header.set_mode(mode);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        archive.append_data(&mut header, &path, bytes.as_slice())?;
        let offset = archive.get_ref().len() - bytes.len().div_ceil(512) * 512;
        entries.push(format::TarEntry {
            path: format!("/{path}"),
            kind: format::TarEntryKind::File,
            offset: u64::try_from(offset)?,
            size: u64::try_from(bytes.len())?,
            mode: 0o100000 | mode,
            uid: 0,
            gid: 0,
            mtime: 0,
            link_target: None,
        });
    }
    let tar = archive.into_inner()?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let project: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../package.json"))?;
    let version = project["version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Project version is required"))?;
    let manifest = format::PackageManifest {
        name: "sh".into(),
        version: version.into(),
        provides: None,
        commands: vec![format::CommandTarget {
            command: "sh".into(),
            entry: "bin/sh".into(),
        }],
        man_pages: Vec::new(),
    };
    let mut manifest_bytes = 2u16.to_le_bytes().to_vec();
    manifest_bytes.extend(serde_bare::to_vec(&manifest)?);
    let mut index = 2u16.to_le_bytes().to_vec();
    index.extend(serde_bare::to_vec(&format::MountIndex {
        tar_entries: entries,
    })?);
    let mut package = b"\x89AOS\x02\0\0\0".to_vec();
    package.extend(u32::try_from(manifest_bytes.len())?.to_le_bytes());
    package.extend(u32::try_from(index.len())?.to_le_bytes());
    package.extend(manifest_bytes);
    package.extend(index);
    package.extend(tar);
    std::fs::write(&args[2], &package)?;
    println!(
        "{}",
        serde_json::json!({
            "name": manifest.name,
            "version": manifest.version,
            "bytes": package.len(),
            "sha256": format!("{:x}", Sha256::digest(&package)),
            "shellSha256": shell_hash,
            "noticeBytes": notice_bytes,
        })
    );
    Ok(())
}
