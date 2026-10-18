use super::Kernel;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

fn interpreter_arguments(bytes: &[u8]) -> Result<Vec<&str>, String> {
    if !bytes.starts_with(b"#!") {
        return Err(
            "UNSUPPORTED_RUNTIME: executable requires WASI or a shebang interpreter".into(),
        );
    }
    let end = bytes.iter().take(256).position(|byte| *byte == b'\n');
    let end = match end {
        Some(end) => end,
        None if bytes.len() < 256 => bytes.len(),
        None => return Err("ENOEXEC: interpreter header exceeds 255 bytes".into()),
    };
    let header = std::str::from_utf8(&bytes[2..end])
        .map_err(|_| "EILSEQ: interpreter header must be UTF-8".to_string())?;
    if header.contains('\0') {
        return Err("ENOEXEC: interpreter header contains NUL".into());
    }
    let header = header.trim_matches([' ', '\t']);
    if header.is_empty() {
        return Err("ENOEXEC: interpreter path is empty".into());
    }
    match header.find([' ', '\t']) {
        Some(index) => {
            let argument = header[index..].trim_matches([' ', '\t']);
            if argument.is_empty() {
                Ok(vec![&header[..index]])
            } else {
                Ok(vec![&header[..index], argument])
            }
        }
        None => Ok(vec![header]),
    }
}

