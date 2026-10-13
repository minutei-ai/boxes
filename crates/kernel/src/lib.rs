mod shell;
mod software;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

const MAX_NODES: usize = 16_384;
const MAX_PATH: usize = 4096;
const MAX_DEPTH: usize = 64;
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Node {
    File {
        mode: u32,
        size: u64,
        chunks: Vec<String>,
    },
    Directory {
        mode: u32,
    },
    Symlink {
        target: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    inode: u64,
    uid: u32,
    gid: u32,
    atime_ns: u64,
    mtime_ns: u64,
    ctime_ns: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    generation: u64,
    nodes: BTreeMap<String, Node>,
    metadata: BTreeMap<String, Metadata>,
    next_inode: u64,
    packages: Vec<software::Installed>,
    links: BTreeMap<String, software::Link>,
}

struct WritePlan {
    path: String,
    mode: u32,
    chunks: Vec<String>,
    uploads: BTreeSet<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stat<'a> {
    path: &'a str,
    kind: &'static str,
    size: u64,
    mode: u32,
    inode: u64,
    nlink: u64,
    uid: u32,
    gid: u32,
    atime_ns: String,
    mtime_ns: String,
    ctime_ns: String,
}

#[derive(Debug, Serialize)]
struct Entry<'a> {
    name: &'a str,
    kind: &'static str,
    inode: u64,
}

#[derive(Serialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct Kernel {
    state: Manifest,
    now: u64,
}

fn fail(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PriorManifest {
    version: u32,
    generation: u64,
    nodes: BTreeMap<String, Node>,
}

#[wasm_bindgen]
pub fn prepare_package(bytes: &[u8]) -> Result<String, JsValue> {
    let prepared = software::prepare(bytes).map_err(|error| fail(&error))?;
    serde_json::to_string(&prepared).map_err(|_| fail("EIO: package serialization failed"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriorMetadata {
    inode: u64,
    atime_ns: u64,
    mtime_ns: u64,
    ctime_ns: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriorMetadataManifest {
    version: u32,
    generation: u64,
    nodes: BTreeMap<String, Node>,
    metadata: BTreeMap<String, PriorMetadata>,
    next_inode: u64,
}

#[wasm_bindgen]
pub fn migrate_filesystem(json: &str) -> Result<String, JsValue> {
    if json.len() > 8_388_608 {
        return Err(fail("EFBIG: manifest exceeds its quota"));
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| fail("EINVAL: invalid manifest"))?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    let state = match version {
        Some(3) => serde_json::from_value(value).map_err(|_| fail("EINVAL: invalid manifest"))?,
        Some(2) => {
            let prior: PriorMetadataManifest = serde_json::from_value(value)
                .map_err(|_| fail("EINVAL: invalid prior metadata manifest"))?;
            if prior.version != 2 {
                return Err(fail("EINVAL: invalid prior metadata version"));
            }
            Manifest {
                version: 3,
                generation: prior.generation,
                nodes: prior.nodes,
                next_inode: prior.next_inode,
                metadata: prior
                    .metadata
                    .into_iter()
                    .map(|(path, meta)| {
                        (
                            path,
                            Metadata {
                                inode: meta.inode,
                                uid: 0,
                                gid: 0,
                                atime_ns: meta.atime_ns,
                                mtime_ns: meta.mtime_ns,
                                ctime_ns: meta.ctime_ns,
                            },
                        )
                    })
                    .collect(),
                packages: Vec::new(),
                links: BTreeMap::new(),
            }
        }
        Some(1) => {
            let prior: PriorManifest = serde_json::from_value(value)
                .map_err(|_| fail("EINVAL: invalid prior manifest"))?;
            if prior.version != 1 {
                return Err(fail("EINVAL: invalid prior version"));
            }
            let metadata = prior
                .nodes
                .keys()
                .enumerate()
                .map(|(index, path)| {
                    (
                        path.clone(),
                        Metadata {
                            inode: index as u64 + 1,
                            uid: 0,
                            gid: 0,
                            atime_ns: 0,
                            mtime_ns: 0,
                            ctime_ns: 0,
                        },
                    )
                })
                .collect();
            Manifest {
                version: 3,
                generation: prior.generation,
                next_inode: prior.nodes.len() as u64 + 1,
                nodes: prior.nodes,
                metadata,
                packages: Vec::new(),
                links: BTreeMap::new(),
            }
        }
        _ => return Err(fail("EINVAL: unsupported manifest version")),
    };
    let kernel = Kernel { state, now: 0 };
    kernel.validate().map_err(|error| fail(&error))?;
    kernel.manifest()
}

pub fn normalize(path: &str, cwd: &str) -> Result<String, String> {
    if path.is_empty() || path.contains('\0') || path.len() > MAX_PATH {
        return Err("EINVAL: invalid path".into());
    }
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    };
    let mut components = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            _ => components.push(part),
        }
    }
    if components.len() > MAX_DEPTH {
        return Err("ENAMETOOLONG: path depth exceeded".into());
    }
    let result = format!("/{}", components.join("/"));
    if result.len() > MAX_PATH {
        return Err("ENAMETOOLONG: path length exceeded".into());
    }
    Ok(result)
}

fn parent(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/",
        Some((prefix, _)) => prefix,
    }
}

impl Node {
    fn kind(&self) -> &'static str {
        match self {
            Self::File { .. } => "file",
            Self::Directory { .. } => "directory",
            Self::Symlink { .. } => "symlink",
        }
    }

    fn size(&self) -> u64 {
        match self {
            Self::File { size, .. } => *size,
            Self::Directory { .. } => 0,
            Self::Symlink { target } => u64::try_from(target.len()).unwrap_or(u64::MAX),
        }
    }

    fn mode(&self) -> u32 {
        match self {
            Self::File { mode, .. } | Self::Directory { mode } => *mode,
            Self::Symlink { .. } => 0o777,
        }
    }
}

impl Kernel {
    fn walk(&self, path: &str, max_depth: usize, exclude: &str) -> Result<Vec<TreeEntry>, String> {
        if max_depth > MAX_DEPTH {
            return Err("EINVAL: recursive depth exceeds its limit".into());
        }
        let excluded: BTreeSet<String> =
            serde_json::from_str(exclude).map_err(|_| "EINVAL: invalid exclusions".to_string())?;
        if excluded.len() > 128
            || excluded.iter().any(|name| {
                name.is_empty() || name.contains('/') || name.contains('\0') || name.len() > 255
            })
        {
            return Err("EINVAL: invalid excluded names".into());
        }
        let logical = normalize(path, "/")?;
        let root = self.resolve(&logical, true)?;
        match self.state.nodes.get(&root) {
            Some(Node::Directory { mode }) if mode & 0o500 == 0o500 => {}
            Some(Node::Directory { .. }) => return Err("EACCES: directory is not readable".into()),
            Some(_) => return Err("ENOTDIR: not a directory".into()),
            None => return Err("ENOENT: directory does not exist".into()),
        }
        let prefix = if root == "/" {
            "/".to_string()
        } else {
            format!("{root}/")
        };
        let mut result = Vec::new();
        for (key, node) in self.state.nodes.range(prefix.clone()..) {
            let Some(relative) = key.strip_prefix(&prefix) else {
                break;
            };
            if relative.is_empty() {
                continue;
            }
            let components: Vec<_> = relative.split('/').collect();
            let depth = components.len() - 1;
            if depth > max_depth || components.iter().any(|name| excluded.contains(*name)) {
                continue;
            }
            self.resolve(key, false)?;
            if let Node::Directory { mode } = node
                && depth < max_depth
                && mode & 0o500 != 0o500
            {
                return Err("EACCES: child directory is not readable".into());
            }
            let path = if logical == "/" {
                format!("/{relative}")
            } else {
                format!("{logical}/{relative}")
            };
            result.push(TreeEntry {
                path,
                kind: node.kind(),
                size: node.size(),
            });
        }
        Ok(result)
    }

    fn fresh() -> Self {
        Self {
            state: Manifest {
                version: 3,
                generation: 0,
                packages: Vec::new(),
                links: BTreeMap::new(),
                next_inode: 5,
                metadata: ["/", "/home", "/home/cirro", "/tmp"]
                    .into_iter()
                    .enumerate()
                    .map(|(index, path)| {
                        (
                            path.into(),
                            Metadata {
                                inode: index as u64 + 1,
                                uid: 0,
                                gid: 0,
                                atime_ns: 0,
                                mtime_ns: 0,
                                ctime_ns: 0,
                            },
                        )
                    })
                    .collect(),
                nodes: BTreeMap::from([
                    ("/".into(), Node::Directory { mode: 0o755 }),
                    ("/home".into(), Node::Directory { mode: 0o755 }),
                    ("/home/cirro".into(), Node::Directory { mode: 0o755 }),
                    ("/tmp".into(), Node::Directory { mode: 0o777 }),
                ]),
            },
            now: 0,
        }
    }