mod format {
    include!(concat!(env!("OUT_DIR"), "/v2_generated.rs"));
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installed {
    pub package_id: String,
    pub digest: String,
    pub size_bytes: usize,
    #[serde(serialize_with = "serialize_manifest")]
    pub manifest: format::PackageManifest,
}

fn serialize_manifest<S: serde::Serializer>(
    manifest: &format::PackageManifest,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serde_json::to_value(manifest)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Link {
    pub package_id: String,
    pub command: String,
}

pub fn root(package: &Installed) -> Result<String, String> {
    if !segment(&package.manifest.name)
        || !segment(&package.manifest.version)
        || format!("sha256:{}", package.package_id) != package.digest
        || package.package_id.len() != 64
        || !package
            .package_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("EINVAL: invalid installed package identity".into());
    }
    Ok(format!(
        "/opt/cirro/pkgs/{}/{}",
        package.manifest.name, package.manifest.version
    ))
}

fn parse_bounded(
    bytes: &[u8],
    limit: usize,
) -> Result<(Installed, format::MountIndex, usize), String> {
    if bytes.len() < 16 || bytes.len() > limit || bytes[..8] != [0x89, b'A', b'O', b'S', 2, 0, 0, 0]
    {
        return Err("EINVAL: invalid package header or size".into());
    }
    let manifest_length = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| "EINVAL: invalid package manifest length")?,
    ) as usize;
    let index_length = u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|_| "EINVAL: invalid package index length")?,
    ) as usize;
    if manifest_length > 1_048_576 || index_length > 2_097_152 {
        return Err("EFBIG: package metadata exceeds its quota".into());
    }
    let index_start = 16usize
        .checked_add(manifest_length)
        .ok_or("EINVAL: package manifest overflow")?;
    let mount_start = index_start
        .checked_add(index_length)
        .ok_or("EINVAL: package index overflow")?;
    let manifest_bytes = bytes
        .get(16..index_start)
        .ok_or("EINVAL: truncated package manifest")?;
    let index_bytes = bytes
        .get(index_start..mount_start)
        .ok_or("EINVAL: truncated package index")?;
    if manifest_bytes.get(..2) != Some(&[2, 0]) || index_bytes.get(..2) != Some(&[2, 0]) {
        return Err("EINVAL: unsupported package schema version".into());
    }
    let mut manifest_reader = std::io::Cursor::new(&manifest_bytes[2..]);
    let manifest: format::PackageManifest = serde_bare::from_reader(&mut manifest_reader)
        .map_err(|_| "EINVAL: invalid package manifest")?;
    if manifest_reader.position() != (manifest_bytes.len() - 2) as u64
        || serde_bare::to_vec(&manifest)
            .map_err(|_| "EIO: package manifest encoding failed")?
            .len()
            != manifest_bytes.len() - 2
    {
        return Err("EINVAL: noncanonical package manifest or trailing bytes".into());
    }
    let mut index_reader = std::io::Cursor::new(&index_bytes[2..]);
    let index: format::MountIndex =
        serde_bare::from_reader(&mut index_reader).map_err(|_| "EINVAL: invalid package index")?;
    if index_reader.position() != (index_bytes.len() - 2) as u64
        || serde_bare::to_vec(&index)
            .map_err(|_| "EIO: package index encoding failed")?
            .len()
            != index_bytes.len() - 2
    {
        return Err("EINVAL: noncanonical package index or trailing bytes".into());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    Ok((
        Installed {
            package_id: digest.clone(),
            digest: format!("sha256:{digest}"),
            size_bytes: bytes.len(),
            manifest,
        },
        index,
        mount_start,
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub hash: String,
    pub offset: usize,
    pub length: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub node: super::Node,
    pub uid: u32,
    pub gid: u32,
    pub mtime_ns: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preparation {
    pub installed: Installed,
    pub root: String,
    pub entries: Vec<Entry>,
    pub blocks: Vec<Block>,
}

fn command_name(value: &str) -> bool {
    value == "[" || segment(value)
}

fn segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
}

pub fn prepare(bytes: &[u8]) -> Result<Preparation, String> {
    prepare_bounded(bytes, 16_777_216, super::MAX_TOTAL)
}

fn prepare_bounded(
    bytes: &[u8],
    package_limit: usize,
    logical_limit: u64,
) -> Result<Preparation, String> {
    let (installed, index, mount_start) = parse_bounded(bytes, package_limit)?;
    let manifest = &installed.manifest;
    if !segment(&manifest.name)
        || !segment(&manifest.version)
        || manifest.commands.len() > 128
        || manifest.man_pages.len() > 128
        || index.tar_entries.len() > 8192
    {
        return Err("EINVAL: invalid package identity or inventory".into());
    }
    let root = format!("/opt/cirro/pkgs/{}/{}", manifest.name, manifest.version);
    let mut paths = BTreeMap::new();
    let mut previous: Option<&str> = None;
    for entry in &index.tar_entries {
        if super::normalize(&entry.path, "/")? != entry.path
            || previous.is_some_and(|path| path >= entry.path.as_str())
        {
            return Err("EINVAL: package index is not canonical and strictly sorted".into());
        }
        if entry.path == "/" && entry.kind != format::TarEntryKind::Directory {
            return Err("EINVAL: package root is not a directory".into());
        }
        previous = Some(&entry.path);
        paths.insert(entry.path.as_str(), entry);
    }
    let mut entries = Vec::new();
    let mut blocks = BTreeMap::new();
    let mut logical_bytes = 0u64;
    for entry in &index.tar_entries {
        if entry.path != "/"
            && super::parent(&entry.path) != "/"
            && !paths
                .get(super::parent(&entry.path))
                .is_some_and(|parent| parent.kind == format::TarEntryKind::Directory)
        {
            return Err("EINVAL: package entry lacks a directory parent".into());
        }
        let path = super::normalize(&format!("{root}{}", entry.path), "/")?;
        let mtime_ns = u64::try_from(entry.mtime)
            .ok()
            .and_then(|time| time.checked_mul(1_000_000_000))
            .ok_or("EINVAL: package modification time is not representable")?;
        let node = match entry.kind {
            format::TarEntryKind::File => {
                if entry.size > super::MAX_FILE || entry.link_target.is_some() {
                    return Err("EFBIG: package file exceeds its quota or has a link target".into());
                }
                logical_bytes = logical_bytes
                    .checked_add(entry.size)
                    .ok_or("EFBIG: package byte count overflows")?;
                if logical_bytes > logical_limit {
                    return Err("ENOSPC: package logical bytes exceed the filesystem quota".into());
                }
                let start = mount_start
                    .checked_add(
                        usize::try_from(entry.offset)
                            .map_err(|_| "EFBIG: package offset overflows")?,
                    )
                    .ok_or("EFBIG: package offset overflows")?;
                let length =
                    usize::try_from(entry.size).map_err(|_| "EFBIG: package size overflows")?;
                let end = start
                    .checked_add(length)
                    .ok_or("EFBIG: package range overflows")?;
                let data = bytes
                    .get(start..end)
                    .ok_or("EINVAL: package file range exceeds the mount payload")?;
                let mut chunks = Vec::new();
                for (number, block) in data.chunks(262_144).enumerate() {
                    let hash = format!("{:x}", Sha256::digest(block));
                    blocks.entry(hash.clone()).or_insert(Block {
                        hash: hash.clone(),
                        offset: start + number * 262_144,
                        length: block.len(),
                    });
                    chunks.push(hash);
                }
                super::Node::File {
                    mode: entry.mode & 0o555,
                    size: entry.size,
                    chunks,
                }
            }
            format::TarEntryKind::Directory => {
                if entry.offset > (bytes.len() - mount_start) as u64
                    || entry.size != 0
                    || entry.link_target.is_some()
                {
                    return Err("EINVAL: package directory has payload fields".into());
                }
                super::Node::Directory {
                    mode: entry.mode & 0o555,
                }
            }
            format::TarEntryKind::Symlink => {
                if entry.offset > (bytes.len() - mount_start) as u64 || entry.size != 0 {
                    return Err("EINVAL: package symlink has payload fields".into());
                }
                let target = entry
                    .link_target
                    .as_ref()
                    .ok_or("EINVAL: package symlink lacks a target")?;
                super::normalize(target, super::parent(&entry.path))?;
                super::Node::Symlink {
                    target: target.clone(),
                }
            }
        };
        entries.push(Entry {
            path,
            node,
            uid: entry.uid,
            gid: entry.gid,
            mtime_ns: mtime_ns.to_string(),
        });
    }
    let mut commands = BTreeSet::new();
    for command in &manifest.commands {
        if !command_name(&command.command)
            || !commands.insert(&command.command)
            || command.entry.starts_with('/')
            || super::normalize(&command.entry, "/")? != format!("/{}", command.entry)
        {
            return Err("EINVAL: invalid or duplicate package command".into());
        }
        if !paths
            .get(format!("/{}", command.entry).as_str())
            .is_some_and(|entry| entry.kind != format::TarEntryKind::Directory)
        {
            return Err("EINVAL: package command target does not exist".into());
        }
    }
    let mut man_pages = BTreeSet::new();
    for page in &manifest.man_pages {
        if !segment(&page.section)
            || !segment(&page.page)
            || !man_pages.insert((&page.section, &page.page))
            || !paths.contains_key(format!("/share/man/{}/{}", page.section, page.page).as_str())
        {
            return Err("EINVAL: invalid or missing package man page".into());
        }
    }
    if let Some(provides) = &manifest.provides {
        if provides.env.len() > 128 || provides.files.len() > 128 {
            return Err("EFBIG: package projections exceed their quota".into());
        }
        for (key, value) in &provides.env {
            if key.is_empty()
                || key.len() > 128
                || key.contains(['=', '\0'])
                || value.len() > 4096
                || value.contains('\0')
            {
                return Err("EINVAL: invalid package environment".into());
            }
        }
        let mut targets = BTreeSet::new();
        for projection in &provides.files {
            let source = super::normalize(&projection.source, "/")?;
            if projection.source.starts_with('/')
                || source != format!("/{}", projection.source)
                || !paths
                    .get(source.as_str())
                    .is_some_and(|entry| entry.kind == format::TarEntryKind::Directory)
                || super::normalize(&projection.target, "/")? != projection.target
                || projection.target == "/"
                || !targets.insert(&projection.target)
            {
                return Err("EINVAL: invalid package directory projection".into());
            }
        }
    }
    Ok(Preparation {
        installed,
        root,
        entries,
        blocks: blocks.into_values().collect(),
    })
}

impl Kernel {
    pub(crate) fn package_writable(&self, path: &str, subtree: bool) -> Result<(), String> {
        if self.snapshot_import {
            return Ok(());
        }
        self.package_path_writable(path, subtree)
    }

    pub(crate) fn package_path_writable(&self, path: &str, subtree: bool) -> Result<(), String> {
        let projections = self.state.packages.iter().flat_map(|package| {
            package.manifest.provides.iter().flat_map(|provides| {
                provides
                    .files
                    .iter()
                    .map(|projection| projection.target.as_str())
            })
        });
        for root in std::iter::once("/opt/cirro").chain(projections) {
            if path == root
                || path.starts_with(&format!("{root}/"))
                || (subtree
                    && self.state.nodes.contains_key(root)
                    && root.starts_with(&format!("{path}/")))
            {
                return Err("EROFS: installed package projections are read-only".into());
            }
        }
        Ok(())
    }

    fn package_target(&self, link: &Link) -> Result<String, String> {
        let package = self
            .state
            .packages
            .iter()
            .find(|package| package.package_id == link.package_id)
            .ok_or("ENOENT: package is not installed")?;
        let command = package
            .manifest
            .commands
            .iter()
            .find(|command| command.command == link.command)
            .ok_or("ENOENT: package command does not exist")?;
        Ok(format!("{}/{}", root(package)?, command.entry))
    }

    pub(crate) fn validate_packages(&self) -> Result<(), String> {
        if self.state.packages.len() > 128 || self.state.links.len() > 256 {
            return Err("ENOSPC: package or command catalog exceeds its quota".into());
        }
        let mut ids = BTreeSet::new();
        let mut roots = BTreeSet::new();
        for package in &self.state.packages {
            let root = root(package)?;
            if !ids.insert(&package.package_id)
                || !roots.insert(root.clone())
                || !matches!(self.state.node(&root), Some(super::Node::Directory { .. }))
            {
                return Err("EINVAL: duplicate package identity or missing package root".into());
            }
            if matches!(self.state.node(&root),Some(super::Node::Directory{mode}) if mode & 0o222 != 0)
            {
                return Err("EINVAL: package root is writable".into());
            }
            let prefix = format!("{root}/");
            for (path, node) in self.state.entries_from(prefix.clone()) {
                if !path.starts_with(&prefix) {
                    break;
                }
                if !matches!(node, super::Node::Symlink { .. }) && node.mode() & 0o222 != 0 {
                    return Err("EINVAL: package nodes are writable".into());
                }
            }
            for command in &package.manifest.commands {
                if !command_name(&command.command)
                    || command.entry.starts_with('/')
                    || super::normalize(&command.entry, "/")? != format!("/{}", command.entry)
                    || !self
                        .state
                        .nodes
                        .contains_key(&format!("{root}/{}", command.entry))
                {
                    return Err("EINVAL: invalid installed command target".into());
                }
            }
            if let Some(provides) = &package.manifest.provides {
                for projection in &provides.files {
                    let target = format!("{root}/{}", projection.source);
                    if !matches!(self.state.node(&projection.target),Some(super::Node::Symlink{target:actual}) if actual == &target)
                    {
                        return Err("EINVAL: package directory projection is missing".into());
                    }
                }
            }
        }
        for (alias, link) in &self.state.links {
            let target = self.package_target(link)?;
            if !command_name(alias)
                || !matches!(self.state.node(&format!("/opt/cirro/bin/{alias}")),Some(super::Node::Symlink{target:actual}) if actual == &target)
            {
                return Err("EINVAL: invalid package command projection".into());
            }
        }
        Ok(())
    }

    fn package_directory(&mut self, path: &str) -> Result<(), String> {
        let path = super::normalize(path, "/")?;
        let mut current = String::new();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            current.push('/');
            current.push_str(part);
            match self.state.node(&current) {
                Some(super::Node::Directory { .. }) => {}
                Some(_) => {
                    return Err("ENOTDIR: package projection parent is not a directory".into());
                }
                None => self.insert(current.clone(), super::Node::Directory { mode: 0o755 })?,
            }
        }
        Ok(())
    }

    fn remove_package_tree(&mut self, root: &str) {
        let prefix = format!("{root}/");
        self.state
            .nodes
            .retain(|path, _| path != root && !path.starts_with(&prefix));
        self.state.retain_linked();
        if let Some(metadata) = self.state.metadata_mut(super::parent(root)) {
            metadata.mtime_ns = self.now;
            metadata.ctime_ns = self.now;
        }
    }

    fn package_aliases(&mut self) -> Result<(), String> {
        for package in &self.state.packages {
            for command in &package.manifest.commands {
                self.state
                    .links
                    .entry(command.command.clone())
                    .or_insert_with(|| Link {
                        package_id: package.package_id.clone(),
                        command: command.command.clone(),
                    });
            }
        }
        if self.state.links.len() > 256 {
            return Err("ENOSPC: command catalog exceeds its quota".into());
        }
        let mut aliases = BTreeMap::new();
        for (alias, link) in &self.state.links {
            aliases.insert(
                format!("/opt/cirro/bin/{alias}"),
                self.package_target(link)?,
            );
        }
        for package in &self.state.packages {
            let root = root(package)?;
            for page in &package.manifest.man_pages {
                aliases
                    .entry(format!(
                        "/opt/cirro/share/man/{}/{}",
                        page.section, page.page
                    ))
                    .or_insert_with(|| format!("{root}/share/man/{}/{}", page.section, page.page));
            }
        }
        let stale: Vec<String> = self
            .state
            .entries()
            .filter(|(path, node)| {
                (path.starts_with("/opt/cirro/bin/") || path.starts_with("/opt/cirro/share/man/"))
                    && matches!(node, super::Node::Symlink { .. })
                    && !aliases.contains_key(*path)
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in stale {
            self.remove_package_tree(&path);
        }
        for (path, target) in aliases {
            if matches!(self.state.node(&path),Some(super::Node::Symlink{target:actual}) if actual == &target)
            {
                continue;
            }
            self.package_directory(super::parent(&path))?;
            self.insert(path, super::Node::Symlink { target })?;
        }
        Ok(())
    }

    fn commit_catalog(&mut self, staged: Kernel) -> Result<(), String> {
        staged.validate()?;
        if serde_json::to_string(&staged.state)
            .map_err(|_| "EIO: package catalog serialization failed")?
            .len()
            > 8_388_608
        {
            return Err("EFBIG: package catalog exceeds the manifest quota".into());
        }
        self.state = staged.state;
        Ok(())
    }

    pub(crate) fn install_prepared(&mut self, prepared: &Preparation) -> Result<(), String> {
        self.install_content(prepared, false)
    }

    fn install_content(&mut self, prepared: &Preparation, shared: bool) -> Result<(), String> {
        if self
            .state
            .packages
            .iter()
            .any(|package| package.package_id == prepared.installed.package_id)
            || self.state.nodes.contains_key(&prepared.root)
        {
            return Err("EEXIST: package identity or version is already installed".into());
        }
        if self.state.packages.len() >= 128 {
            return Err("ENOSPC: package catalog exceeds its quota".into());
        }
        let mut staged = super::Kernel {
            state: self.state.clone(),
            now: self.now,
            snapshot_import: false,
        };
        if shared {
            staged
                .state
                .shared_chunks
                .extend(prepared.blocks.iter().map(|block| block.hash.clone()));
        }
        staged.package_directory(&prepared.root)?;
        if let Some(super::Node::Directory { mode }) = staged.state.node_mut(&prepared.root) {
            *mode = 0o555;
        }
        for entry in &prepared.entries {
            staged.package_directory(super::parent(&entry.path))?;
            staged.insert(entry.path.clone(), entry.node.clone())?;
        }
        for entry in &prepared.entries {
            let metadata = staged
                .state
                .metadata_mut(&entry.path)
                .ok_or("EIO: missing installed file metadata")?;
            metadata.uid = entry.uid;
            metadata.gid = entry.gid;
            metadata.mtime_ns = entry
                .mtime_ns
                .parse()
                .map_err(|_| "EINVAL: invalid package modification time")?;
        }
        if let Some(provides) = &prepared.installed.manifest.provides {
            for projection in &provides.files {
                if staged.state.nodes.contains_key(&projection.target) {
                    return Err("EEXIST: package projection target already exists".into());
                }
                staged.package_writable(&projection.target, true)?;
                staged.package_directory(super::parent(&projection.target))?;
                staged.insert(
                    projection.target.clone(),
                    super::Node::Symlink {
                        target: format!("{}/{}", prepared.root, projection.source),
                    },
                )?;
            }
        }
        staged.state.packages.push(prepared.installed.clone());
        staged.package_aliases()?;
        self.commit_catalog(staged)
    }

    pub(crate) fn uninstall_native(&mut self, id: &str) -> Result<(), String> {
        let package = self
            .state
            .packages
            .iter()
            .find(|package| package.package_id == id)
            .cloned()
            .ok_or("ENOENT: package is not installed")?;
        let root = root(&package)?;
        let mut staged = super::Kernel {
            state: self.state.clone(),
            now: self.now,
            snapshot_import: false,
        };
        staged.remove_package_tree(&root);
        if let Some(provides) = package.manifest.provides {
            for projection in provides.files {
                staged.remove_package_tree(&projection.target);
            }
        }
        staged
            .state
            .packages
            .retain(|package| package.package_id != id);
        staged.state.links.retain(|_, link| link.package_id != id);
        staged.package_aliases()?;
        self.commit_catalog(staged)
    }

    pub(crate) fn link_native(
        &mut self,
        id: &str,
        command: &str,
        alias: &str,
    ) -> Result<(), String> {
        if !command_name(alias) {
            return Err("EINVAL: invalid command alias".into());
        }
        let link = Link {
            package_id: id.into(),
            command: command.into(),
        };
        self.package_target(&link)?;
        let mut staged = super::Kernel {
            state: self.state.clone(),
            now: self.now,
            snapshot_import: false,
        };
        staged.state.links.insert(alias.into(), link);
        staged.package_aliases()?;
        self.commit_catalog(staged)
    }
}

#[wasm_bindgen::prelude::wasm_bindgen]
impl Kernel {
    pub fn interpreter_arguments(&self, bytes: &[u8]) -> Result<String, wasm_bindgen::JsValue> {
        let arguments = interpreter_arguments(bytes).map_err(|error| super::fail(&error))?;
        serde_json::to_string(&arguments)
            .map_err(|_| super::fail("EIO: interpreter argument serialization failed"))
    }
    pub fn install_package(&mut self, bytes: &[u8]) -> Result<String, wasm_bindgen::JsValue> {
        let prepared = prepare(bytes).map_err(|error| super::fail(&error))?;
        self.install_prepared(&prepared)
            .map_err(|error| super::fail(&error))?;
        let blocks = prepared
            .blocks
            .into_iter()
            .filter(|block| !self.state.shared_chunks.contains(&block.hash))
            .collect::<Vec<_>>();
        serde_json::to_string(&serde_json::json!({"installed":prepared.installed,"blocks":blocks}))
            .map_err(|_| super::fail("EIO: package serialization failed"))
    }
    pub fn install_image_package(&mut self, bytes: &[u8]) -> Result<String, wasm_bindgen::JsValue> {
        let prepared = prepare_bounded(bytes, 134_217_728, 134_217_728)
            .map_err(|error| super::fail(&error))?;
        self.install_content(&prepared, true)
            .map_err(|error| super::fail(&error))?;
        serde_json::to_string(
            &serde_json::json!({"installed":prepared.installed,"blocks":prepared.blocks}),
        )
        .map_err(|_| super::fail("EIO: package serialization failed"))
    }
    pub fn share_package_blocks(&mut self) -> Result<(), wasm_bindgen::JsValue> {
        let roots = self
            .state
            .packages
            .iter()
            .map(|package| root(package).map(|root| format!("{root}/")))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| super::fail(&error))?;
        let mut shared = self.state.shared_chunks.clone();
        for (path, node) in self.state.entries() {
            if roots.iter().any(|root| path.starts_with(root.as_str()))
                && let super::Node::File { chunks, .. } = node
            {
                shared.extend(chunks.iter().cloned());
            }
        }
        if shared.len() > super::MAX_NODES * 2 {
            return Err(super::fail(
                "EFBIG: shared block inventory exceeds its quota",
            ));
        }
        self.state.shared_chunks = shared;
        Ok(())
    }
    pub fn uninstall_package(&mut self, id: &str) -> Result<(), wasm_bindgen::JsValue> {
        self.uninstall_native(id)
            .map_err(|error| super::fail(&error))
    }
    pub fn link_package(
        &mut self,
        id: &str,
        command: &str,
        alias: &str,
    ) -> Result<(), wasm_bindgen::JsValue> {
        self.link_native(id, command, alias)
            .map_err(|error| super::fail(&error))
    }
    pub fn packages(&self) -> Result<String, wasm_bindgen::JsValue> {
        serde_json::to_string(&self.state.packages)
            .map_err(|_| super::fail("EIO: package serialization failed"))
    }
    pub fn command_path(
        &self,
        command: &str,
        cwd: &str,
        search: &str,
    ) -> Result<String, wasm_bindgen::JsValue> {
        if command.is_empty() || command.contains('\0') || search.len() > 4096 {
            return Err(super::fail("EINVAL: invalid command or PATH"));
        }
        let candidates: Vec<String> = if command.contains('/') {
            vec![super::absolute(command, cwd).map_err(|error| super::fail(&error))?]
        } else {
            search
                .split(':')
                .map(|directory| {
                    let directory = if directory.is_empty() {
                        cwd.to_string()
                    } else {
                        super::absolute(directory, cwd)?
                    };
                    super::absolute(command, &directory)
                })
                .collect::<Result<_, String>>()
                .map_err(|error| super::fail(&error))?
        };
        let mut denied = false;
        for candidate in candidates {
            let path = match self.resolve(&candidate, true) {
                Ok(path) => path,
                Err(error) if error.starts_with("ENOENT:") || error.starts_with("ENOTDIR:") => {
                    continue;
                }
                Err(error) if error.starts_with("EACCES:") => {
                    denied = true;
                    continue;
                }
                Err(error) => return Err(super::fail(&error)),
            };
            match self.state.node(&path) {
                Some(super::Node::File { mode, .. }) if mode & 0o111 != 0 => return Ok(path),
                Some(_) => denied = true,
                None => {}
            }
        }
        if denied {
            return Err(super::fail(
                "EACCES: command is not executable or accessible",
            ));
        }
        Err(super::fail("ENOENT: command was not found in PATH"))
    }
    pub fn package_environment(&self) -> Result<String, wasm_bindgen::JsValue> {
        let mut env = BTreeMap::new();
        for package in &self.state.packages {
            if let Some(provides) = &package.manifest.provides {
                for (key, value) in &provides.env {
                    env.entry(key).or_insert(value);
                }
            }
        }
        serde_json::to_string(&env)
            .map_err(|_| super::fail("EIO: package environment serialization failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreter_headers_preserve_one_optional_argument_and_bound_parsing() {
        assert_eq!(
            interpreter_arguments(b"#! /bin/run\nbody").unwrap(),
            ["/bin/run"]
        );
        assert_eq!(
            interpreter_arguments(b"#!\t/bin/run\t -x two  \t\nbody").unwrap(),
            ["/bin/run", "-x two"]
        );
        assert_eq!(interpreter_arguments(b"#!/bin/run").unwrap(), ["/bin/run"]);
        for bytes in [
            b"plain".as_slice(),
            b"#! \t\n",
            b"#!/bin/\xff\n",
            b"#!/bin/a\0\n",
        ] {
            assert!(interpreter_arguments(bytes).is_err());
        }
        assert!(
            interpreter_arguments(
                &b"#!"
                    .as_slice()
                    .iter()
                    .copied()
                    .chain(std::iter::repeat_n(b'a', 254))
                    .collect::<Vec<_>>()
            )
            .is_err()
        );
    }

    fn fixture() -> (format::PackageManifest, format::MountIndex, Vec<u8>) {
        let manifest = format::PackageManifest {
            name: "echo".into(),
            version: "1.0.0".into(),
            provides: None,
            commands: vec![format::CommandTarget {
                command: "echo".into(),
                entry: "bin/echo".into(),
            }],
            man_pages: Vec::new(),
        };
        let index = format::MountIndex {
            tar_entries: vec![
                format::TarEntry {
                    path: "/bin".into(),
                    kind: format::TarEntryKind::Directory,
                    offset: 0,
                    size: 0,
                    mode: 0o40755,
                    uid: 0,
                    gid: 0,
                    mtime: 0,
                    link_target: None,
                },
                format::TarEntry {
                    path: "/bin/echo".into(),
                    kind: format::TarEntryKind::File,
                    offset: 512,
                    size: 4,
                    mode: 0o100755,
                    uid: 1000,
                    gid: 1001,
                    mtime: 123,
                    link_target: None,
                },
            ],
        };
        let mut tar = vec![0u8; 2048];
        tar[512..516].copy_from_slice(b"wasm");
        (manifest, index, tar)
    }

    fn encode(
        manifest: &format::PackageManifest,
        index: &format::MountIndex,
        tar: &[u8],
    ) -> Result<Vec<u8>, String> {
        let manifest = serde_bare::to_vec(manifest).map_err(|error| error.to_string())?;
        let index = serde_bare::to_vec(index).map_err(|error| error.to_string())?;
        let mut bytes = vec![0x89, b'A', b'O', b'S', 2, 0, 0, 0];
        bytes.extend(((manifest.len() + 2) as u32).to_le_bytes());
        bytes.extend(((index.len() + 2) as u32).to_le_bytes());
        bytes.extend([2, 0]);
        bytes.extend(manifest);
        bytes.extend([2, 0]);
        bytes.extend(index);
        bytes.extend(tar);
        Ok(bytes)
    }

    #[test]
    fn image_admission_has_independent_bounds_and_posix_bracket_command() -> Result<(), String> {
        let (mut manifest, index, mut tar) = fixture();
        manifest.commands[0].command = "[".into();
        tar.resize(16_777_216, 0);
        let bytes = encode(&manifest, &index, &tar)?;
        assert!(prepare(&bytes).is_err());
        let prepared = prepare_bounded(&bytes, 134_217_728, 134_217_728)?;
        let mut kernel = Kernel::fresh();
        kernel.install_content(&prepared, true)?;
        assert_eq!(kernel.private_bytes(), 0);
        assert_eq!(kernel.used_bytes(), 4);
        kernel.validate()?;
        assert!(kernel.state.links.contains_key("["));
        assert!(prepare_bounded(&bytes, bytes.len() - 1, 134_217_728).is_err());
        assert!(prepare_bounded(&bytes, 134_217_728, 3).is_err());
        Ok(())
    }

    #[test]
    fn package_ranges_hashes_permissions_and_metadata_are_prepared() -> Result<(), String> {
        let (manifest, index, tar) = fixture();
        let bytes = encode(&manifest, &index, &tar)?;
        let prepared = prepare(&bytes)?;
        assert_eq!(prepared.root, "/opt/cirro/pkgs/echo/1.0.0");
        assert_eq!(
            prepared.installed.package_id,
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(prepared.entries.len(), 2);
        assert!(matches!(
            prepared.entries[1].node,
            super::super::Node::File {
                mode: 0o555,
                size: 4,
                ..
            }
        ));
        assert_eq!(
            (
                prepared.entries[1].uid,
                prepared.entries[1].gid,
                prepared.entries[1].mtime_ns.as_str()
            ),
            (1000, 1001, "123000000000")
        );
        assert_eq!(
            &bytes
                [prepared.blocks[0].offset..prepared.blocks[0].offset + prepared.blocks[0].length],
            b"wasm"
        );
        assert_eq!(
            prepared.blocks[0].hash,
            format!("{:x}", Sha256::digest(b"wasm"))
        );
        Ok(())
    }

    #[test]
    fn package_framing_truncation_and_trailing_metadata_are_rejected() -> Result<(), String> {
        let (manifest, index, tar) = fixture();
        let bytes = encode(&manifest, &index, &tar)?;
        for length in 0..16 {
            assert!(prepare(&bytes[..length]).is_err());
        }
        for position in [0, 4, 6, 16] {
            let mut invalid = bytes.clone();
            invalid[position] = 255;
            assert!(prepare(&invalid).is_err());
        }
        let mut invalid = bytes.clone();
        let manifest_length =
            u32::from_le_bytes(invalid[8..12].try_into().map_err(|_| "invalid length")?) as usize;
        invalid.insert(16 + manifest_length, 0);
        invalid[8..12].copy_from_slice(&((manifest_length + 1) as u32).to_le_bytes());
        assert!(prepare(&invalid).is_err());
        Ok(())
    }

    #[test]
    fn package_path_inventory_and_command_escape_are_rejected() -> Result<(), String> {
        let (mut manifest, mut index, tar) = fixture();
        manifest.name = "../escape".into();
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        manifest.name = "echo".into();
        manifest.commands[0].entry = "../escape".into();
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        manifest.commands[0].entry = "bin/echo".into();
        index.tar_entries[1].path = "/bin/../echo".into();
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        index.tar_entries[1].path = "/bin/echo".into();
        index.tar_entries.swap(0, 1);
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        index.tar_entries.swap(0, 1);
        index.tar_entries.remove(0);
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        Ok(())
    }

    #[test]
    fn nonfile_tar_offsets_are_validated_as_payload_positions() -> Result<(), String> {
        let (manifest, mut index, tar) = fixture();
        index.tar_entries[0].offset = 512;
        let prepared = prepare(&encode(&manifest, &index, &tar)?)?;
        assert_eq!(prepared.entries.len(), 2);
        index.tar_entries[0].offset = tar.len() as u64 + 1;
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        Ok(())
    }

    #[test]
    fn package_file_ranges_and_duplicate_commands_are_rejected() -> Result<(), String> {
        let (mut manifest, mut index, tar) = fixture();
        index.tar_entries[1].offset = u64::MAX;
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        index.tar_entries[1].offset = 512;
        index.tar_entries[1].size = super::super::MAX_FILE + 1;
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        index.tar_entries[1].size = 4;
        manifest.commands.push(manifest.commands[0].clone());
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        Ok(())
    }

    #[test]
    fn package_environment_and_directory_projections_are_consumed_and_validated()
    -> Result<(), String> {
        let (mut manifest, index, tar) = fixture();
        manifest.provides = Some(format::ProvidesBlock {
            env: std::collections::HashMap::from([("MODE".into(), "package".into())]),
            files: vec![format::ProvidesFile {
                source: "bin".into(),
                target: "/usr/share/echo".into(),
            }],
        });
        let prepared = prepare(&encode(&manifest, &index, &tar)?)?;
        assert_eq!(
            prepared
                .installed
                .manifest
                .provides
                .as_ref()
                .ok_or("missing projections")?
                .env
                .get("MODE")
                .map(String::as_str),
            Some("package")
        );
        let provides = manifest.provides.as_mut().ok_or("missing projections")?;
        provides.files[0].source = "bin/echo".into();
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        let provides = manifest.provides.as_mut().ok_or("missing projections")?;
        provides.files[0].source = "bin".into();
        provides.env.insert("BAD=KEY".into(), "x".into());
        assert!(prepare(&encode(&manifest, &index, &tar)?).is_err());
        Ok(())
    }
    #[test]
    fn catalog_install_link_and_remove_are_atomic_and_protected() -> Result<(), String> {
        let (manifest, index, tar) = fixture();
        let prepared = prepare(&encode(&manifest, &index, &tar)?)?;
        let mut kernel = Kernel::fresh();
        kernel.set_time(100);
        kernel.install_prepared(&prepared)?;
        assert_eq!(kernel.state.packages.len(), 1);
        assert_eq!(
            kernel
                .state
                .metadata("/opt/cirro/pkgs/echo/1.0.0/bin/echo")
                .ok_or("missing metadata")?
                .uid,
            1000
        );
        assert!(kernel.package_writable("/opt", true).is_err());
        assert!(
            kernel
                .package_writable("/opt/cirro/pkgs/echo/1.0.0/bin/echo", false)
                .is_err()
        );
        let before = serde_json::to_string(&kernel.state).map_err(|error| error.to_string())?;
        assert!(kernel.install_prepared(&prepared).is_err());
        assert_eq!(
            serde_json::to_string(&kernel.state).map_err(|error| error.to_string())?,
            before
        );
        kernel.link_native(&prepared.installed.package_id, "echo", "alias")?;
        assert_eq!(
            kernel
                .state
                .links
                .get("alias")
                .ok_or("missing alias")?
                .package_id,
            prepared.installed.package_id
        );
        kernel.uninstall_native(&prepared.installed.package_id)?;
        assert!(kernel.state.packages.is_empty());
        assert!(kernel.state.links.is_empty());
        assert!(!kernel.state.nodes.contains_key("/opt/cirro/bin/alias"));
        assert!(!kernel.state.nodes.contains_key(&prepared.root));
        kernel.validate()?;
        Ok(())
    }

    #[test]
    fn catalog_serialization_is_stable_and_command_ownership_falls_back() -> Result<(), String> {
        let (mut manifest, index, tar) = fixture();
        manifest.provides = Some(format::ProvidesBlock {
            env: std::collections::HashMap::from([
                ("Z".into(), "last".into()),
                ("A".into(), "first".into()),
            ]),
            files: Vec::new(),
        });
        let first = prepare(&encode(&manifest, &index, &tar)?)?;
        manifest.version = "2.0.0".into();
        let second = prepare(&encode(&manifest, &index, &tar)?)?;
        let mut kernel = Kernel::fresh();
        kernel.install_prepared(&first)?;
        kernel.install_prepared(&second)?;
        assert_eq!(
            kernel
                .state
                .links
                .get("echo")
                .ok_or("missing command")?
                .package_id,
            first.installed.package_id
        );
        let json = serde_json::to_string(&kernel.state).map_err(|error| error.to_string())?;
        let restored = Kernel {
            state: serde_json::from_str(&json).map_err(|error| error.to_string())?,
            now: 0,
            snapshot_import: false,
        };
        assert_eq!(
            serde_json::to_string(&restored.state).map_err(|error| error.to_string())?,
            json
        );
        kernel.uninstall_native(&first.installed.package_id)?;
        assert_eq!(
            kernel
                .state
                .links
                .get("echo")
                .ok_or("missing fallback")?
                .package_id,
            second.installed.package_id
        );
        kernel.validate()?;
        Ok(())
    }
}