    fn resolve(&self, path: &str, follow_last: bool) -> Result<String, String> {
        let mut pending = normalize(path, "/")?;
        if pending != "/"
            && matches!(self.state.nodes.get("/"), Some(Node::Directory { mode }) if mode & 0o100 == 0)
        {
            return Err("EACCES: root is not searchable".into());
        }
        for _ in 0..40 {
            let pieces: Vec<_> = pending.split('/').filter(|p| !p.is_empty()).collect();
            let mut prefix = String::new();
            let mut replacement = None;
            for (index, piece) in pieces.iter().enumerate() {
                prefix.push('/');
                prefix.push_str(piece);
                let last = index + 1 == pieces.len();
                match self.state.nodes.get(&prefix) {
                    Some(Node::Symlink { target }) if follow_last || !last => {
                        let suffix = pieces.get(index + 1..).unwrap_or_default().join("/");
                        replacement =
                            Some(normalize(&format!("{target}/{suffix}"), parent(&prefix))?);
                        break;
                    }
                    Some(Node::Directory { mode }) if !last && mode & 0o100 == 0 => {
                        return Err("EACCES: directory is not searchable".into());
                    }
                    Some(Node::File { .. }) if !last => {
                        return Err("ENOTDIR: path component is a file".into());
                    }
                    None if !last => return Err("ENOENT: parent does not exist".into()),
                    _ => {}
                }
            }
            match replacement {
                Some(next) => pending = next,
                None => return Ok(pending),
            }
        }
        Err("ELOOP: too many symlinks".into())
    }

    fn writable_parent(&self, path: &str) -> Result<(), String> {
        match self.state.nodes.get(parent(path)) {
            Some(Node::Directory { mode }) if mode & 0o300 == 0o300 => Ok(()),
            Some(Node::Directory { .. }) => Err("EACCES: parent is not writable".into()),
            Some(_) => Err("ENOTDIR: parent is not a directory".into()),
            None => Err("ENOENT: parent does not exist".into()),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.state.version != 3 || self.state.nodes.len() > MAX_NODES {
            return Err("EINVAL: invalid manifest version or node count".into());
        }
        if !matches!(self.state.nodes.get("/"), Some(Node::Directory { .. })) {
            return Err("EINVAL: root must be a directory".into());
        }
        if self.state.metadata.keys().ne(self.state.nodes.keys()) {
            return Err("EINVAL: metadata paths do not match nodes".into());
        }
        let mut inodes = BTreeSet::new();
        for meta in self.state.metadata.values() {
            if meta.inode == 0 || meta.inode >= self.state.next_inode || !inodes.insert(meta.inode)
            {
                return Err("EINVAL: duplicate or invalid inode identity".into());
            }
        }
        for (path, node) in &self.state.nodes {
            if normalize(path, "/")? != *path || node.mode() > 0o777 {
                return Err("EINVAL: noncanonical manifest path or mode".into());
            }
            if path != "/"
                && !matches!(
                    self.state.nodes.get(parent(path)),
                    Some(Node::Directory { .. })
                )
            {
                return Err("EINVAL: orphaned node".into());
            }
            if let Node::File { chunks, size, .. } = node {
                if *size > MAX_FILE
                    || chunks.len() != usize::try_from(size.div_ceil(262_144)).unwrap_or(usize::MAX)
                {
                    return Err("EINVAL: invalid file size or chunk count".into());
                }
                if chunks.iter().any(|chunk| {
                    chunk.len() != 64
                        || !chunk
                            .bytes()
                            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                }) {
                    return Err("EINVAL: invalid content digest".into());
                }
            }
            if let Node::Symlink { target } = node {
                normalize(target, parent(path))?;
            }
        }
        self.validate_packages()?;
        if self.used_bytes() > MAX_TOTAL {
            return Err("ENOSPC: filesystem byte quota exceeded".into());
        }
        Ok(())
    }

    fn used_bytes(&self) -> u64 {
        self.state
            .nodes
            .values()
            .filter_map(|node| match node {
                Node::File { size, .. } => Some(*size),
                _ => None,
            })
            .sum()
    }

    fn write_plan(&self, path: &str, size: u64, chunks: &str) -> Result<WritePlan, String> {
        let path = self.resolve(path, true)?;
        self.package_writable(&path, false)?;
        let hashes: Vec<String> = serde_json::from_str(chunks)
            .map_err(|_| "EINVAL: invalid chunk references".to_string())?;
        if size > MAX_FILE
            || hashes.len() != usize::try_from(size.div_ceil(262_144)).unwrap_or(usize::MAX)
        {
            return Err("EFBIG: file limit or chunk count exceeded".into());
        }
        if hashes.iter().any(|hash| {
            hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        }) {
            return Err("EINVAL: invalid content digest".into());
        }
        let mode = match self.state.nodes.get(&path) {
            Some(Node::File { mode, .. }) if mode & 0o200 != 0 => *mode,
            Some(Node::File { .. }) => return Err("EACCES: file is not writable".into()),
            Some(_) => return Err("EISDIR: not a regular file".into()),
            None => {
                self.writable_parent(&path)?;
                0o644
            }
        };
        let existing: BTreeSet<_> = match self.state.nodes.get(&path) {
            Some(Node::File { chunks, .. }) => chunks.iter().cloned().collect(),
            _ => BTreeSet::new(),
        };
        let uploads: BTreeSet<_> = hashes
            .iter()
            .filter(|hash| !existing.contains(*hash))
            .cloned()
            .collect();
        let old = self.state.nodes.get(&path).map_or(0, Node::size);
        if self.used_bytes().saturating_sub(old).saturating_add(size) > MAX_TOTAL {
            return Err("ENOSPC: filesystem byte quota exceeded".into());
        }
        if !self.state.nodes.contains_key(&path) && self.state.nodes.len() >= MAX_NODES {
            return Err("ENOSPC: inode quota exceeded".into());
        }
        Ok(WritePlan {
            path,
            mode,
            chunks: hashes,
            uploads,
        })
    }

    fn insert(&mut self, path: String, node: Node) -> Result<(), String> {
        if !self.state.nodes.contains_key(&path) && self.state.nodes.len() >= MAX_NODES {
            return Err("ENOSPC: inode quota exceeded".into());
        }
        if let Some(meta) = self.state.metadata.get_mut(&path) {
            meta.mtime_ns = self.now;
            meta.ctime_ns = self.now;
        } else {
            if self.state.next_inode >= 9_007_199_254_740_991 {
                return Err("EOVERFLOW: inode identity exhausted".into());
            }
            self.state.metadata.insert(
                path.clone(),
                Metadata {
                    inode: self.state.next_inode,
                    uid: 0,
                    gid: 0,
                    atime_ns: self.now,
                    mtime_ns: self.now,
                    ctime_ns: self.now,
                },
            );
            self.state.next_inode += 1;
            if let Some(meta) = self.state.metadata.get_mut(parent(&path)) {
                meta.mtime_ns = self.now;
                meta.ctime_ns = self.now;
            }
        }
        self.state.nodes.insert(path, node);
        Ok(())
    }
}

#[wasm_bindgen]
impl Kernel {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest: Option<String>) -> Result<Kernel, JsValue> {
        match manifest {
            Some(json) => {
                if json.len() > 8 * 1024 * 1024 {
                    return Err(fail("EFBIG: manifest exceeds byte quota"));
                }
                let kernel = Self {
                    state: serde_json::from_str(&json)
                        .map_err(|_| fail("EINVAL: invalid manifest"))?,
                    now: 0,
                };
                kernel.validate().map_err(|e| fail(&e))?;
                Ok(kernel)
            }
            None => Ok(Self::fresh()),
        }
    }

    pub fn restore_manifest(&mut self, manifest: &str) -> Result<(), JsValue> {
        let restored = Self::new(Some(manifest.into()))?;
        self.state = restored.state;
        Ok(())
    }

    pub fn set_time(&mut self, now: u64) {
        self.now = now;
    }
    pub fn initialize_times(&mut self, now: u64) {
        self.now = now;
        for meta in self.state.metadata.values_mut() {
            meta.atime_ns = now;
            meta.mtime_ns = now;
            meta.ctime_ns = now;
        }
    }

    pub fn text_command(&self, name: &str, args: &str, stdin: &str) -> Result<String, JsValue> {
        if args.len() > 1_048_576 || stdin.len() > 2_097_152 {
            return Err(fail("EFBIG: command input exceeds byte quota"));
        }
        let args: Vec<String> =
            serde_json::from_str(args).map_err(|_| fail("EINVAL: invalid command arguments"))?;
        let output = shell::text_command(name, &args, stdin);
        serde_json::to_string(&output).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn shell_plan(&self, source: &str) -> Result<String, JsValue> {
        let plan = shell::parse(source).map_err(|error| fail(&error))?;
        serde_json::to_string(&plan).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn manifest(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.state).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn advance(&mut self) -> Result<(), JsValue> {
        self.state.generation = self
            .state
            .generation
            .checked_add(1)
            .ok_or_else(|| fail("EOVERFLOW: generation exhausted"))?;
        Ok(())
    }

    pub fn generation(&self) -> u64 {
        self.state.generation
    }

    pub fn bytes(&self) -> u64 {
        self.used_bytes()
    }

    pub fn canonical(&self, path: &str, cwd: &str) -> Result<String, JsValue> {
        normalize(path, cwd).map_err(|e| fail(&e))
    }

    pub fn stat(&self, path: &str, follow: bool) -> Result<String, JsValue> {
        let path = self.resolve(path, follow).map_err(|e| fail(&e))?;
        let node = self
            .state
            .nodes
            .get(&path)
            .ok_or_else(|| fail("ENOENT: file does not exist"))?;
        serde_json::to_string(&Stat {
            path: &path,
            kind: node.kind(),
            size: node.size(),
            mode: node.mode(),
            inode: self
                .state
                .metadata
                .get(&path)
                .ok_or_else(|| fail("EIO: missing metadata"))?
                .inode,
            uid: self
                .state
                .metadata
                .get(&path)
                .ok_or_else(|| fail("EIO: missing metadata"))?
                .uid,
            gid: self
                .state
                .metadata
                .get(&path)
                .ok_or_else(|| fail("EIO: missing metadata"))?
                .gid,
            nlink: match node {
                Node::Directory { .. } => {
                    2 + self
                        .state
                        .nodes
                        .iter()
                        .filter(|(key, node)| {
                            key.as_str() != "/"
                                && parent(key) == path
                                && matches!(node, Node::Directory { .. })
                        })
                        .count() as u64
                }
                _ => 1,
            },
            atime_ns: self
                .state
                .metadata
                .get(&path)
                .ok_or_else(|| fail("EIO: missing metadata"))?
                .atime_ns
                .to_string(),
            mtime_ns: self
                .state
                .metadata
                .get(&path)
                .ok_or_else(|| fail("EIO: missing metadata"))?
                .mtime_ns
                .to_string(),
            ctime_ns: self
                .state
                .metadata
                .get(&path)
                .ok_or_else(|| fail("EIO: missing metadata"))?
                .ctime_ns
                .to_string(),
        })
        .map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn chunks(&self, path: &str, for_write: bool) -> Result<String, JsValue> {
        let path = self.resolve(path, true).map_err(|e| fail(&e))?;
        let required = if for_write { 0o200 } else { 0o400 };
        match self.state.nodes.get(&path) {
            Some(Node::File { chunks, mode, .. }) if mode & required != 0 => {
                serde_json::to_string(chunks).map_err(|_| fail("EIO: serialization failed"))
            }
            Some(Node::File { .. }) => Err(fail("EACCES: file content access is denied")),
            Some(_) => Err(fail("EISDIR: not a regular file")),
            None => Err(fail("ENOENT: file does not exist")),
        }
    }

    pub fn prepare_write(&self, path: &str, size: u64, chunks: &str) -> Result<String, JsValue> {
        let plan = self
            .write_plan(path, size, chunks)
            .map_err(|error| fail(&error))?;
        serde_json::to_string(&plan.uploads).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn write(&mut self, path: &str, size: u64, chunks: &str) -> Result<String, JsValue> {
        let plan = self
            .write_plan(path, size, chunks)
            .map_err(|error| fail(&error))?;
        self.insert(
            plan.path,
            Node::File {
                mode: plan.mode,
                size,
                chunks: plan.chunks,
            },
        )
        .map_err(|error| fail(&error))?;
        serde_json::to_string(&plan.uploads).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn node_count(&self) -> usize {
        self.state.nodes.len()
    }

    pub fn realpath(&self, path: &str) -> Result<String, JsValue> {
        let resolved = self.resolve(path, true).map_err(|error| fail(&error))?;
        if !self.state.nodes.contains_key(&resolved) {
            return Err(fail("ENOENT: file does not exist"));
        }
        Ok(resolved)
    }

    pub fn mkdir(&mut self, path: &str, recursive: bool) -> Result<(), JsValue> {
        let path = normalize(path, "/").map_err(|e| fail(&e))?;
        if recursive && path == "/" {
            return Ok(());
        }
        let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
        let mut current = String::new();
        for (index, part) in parts.iter().enumerate() {
            current.push('/');
            current.push_str(part);
            let resolved = self.resolve(&current, true).map_err(|e| fail(&e))?;
            if let Some(node) = self.state.nodes.get(&resolved) {
                if !matches!(node, Node::Directory { .. }) {
                    return Err(fail("ENOTDIR: path is not a directory"));
                }
                if index + 1 == parts.len() && !recursive {
                    return Err(fail("EEXIST: directory exists"));
                }
                continue;
            }
            if !recursive && index + 1 != parts.len() {
                return Err(fail("ENOENT: parent does not exist"));
            }
            self.writable_parent(&resolved).map_err(|e| fail(&e))?;
            self.package_writable(&resolved, false)
                .map_err(|error| fail(&error))?;
            self.insert(resolved, Node::Directory { mode: 0o755 })
                .map_err(|e| fail(&e))?;
        }
        Ok(())
    }

    pub fn readdir(&self, path: &str) -> Result<String, JsValue> {
        let path = self.resolve(path, true).map_err(|e| fail(&e))?;
        match self.state.nodes.get(&path) {
            Some(Node::Directory { mode }) if mode & 0o500 == 0o500 => {}
            Some(Node::Directory { .. }) => return Err(fail("EACCES: directory is not readable")),
            Some(_) => return Err(fail("ENOTDIR: not a directory")),
            None => return Err(fail("ENOENT: directory does not exist")),
        }
        let entries: Vec<_> = self
            .state
            .nodes
            .iter()
            .filter(|(key, _)| key.as_str() != "/" && parent(key) == path)
            .map(|(key, value)| Entry {
                name: key.rsplit('/').next().unwrap_or_default(),
                kind: value.kind(),
                inode: self.state.metadata.get(key).map_or(0, |meta| meta.inode),
            })
            .collect();
        serde_json::to_string(&entries).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn readdir_recursive(
        &self,
        path: &str,
        max_depth: usize,
        exclude: &str,
    ) -> Result<String, JsValue> {
        let entries = self
            .walk(path, max_depth, exclude)
            .map_err(|error| fail(&error))?;
        serde_json::to_string(&entries).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn remove(&mut self, path: &str, recursive: bool) -> Result<(), JsValue> {
        let path = self.resolve(path, false).map_err(|e| fail(&e))?;
        if path == "/" {
            return Err(fail("EPERM: root cannot be removed"));
        }
        self.package_writable(&path, true)
            .map_err(|error| fail(&error))?;
        self.writable_parent(&path).map_err(|e| fail(&e))?;
        if !self.state.nodes.contains_key(&path) {
            return Err(fail("ENOENT: file does not exist"));
        }
        let prefix = format!("{path}/");
        if !recursive && self.state.nodes.keys().any(|key| key.starts_with(&prefix)) {
            return Err(fail("ENOTEMPTY: directory is not empty"));
        }
        self.state
            .metadata
            .retain(|key, _| key != &path && !key.starts_with(&prefix));
        if let Some(meta) = self.state.metadata.get_mut(parent(&path)) {
            meta.mtime_ns = self.now;
            meta.ctime_ns = self.now;
        }
        self.state
            .nodes
            .retain(|key, _| key != &path && !key.starts_with(&prefix));
        Ok(())
    }

    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), JsValue> {
        let from = self.resolve(from, false).map_err(|e| fail(&e))?;
        let to = self.resolve(to, false).map_err(|e| fail(&e))?;
        if from == "/" || to == "/" || to.starts_with(&format!("{from}/")) {
            return Err(fail("EINVAL: invalid rename destination"));
        }
        self.package_writable(&from, true)
            .map_err(|error| fail(&error))?;
        self.package_writable(&to, true)
            .map_err(|error| fail(&error))?;
        self.writable_parent(&from).map_err(|e| fail(&e))?;
        self.writable_parent(&to).map_err(|e| fail(&e))?;
        let source = self
            .state
            .nodes
            .get(&from)
            .ok_or_else(|| fail("ENOENT: source does not exist"))?;
        if from == to {
            return Ok(());
        }
        if let Some(destination) = self.state.nodes.get(&to) {
            if matches!(source, Node::Directory { .. })
                != matches!(destination, Node::Directory { .. })
            {
                if matches!(source, Node::Directory { .. }) {
                    return Err(fail("ENOTDIR: rename destination is not a directory"));
                }
                return Err(fail("EISDIR: rename destination is a directory"));
            }
            if self
                .state
                .nodes
                .keys()
                .any(|key| key.starts_with(&format!("{to}/")))
            {
                return Err(fail("ENOTEMPTY: destination directory is not empty"));
            }
        }
        let keys: BTreeSet<_> = self
            .state
            .nodes
            .keys()
            .filter(|key| **key == from || key.starts_with(&format!("{from}/")))
            .cloned()
            .collect();
        let moved: Vec<_> = keys
            .iter()
            .filter_map(|key| {
                self.state.nodes.remove(key).map(|node| {
                    (
                        format!("{to}{}", key.strip_prefix(&from).unwrap_or_default()),
                        node,
                    )
                })
            })
            .collect();
        let moved_metadata: Vec<_> = keys
            .iter()
            .filter_map(|key| {
                self.state.metadata.remove(key).map(|mut meta| {
                    meta.ctime_ns = self.now;
                    (
                        format!("{to}{}", key.strip_prefix(&from).unwrap_or_default()),
                        meta,
                    )
                })
            })
            .collect();
        self.state.metadata.extend(moved_metadata);
        for path in [parent(&from), parent(&to)] {
            if let Some(meta) = self.state.metadata.get_mut(path) {
                meta.mtime_ns = self.now;
                meta.ctime_ns = self.now;
            }
        }
        self.state.nodes.extend(moved);
        Ok(())
    }

    pub fn symlink(&mut self, target: &str, path: &str) -> Result<(), JsValue> {
        let path = self.resolve(path, false).map_err(|e| fail(&e))?;
        self.package_writable(&path, false)
            .map_err(|error| fail(&error))?;
        normalize(target, parent(&path)).map_err(|e| fail(&e))?;
        self.writable_parent(&path).map_err(|e| fail(&e))?;
        if self.state.nodes.contains_key(&path) {
            return Err(fail("EEXIST: destination exists"));
        }
        self.insert(
            path,
            Node::Symlink {
                target: target.into(),
            },
        )
        .map_err(|e| fail(&e))
    }

    pub fn readlink(&self, path: &str) -> Result<String, JsValue> {
        let path = self.resolve(path, false).map_err(|e| fail(&e))?;
        match self.state.nodes.get(&path) {
            Some(Node::Symlink { target }) => Ok(target.clone()),
            Some(_) => Err(fail("EINVAL: not a symlink")),
            None => Err(fail("ENOENT: symlink does not exist")),
        }
    }

    pub fn set_times(
        &mut self,
        path: &str,
        follow: bool,
        atime: u64,
        mtime: u64,
        flags: u32,
    ) -> Result<(), JsValue> {
        if flags & !15 != 0 || flags & 3 == 3 || flags & 12 == 12 {
            return Err(fail("EINVAL: invalid timestamp flags"));
        }
        let path = self.resolve(path, follow).map_err(|error| fail(&error))?;
        self.package_writable(&path, false)
            .map_err(|error| fail(&error))?;
        let metadata = self
            .state
            .metadata
            .get_mut(&path)
            .ok_or_else(|| fail("ENOENT: file does not exist"))?;
        if flags == 0 {
            return Ok(());
        }
        if flags & 1 != 0 {
            metadata.atime_ns = atime;
        }
        if flags & 2 != 0 {
            metadata.atime_ns = self.now;
        }
        if flags & 4 != 0 {
            metadata.mtime_ns = mtime;
        }
        if flags & 8 != 0 {
            metadata.mtime_ns = self.now;
        }
        metadata.ctime_ns = self.now;
        Ok(())
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> Result<(), JsValue> {
        if mode > 0o777 {
            return Err(fail("EINVAL: invalid permission mode"));
        }
        let path = self.resolve(path, true).map_err(|e| fail(&e))?;
        self.package_writable(&path, false)
            .map_err(|error| fail(&error))?;
        match self.state.nodes.get_mut(&path) {
            Some(Node::File { mode: current, .. } | Node::Directory { mode: current }) => {
                *current = mode;
                if let Some(meta) = self.state.metadata.get_mut(&path) {
                    meta.ctime_ns = self.now;
                }
                Ok(())
            }
            _ => Err(fail("ENOENT: file does not exist")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_flags_preserve_identity_and_unselected_fields() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.initialize_times(10);
        kernel.set_time(20);
        kernel
            .set_times("/tmp", true, u64::MAX, 100, 1)
            .map_err(|_| "timestamp update failed")?;
        let metadata = kernel.state.metadata.get("/tmp").ok_or("missing inode")?;
        assert_eq!(metadata.inode, 4);
        assert_eq!(metadata.atime_ns, u64::MAX);
        assert_eq!(metadata.mtime_ns, 10);
        assert_eq!(metadata.ctime_ns, 20);
        let before = serde_json::to_string(&kernel.state).map_err(|error| error.to_string())?;
        kernel.set_time(30);
        kernel
            .set_times("/tmp", true, 0, 0, 0)
            .map_err(|_| "timestamp no-op failed")?;
        assert_eq!(
            serde_json::to_string(&kernel.state).map_err(|error| error.to_string())?,
            before
        );
        kernel
            .set_times("/tmp", true, 0, 0, 10)
            .map_err(|_| "timestamp NOW failed")?;
        let metadata = kernel.state.metadata.get("/tmp").ok_or("missing inode")?;
        assert_eq!(
            (metadata.atime_ns, metadata.mtime_ns, metadata.ctime_ns),
            (30, 30, 30)
        );
        kernel.validate()?;
        Ok(())
    }

    #[test]
    fn write_preparation_is_pure_and_rejects_before_mutation() -> Result<(), String> {
        let kernel = Kernel::fresh();
        let before = kernel.state.nodes.clone();
        let chunks =
            serde_json::to_string(&vec!["a".repeat(64)]).map_err(|error| error.to_string())?;
        let plan = kernel.write_plan("/tmp/file", 1, &chunks)?;
        assert_eq!(plan.path, "/tmp/file");
        assert_eq!(plan.uploads.len(), 1);
        assert_eq!(kernel.state.nodes, before);
        assert!(kernel.write_plan("/tmp/file", 1, "[]").is_err());
        assert_eq!(kernel.state.nodes, before);
        Ok(())
    }

    #[test]
    fn paths_are_rooted_and_bounded() -> Result<(), String> {
        assert_eq!(normalize("../../etc/../x", "/home/cirro")?, "/x");
        assert_eq!(normalize("./a//b", "/tmp")?, "/tmp/a/b");
        assert!(normalize("x\0y", "/").is_err());
        assert!(normalize(&"a/".repeat(65), "/").is_err());
        Ok(())
    }

    #[test]
    fn manifest_round_trip_and_symlink_resolution() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.insert(
            "/home/cirro/link".into(),
            Node::Symlink {
                target: "/tmp".into(),
            },
        )?;
        assert_eq!(kernel.resolve("/home/cirro/link/file", true)?, "/tmp/file");
        let data = serde_json::to_string(&kernel.state).map_err(|e| e.to_string())?;
        let restored = Kernel {
            state: serde_json::from_str(&data).map_err(|e| e.to_string())?,
            now: 0,
        };
        restored.validate()?;
        assert_eq!(restored.state.nodes, kernel.state.nodes);
        Ok(())
    }

    #[test]
    fn corrupt_chunks_and_orphans_are_rejected() {
        let mut kernel = Kernel::fresh();
        kernel.state.nodes.insert(
            "/tmp/x".into(),
            Node::File {
                size: 1,
                mode: 0o644,
                chunks: vec!["a".into()],
            },
        );
        assert!(kernel.validate().is_err());
        kernel.state.nodes.remove("/tmp/x");
        kernel
            .state
            .nodes
            .insert("/missing/x".into(), Node::Directory { mode: 0o755 });
        assert!(kernel.validate().is_err());
    }

    #[test]
    fn symlink_cycles_are_bounded() {
        let mut kernel = Kernel::fresh();
        kernel
            .state
            .nodes
            .insert("/tmp/a".into(), Node::Symlink { target: "b".into() });
        kernel
            .state
            .nodes
            .insert("/tmp/b".into(), Node::Symlink { target: "a".into() });
        assert!(kernel.resolve("/tmp/a", true).is_err());
    }

    #[test]
    fn inode_and_byte_quotas_have_exact_boundaries() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        for index in 0..MAX_NODES - kernel.state.nodes.len() {
            kernel.insert(format!("/tmp/{index}"), Node::Directory { mode: 0o755 })?;
        }
        kernel.validate()?;
        assert!(
            kernel
                .insert("/tmp/overflow".into(), Node::Directory { mode: 0o755 })
                .is_err()
        );
        let mut kernel = Kernel::fresh();
        for index in 0..4 {
            kernel.insert(
                format!("/tmp/{index}"),
                Node::File {
                    mode: 0o644,
                    size: MAX_FILE,
                    chunks: vec!["a".repeat(64); 64],
                },
            )?;
        }
        kernel.validate()?;
        kernel.insert(
            "/tmp/overflow".into(),
            Node::File {
                mode: 0o644,
                size: 1,
                chunks: vec!["a".repeat(64)],
            },
        )?;
        assert!(kernel.validate().is_err());
        Ok(())
    }
}
