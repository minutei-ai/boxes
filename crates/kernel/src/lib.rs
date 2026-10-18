mod shell;
pub use shell::Shell;
mod memory;
mod software;
pub use memory::{pack_memory, unpack_memory};

use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

const MAX_NODES: usize = 16_384;
const MAX_MANIFEST: usize = 8 * 1024 * 1024;
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
    nodes: BTreeMap<String, u64>,
    inodes: BTreeMap<u64, Inode>,
    next_inode: u64,
    packages: Vec<software::Installed>,
    links: BTreeMap<String, software::Link>,
    shared_chunks: BTreeSet<String>,
    retainers: BTreeMap<String, Retainer>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Retainer {
    generation: u64,
    inodes: BTreeMap<u64, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriorInodeFilesystem {
    version: u32,
    generation: u64,
    nodes: BTreeMap<String, u64>,
    inodes: BTreeMap<u64, Inode>,
    next_inode: u64,
    packages: Vec<software::Installed>,
    links: BTreeMap<String, software::Link>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inode {
    node: Node,
    metadata: Metadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriorFilesystem {
    version: u32,
    generation: u64,
    nodes: BTreeMap<String, Node>,
    metadata: BTreeMap<String, Metadata>,
    next_inode: u64,
    packages: Vec<software::Installed>,
    links: BTreeMap<String, software::Link>,
}

impl Inode {
    fn stat<'a>(&'a self, path: &'a str, nlink: u64) -> Stat<'a> {
        Stat {
            path,
            kind: self.node.kind(),
            size: self.node.size(),
            mode: self.node.mode(),
            inode: self.metadata.inode,
            uid: self.metadata.uid,
            gid: self.metadata.gid,
            nlink,
            atime_ns: self.metadata.atime_ns.to_string(),
            mtime_ns: self.metadata.mtime_ns.to_string(),
            ctime_ns: self.metadata.ctime_ns.to_string(),
        }
    }
}

impl Manifest {
    fn node(&self, path: &str) -> Option<&Node> {
        self.nodes
            .get(path)
            .and_then(|id| self.inodes.get(id))
            .map(|inode| &inode.node)
    }

    fn node_mut(&mut self, path: &str) -> Option<&mut Node> {
        let id = *self.nodes.get(path)?;
        self.inodes.get_mut(&id).map(|inode| &mut inode.node)
    }

    fn metadata(&self, path: &str) -> Option<&Metadata> {
        self.nodes
            .get(path)
            .and_then(|id| self.inodes.get(id))
            .map(|inode| &inode.metadata)
    }

    fn metadata_mut(&mut self, path: &str) -> Option<&mut Metadata> {
        let id = *self.nodes.get(path)?;
        self.inodes.get_mut(&id).map(|inode| &mut inode.metadata)
    }

    fn entries(&self) -> impl Iterator<Item = (&String, &Node)> {
        self.nodes
            .iter()
            .filter_map(|(path, id)| self.inodes.get(id).map(|inode| (path, &inode.node)))
    }

    fn entries_from(&self, prefix: String) -> impl Iterator<Item = (&String, &Node)> {
        self.nodes
            .range(prefix..)
            .filter_map(|(path, id)| self.inodes.get(id).map(|inode| (path, &inode.node)))
    }

    fn retain_linked(&mut self) {
        let linked: BTreeSet<_> = self.nodes.values().copied().collect();
        let retained: BTreeSet<_> = self
            .retainers
            .values()
            .flat_map(|owner| owner.inodes.keys().copied())
            .collect();
        self.inodes
            .retain(|id, _| linked.contains(id) || retained.contains(id));
    }

    fn from_prior(prior: PriorFilesystem) -> Result<Self, String> {
        if prior.version != 3 || prior.nodes.keys().ne(prior.metadata.keys()) {
            return Err("EINVAL: prior inode paths do not match".into());
        }
        let mut nodes = BTreeMap::new();
        let mut inodes = BTreeMap::new();
        for (path, node) in prior.nodes {
            let metadata = prior
                .metadata
                .get(&path)
                .ok_or("EINVAL: missing prior metadata")?
                .clone();
            let id = metadata.inode;
            if inodes.insert(id, Inode { node, metadata }).is_some() {
                return Err("EINVAL: duplicate prior inode identity".into());
            }
            nodes.insert(path, id);
        }
        Ok(Self {
            version: 6,
            generation: prior.generation,
            nodes,
            inodes,
            next_inode: prior.next_inode,
            packages: prior.packages,
            links: prior.links,
            shared_chunks: BTreeSet::new(),
            retainers: BTreeMap::new(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentBlock<'a> {
    hash: &'a str,
    size: u64,
    shared: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadPlan<'a> {
    blocks: Vec<ContentBlock<'a>>,
    skip: u64,
    length: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchBlock<'a> {
    index: usize,
    size: u64,
    previous: Option<ContentBlock<'a>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RangeWritePlan<'a> {
    path: &'a str,
    offset: u64,
    size: u64,
    changed: bool,
    chunks: Vec<Option<&'a str>>,
    blocks: Vec<PatchBlock<'a>>,
}

enum FileMutation {
    Write { offset: Option<u64>, length: u64 },
    Resize { size: u64 },
}

#[derive(Debug, PartialEq)]
enum FileTarget {
    Path(String),
    Inode(u64),
}

struct WritePlan {
    target: FileTarget,
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
pub struct CommandResult {
    output: shell::Output,
}

#[wasm_bindgen]
impl CommandResult {
    #[wasm_bindgen(getter)]
    pub fn stdout(&self) -> Vec<u8> {
        self.output.stdout.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn stderr(&self) -> Vec<u8> {
        self.output.stderr.clone()
    }

    #[wasm_bindgen(getter, js_name = exitCode)]
    pub fn exit_code(&self) -> i32 {
        self.output.exit_code
    }
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct Kernel {
    state: Manifest,
    now: u64,
    snapshot_import: bool,
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
    let mut value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| fail("EINVAL: invalid manifest"))?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    if version == Some(6) {
        return Kernel::new(Some(json.into()))?.manifest();
    }
    if version == Some(5) {
        let fields = value
            .as_object_mut()
            .ok_or_else(|| fail("EINVAL: invalid prior manifest"))?;
        if fields.contains_key("retainers") {
            return Err(fail("EINVAL: unexpected prior retainers"));
        }
        fields.insert("version".into(), serde_json::json!(6));
        fields.insert("retainers".into(), serde_json::json!({}));
        let encoded = serde_json::to_string(&value)
            .map_err(|_| fail("EIO: manifest serialization failed"))?;
        return Kernel::new(Some(encoded))?.manifest();
    }
    if version == Some(4) {
        let prior: PriorInodeFilesystem = serde_json::from_value(value)
            .map_err(|_| fail("EINVAL: invalid prior inode manifest"))?;
        if prior.version != 4 {
            return Err(fail("EINVAL: invalid prior inode version"));
        }
        let kernel = Kernel {
            state: Manifest {
                version: 6,
                generation: prior.generation,
                nodes: prior.nodes,
                inodes: prior.inodes,
                next_inode: prior.next_inode,
                packages: prior.packages,
                links: prior.links,
                shared_chunks: BTreeSet::new(),
                retainers: BTreeMap::new(),
            },
            now: 0,
            snapshot_import: false,
        };
        kernel.validate().map_err(|error| fail(&error))?;
        return kernel.manifest();
    }
    let prior = match version {
        Some(3) => serde_json::from_value(value).map_err(|_| fail("EINVAL: invalid manifest"))?,
        Some(2) => {
            let prior: PriorMetadataManifest = serde_json::from_value(value)
                .map_err(|_| fail("EINVAL: invalid prior metadata manifest"))?;
            if prior.version != 2 {
                return Err(fail("EINVAL: invalid prior metadata version"));
            }
            PriorFilesystem {
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
            PriorFilesystem {
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
    let kernel = Kernel {
        state: Manifest::from_prior(prior).map_err(|error| fail(&error))?,
        now: 0,
        snapshot_import: false,
    };
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
    fn file_plan(&self, path: &str, mutation: FileMutation) -> Result<String, JsValue> {
        let path = self.resolve(path, true).map_err(|error| fail(&error))?;
        self.file_plan_target(FileTarget::Path(path), mutation)
    }

    fn file_plan_target(
        &self,
        target: FileTarget,
        mutation: FileMutation,
    ) -> Result<String, JsValue> {
        let (path, node) = self.file_target(&target).map_err(|error| fail(&error))?;
        let old_size = node.map_or(0, Node::size);
        let exists = node.is_some();
        let (offset, length, size, changed) = match mutation {
            FileMutation::Write { offset, length } => {
                let offset = offset.unwrap_or(old_size);
                let size = if length == 0 {
                    old_size
                } else {
                    offset
                        .checked_add(length)
                        .ok_or_else(|| fail("EFBIG: write position overflow"))?
                        .max(old_size)
                };
                (offset, length, size, length != 0 || !exists)
            }
            FileMutation::Resize { size } => {
                if !exists {
                    return Err(fail("ENOENT: file does not exist"));
                }
                (0, 0, size, true)
            }
        };
        if size > MAX_FILE {
            return Err(fail("EFBIG: file limit exceeded"));
        }
        let old = match node {
            Some(Node::File { chunks, .. }) => chunks.as_slice(),
            _ => &[],
        };
        let mut chunks = Vec::new();
        let mut blocks = Vec::new();
        for index in 0..size.div_ceil(262_144) {
            let start = index * 262_144;
            let block_size = (size - start).min(262_144);
            let previous = old.get(index as usize).map(|hash| ContentBlock {
                hash,
                size: (old_size - start).min(262_144),
                shared: self.state.shared_chunks.contains(hash),
            });
            let overlaps = length != 0 && start < offset + length && start + block_size > offset;
            let resize = previous
                .as_ref()
                .is_none_or(|block| block.size != block_size);
            if overlaps || resize {
                chunks.push(None);
                blocks.push(PatchBlock {
                    index: index as usize,
                    size: block_size,
                    previous,
                });
            } else {
                chunks.push(previous.map(|block| block.hash));
            }
        }
        let private_size = chunks
            .iter()
            .enumerate()
            .filter(|(_, hash)| {
                hash.as_ref()
                    .map_or(self.state.shared_chunks.is_empty(), |hash| {
                        !self.state.shared_chunks.contains(*hash)
                    })
            })
            .map(|(index, _)| (size - index as u64 * 262_144).min(262_144))
            .sum();
        self.admit_file_write(&target, private_size)
            .map_err(|error| fail(&error))?;
        serde_json::to_string(&RangeWritePlan {
            path,
            offset,
            size,
            changed,
            chunks,
            blocks,
        })
        .map_err(|error| fail(&error.to_string()))
    }

    fn read_plan_resolved(
        &self,
        path: &str,
        offset: u64,
        length: u64,
        for_write: bool,
        descriptor: bool,
    ) -> Result<String, JsValue> {
        let node = self
            .state
            .node(path)
            .ok_or_else(|| fail("ENOENT: file does not exist"))?;
        self.read_node_plan(node, offset, length, for_write, descriptor)
    }

    fn read_node_plan(
        &self,
        node: &Node,
        offset: u64,
        length: u64,
        for_write: bool,
        descriptor: bool,
    ) -> Result<String, JsValue> {
        let required = if for_write { 0o200 } else { 0o400 };
        let (size, chunks) = match node {
            Node::File { size, chunks, mode } if descriptor || mode & required != 0 => {
                (*size, chunks)
            }
            Node::File { .. } => return Err(fail("EACCES: file content access is denied")),
            _ => return Err(fail("EISDIR: not a regular file")),
        };
        let length = length.min(size.saturating_sub(offset));
        let mut blocks = Vec::new();
        if length != 0 {
            for index in offset / 262_144..(offset + length).div_ceil(262_144) {
                blocks.push(ContentBlock {
                    hash: &chunks[index as usize],
                    size: (size - index * 262_144).min(262_144),
                    shared: self.state.shared_chunks.contains(&chunks[index as usize]),
                });
            }
        }
        serde_json::to_string(&ReadPlan {
            blocks,
            skip: offset % 262_144,
            length,
        })
        .map_err(|error| fail(&error.to_string()))
    }

    fn set_times_resolved(
        &mut self,
        path: &str,
        atime: u64,
        mtime: u64,
        flags: u32,
    ) -> Result<(), JsValue> {
        if flags & !15 != 0 || flags & 3 == 3 || flags & 12 == 12 {
            return Err(fail("EINVAL: invalid timestamp flags"));
        }
        self.package_writable(path, false)
            .map_err(|error| fail(&error))?;
        let metadata = self
            .state
            .metadata_mut(path)
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

    fn commit_write(&mut self, plan: WritePlan, size: u64) -> Result<String, JsValue> {
        let node = Node::File {
            mode: plan.mode,
            size,
            chunks: plan.chunks,
        };
        match plan.target {
            FileTarget::Path(path) => self.insert(path, node).map_err(|error| fail(&error))?,
            FileTarget::Inode(id) => {
                let inode = self
                    .state
                    .inodes
                    .get_mut(&id)
                    .ok_or_else(|| fail("ENOENT: inode does not exist"))?;
                inode.node = node;
                inode.metadata.mtime_ns = self.now;
                inode.metadata.ctime_ns = self.now;
            }
        }
        serde_json::to_string(&plan.uploads).map_err(|_| fail("EIO: serialization failed"))
    }

    fn stat_resolved(&self, path: &str) -> Result<String, JsValue> {
        let node = self
            .state
            .node(path)
            .ok_or_else(|| fail("ENOENT: file does not exist"))?;
        let metadata = self
            .state
            .metadata(path)
            .ok_or_else(|| fail("EIO: missing metadata"))?;
        let nlink = match node {
            Node::Directory { .. } => {
                2 + self
                    .state
                    .entries()
                    .filter(|(key, node)| {
                        key.as_str() != "/"
                            && parent(key) == path
                            && matches!(node, Node::Directory { .. })
                    })
                    .count() as u64
            }
            _ => self
                .state
                .nodes
                .values()
                .filter(|id| **id == metadata.inode)
                .count() as u64,
        };
        serde_json::to_string(&self.stat_record(path, nlink)?)
            .map_err(|_| fail("EIO: serialization failed"))
    }

    fn stat_record<'a>(&'a self, path: &'a str, nlink: u64) -> Result<Stat<'a>, JsValue> {
        self.state
            .nodes
            .get(path)
            .and_then(|inode| self.state.inodes.get(inode))
            .map(|inode| inode.stat(path, nlink))
            .ok_or_else(|| fail("ENOENT: file does not exist"))
    }

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
        match self.state.node(&root) {
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
        for (key, node) in self.state.entries_from(prefix.clone()) {
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
        let mut nodes = BTreeMap::new();
        let mut inodes = BTreeMap::new();
        for (index, (path, node)) in [
            ("/", Node::Directory { mode: 0o755 }),
            ("/home", Node::Directory { mode: 0o755 }),
            ("/home/cirro", Node::Directory { mode: 0o755 }),
            ("/tmp", Node::Directory { mode: 0o777 }),
        ]
        .into_iter()
        .enumerate()
        {
            let id = index as u64 + 1;
            nodes.insert(path.into(), id);
            inodes.insert(
                id,
                Inode {
                    node,
                    metadata: Metadata {
                        inode: id,
                        uid: 0,
                        gid: 0,
                        atime_ns: 0,
                        mtime_ns: 0,
                        ctime_ns: 0,
                    },
                },
            );
        }
        Self {
            state: Manifest {
                version: 6,
                generation: 0,
                nodes,
                inodes,
                next_inode: 5,
                packages: Vec::new(),
                links: BTreeMap::new(),
                shared_chunks: BTreeSet::new(),
                retainers: BTreeMap::new(),
            },
            now: 0,
            snapshot_import: false,
        }
    }

    fn resolve(&self, path: &str, follow_last: bool) -> Result<String, String> {
        let mut pending = normalize(path, "/")?;
        if pending != "/"
            && matches!(self.state.node("/"), Some(Node::Directory { mode }) if mode & 0o100 == 0)
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
                match self.state.node(&prefix) {
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
        match self.state.node(parent(path)) {
            Some(Node::Directory { mode }) if mode & 0o300 == 0o300 => Ok(()),
            Some(Node::Directory { .. }) => Err("EACCES: parent is not writable".into()),
            Some(_) => Err("ENOTDIR: parent is not a directory".into()),
            None => Err("ENOENT: parent does not exist".into()),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.state.version != 6
            || self.state.nodes.len() > MAX_NODES
            || self.state.inodes.len() > MAX_NODES
            || self.state.shared_chunks.len() > MAX_NODES * 2
            || self.state.shared_chunks.iter().any(|hash| {
                hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err("EINVAL: invalid manifest version or node count".into());
        }
        if !matches!(self.state.node("/"), Some(Node::Directory { .. })) {
            return Err("EINVAL: root must be a directory".into());
        }
        let mut linked = BTreeMap::<u64, usize>::new();
        for id in self.state.nodes.values() {
            if !self.state.inodes.contains_key(id) {
                return Err("EINVAL: missing inode".into());
            }
            *linked.entry(*id).or_default() += 1;
        }
        if self.state.retainers.len() > MAX_NODES
            || self
                .state
                .retainers
                .values()
                .map(|retainer| retainer.inodes.len())
                .sum::<usize>()
                > MAX_NODES
        {
            return Err("ENOSPC: inode retainer quota exceeded".into());
        }
        let mut retained = BTreeSet::new();
        for (owner, retainer) in &self.state.retainers {
            if owner.is_empty()
                || owner.len() > 256
                || retainer.inodes.is_empty()
                || retainer.inodes.len() > 125
            {
                return Err("EINVAL: invalid inode retainer".into());
            }
            for (id, path) in &retainer.inodes {
                if normalize(path, "/")? != *path
                    || !matches!(
                        self.state.inodes.get(id).map(|inode| &inode.node),
                        Some(Node::File { .. })
                    )
                {
                    return Err("EINVAL: invalid retained inode".into());
                }
                retained.insert(*id);
            }
        }
        if self
            .state
            .inodes
            .keys()
            .any(|id| !linked.contains_key(id) && !retained.contains(id))
        {
            return Err("EINVAL: unlinked persisted inode".into());
        }
        for (id, inode) in &self.state.inodes {
            if *id == 0 || *id >= self.state.next_inode || inode.metadata.inode != *id {
                return Err("EINVAL: invalid inode identity".into());
            }
            if matches!(inode.node, Node::Directory { .. }) && linked.get(id) != Some(&1) {
                return Err("EINVAL: directory hard links are forbidden".into());
            }
            let node = &inode.node;
            if node.mode() > 0o777 {
                return Err("EINVAL: invalid inode mode".into());
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
        }
        for (path, node) in self.state.entries() {
            if normalize(path, "/")? != *path || node.mode() > 0o777 {
                return Err("EINVAL: noncanonical manifest path or mode".into());
            }
            if path != "/" && !matches!(self.state.node(parent(path)), Some(Node::Directory { .. }))
            {
                return Err("EINVAL: orphaned node".into());
            }
            if let Node::Symlink { target } = node {
                normalize(target, parent(path))?;
            }
        }
        self.validate_packages()?;
        if self.private_bytes() > MAX_TOTAL {
            return Err("ENOSPC: filesystem byte quota exceeded".into());
        }
        Ok(())
    }

    fn used_bytes(&self) -> u64 {
        self.state
            .inodes
            .values()
            .map(|inode| match inode.node {
                Node::File { size, .. } => size,
                _ => 0,
            })
            .sum()
    }

    fn private_file_bytes(&self, node: &Node) -> u64 {
        match node {
            Node::File { size, chunks, .. } => chunks
                .iter()
                .enumerate()
                .filter(|(_, hash)| !self.state.shared_chunks.contains(*hash))
                .map(|(index, _)| size.saturating_sub(index as u64 * 262_144).min(262_144))
                .sum(),
            _ => 0,
        }
    }

    fn private_bytes(&self) -> u64 {
        self.state
            .inodes
            .values()
            .map(|inode| self.private_file_bytes(&inode.node))
            .sum()
    }

    fn writable_file(&self, path: &str, private_size: u64) -> Result<u32, String> {
        let mode = match self.state.node(path) {
            Some(Node::File { mode, .. }) if mode & 0o200 != 0 => *mode,
            Some(Node::File { .. }) => return Err("EACCES: file is not writable".into()),
            Some(_) => return Err("EISDIR: not a regular file".into()),
            None => {
                self.writable_parent(path)?;
                0o644
            }
        };
        let old = self
            .state
            .node(path)
            .map_or(0, |node| self.private_file_bytes(node));
        if self
            .private_bytes()
            .saturating_sub(old)
            .saturating_add(private_size)
            > MAX_TOTAL
        {
            return Err("ENOSPC: filesystem byte quota exceeded".into());
        }
        if !self.state.nodes.contains_key(path)
            && (self.state.nodes.len() >= MAX_NODES || self.state.inodes.len() >= MAX_NODES)
        {
            return Err("ENOSPC: inode quota exceeded".into());
        }
        Ok(mode)
    }

    fn file_target<'a>(
        &'a self,
        target: &'a FileTarget,
    ) -> Result<(&'a str, Option<&'a Node>), String> {
        match target {
            FileTarget::Path(path) => {
                self.package_writable(path, false)?;
                Ok((path, self.state.node(path)))
            }
            FileTarget::Inode(id) => {
                let inode = self
                    .state
                    .inodes
                    .get(id)
                    .ok_or("ENOENT: inode does not exist")?;
                if let Some((path, _)) = self.state.nodes.iter().find(|(_, value)| **value == *id) {
                    self.package_writable(path, false)?;
                    return Ok((path, Some(&inode.node)));
                }
                let path = self
                    .state
                    .retainers
                    .values()
                    .find_map(|retainer| retainer.inodes.get(id))
                    .ok_or("ENOENT: inode has no live owner")?;
                Ok((path, Some(&inode.node)))
            }
        }
    }

    fn admit_file_write(&self, target: &FileTarget, private_size: u64) -> Result<u32, String> {
        match target {
            FileTarget::Path(path) => self.writable_file(path, private_size),
            FileTarget::Inode(_) => {
                let (_, node) = self.file_target(target)?;
                let node = node.ok_or("ENOENT: inode does not exist")?;
                let Node::File { mode, .. } = node else {
                    return Err("EISDIR: not a regular file".into());
                };
                if self
                    .private_bytes()
                    .saturating_sub(self.private_file_bytes(node))
                    .saturating_add(private_size)
                    > MAX_TOTAL
                {
                    return Err("ENOSPC: filesystem byte quota exceeded".into());
                }
                Ok(*mode)
            }
        }
    }

    fn write_plan(&self, path: &str, size: u64, chunks: &str) -> Result<WritePlan, String> {
        let path = self.resolve(path, true)?;
        self.write_plan_target(FileTarget::Path(path), size, chunks)
    }

    fn write_plan_target(
        &self,
        target: FileTarget,
        size: u64,
        chunks: &str,
    ) -> Result<WritePlan, String> {
        let (_, node) = self.file_target(&target)?;
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
        let private_size = self.private_file_bytes(&Node::File {
            mode: 0,
            size,
            chunks: hashes.clone(),
        });
        let mode = self.admit_file_write(&target, private_size)?;
        let existing: BTreeSet<_> = match node {
            Some(Node::File { chunks, .. }) => chunks.iter().cloned().collect(),
            _ => BTreeSet::new(),
        };
        let uploads: BTreeSet<_> = hashes
            .iter()
            .filter(|hash| !existing.contains(*hash) && !self.state.shared_chunks.contains(*hash))
            .cloned()
            .collect();
        Ok(WritePlan {
            target,
            mode,
            chunks: hashes,
            uploads,
        })
    }

    fn link_path(&mut self, source: &str, destination: &str, follow: bool) -> Result<(), String> {
        let source = self.resolve(source, follow)?;
        match self.state.node(&source) {
            Some(Node::Directory { .. }) => {
                return Err("EPERM: directory hard links are forbidden".into());
            }
            Some(_) => {}
            None => return Err("ENOENT: source does not exist".into()),
        }
        self.package_path_writable(&source, false)?;
        let destination = self.resolve(destination, false)?;
        self.package_path_writable(&destination, false)?;
        self.writable_parent(&destination)?;
        if self.state.nodes.contains_key(&destination) {
            return Err("EEXIST: destination exists".into());
        }
        if self.state.nodes.len() >= MAX_NODES {
            return Err("ENOSPC: directory entry quota exceeded".into());
        }
        let id = *self
            .state
            .nodes
            .get(&source)
            .ok_or("EIO: missing source inode")?;
        if let Some(inode) = self.state.inodes.get_mut(&id) {
            inode.metadata.ctime_ns = self.now;
        }
        if let Some(metadata) = self.state.metadata_mut(parent(&destination)) {
            metadata.mtime_ns = self.now;
            metadata.ctime_ns = self.now;
        }
        self.state.nodes.insert(destination, id);
        Ok(())
    }

    fn insert(&mut self, path: String, node: Node) -> Result<(), String> {
        if let Some(id) = self.state.nodes.get(&path) {
            let inode = self.state.inodes.get_mut(id).ok_or("EIO: missing inode")?;
            inode.node = node;
            inode.metadata.mtime_ns = self.now;
            inode.metadata.ctime_ns = self.now;
            return Ok(());
        }
        if self.state.nodes.len() >= MAX_NODES || self.state.inodes.len() >= MAX_NODES {
            return Err("ENOSPC: inode quota exceeded".into());
        }
        if self.state.next_inode >= 9_007_199_254_740_991 {
            return Err("EOVERFLOW: inode identity exhausted".into());
        }
        let id = self.state.next_inode;
        self.state.next_inode += 1;
        self.state.inodes.insert(
            id,
            Inode {
                node,
                metadata: Metadata {
                    inode: id,
                    uid: 0,
                    gid: 0,
                    atime_ns: self.now,
                    mtime_ns: self.now,
                    ctime_ns: self.now,
                },
            },
        );
        if let Some(meta) = self.state.metadata_mut(parent(&path)) {
            meta.mtime_ns = self.now;
            meta.ctime_ns = self.now;
        }
        self.state.nodes.insert(path, id);
        Ok(())
    }
}

#[wasm_bindgen]
impl Kernel {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest: Option<String>) -> Result<Kernel, JsValue> {
        match manifest {
            Some(json) => {
                if json.len() > MAX_MANIFEST {
                    return Err(fail("EFBIG: manifest exceeds byte quota"));
                }
                let kernel = Self {
                    state: serde_json::from_str(&json)
                        .map_err(|_| fail("EINVAL: invalid manifest"))?,
                    now: 0,
                    snapshot_import: false,
                };
                kernel.validate().map_err(|e| fail(&e))?;
                Ok(kernel)
            }
            None => Ok(Self::fresh()),
        }
    }

    pub fn initialize_snapshot_root(&mut self) -> Result<(), JsValue> {
        if self.state.generation != 0
            || !self.state.packages.is_empty()
            || !self.state.links.is_empty()
            || !self.state.retainers.is_empty()
        {
            return Err(fail(
                "EPERM: snapshot initialization requires a fresh kernel",
            ));
        }
        self.state.nodes.retain(|path, _| path == "/");
        self.state.retain_linked();
        self.state.next_inode = 2;
        Ok(())
    }

    pub fn retained_shared_blocks(&self) -> Result<String, JsValue> {
        let retained: BTreeSet<_> = self
            .state
            .retainers
            .values()
            .flat_map(|retainer| retainer.inodes.keys().copied())
            .collect();
        let mut blocks = BTreeMap::new();
        for id in retained {
            let inode = self
                .state
                .inodes
                .get(&id)
                .ok_or_else(|| fail("EIO: retained inode missing"))?;
            if let Node::File { size, chunks, .. } = &inode.node {
                for (index, hash) in chunks.iter().enumerate() {
                    if self.state.shared_chunks.contains(hash) {
                        let length = size.saturating_sub(index as u64 * 262_144).min(262_144);
                        if blocks
                            .insert(hash.as_str(), length)
                            .is_some_and(|previous| previous != length)
                        {
                            return Err(fail("EIO: inconsistent retained block length"));
                        }
                    }
                }
            }
        }
        let references: Vec<_> = blocks
            .into_iter()
            .map(|(hash, size)| ContentBlock {
                hash,
                size,
                shared: true,
            })
            .collect();
        serde_json::to_string(&references).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn reset_snapshot_root(&mut self) -> Result<(), JsValue> {
        self.snapshot_import = true;
        self.state.nodes.retain(|path, _| path == "/");
        self.state.retain_linked();
        if let Some(node) = self.state.node_mut("/") {
            *node = Node::Directory { mode: 0o755 };
        }
        self.state.packages.clear();
        self.state.links.clear();
        self.state.shared_chunks.clear();
        Ok(())
    }

    pub fn finish_snapshot_root(&mut self) -> Result<(), JsValue> {
        self.snapshot_import = false;
        self.validate().map_err(|error| fail(&error))
    }

    pub fn resume_manifest(&mut self, manifest: &str) -> Result<(), JsValue> {
        let restored = Self::new(Some(manifest.into()))?;
        if restored.state.generation != self.state.generation {
            return Err(fail(
                "CONFLICT: filesystem changed after execution checkpoint",
            ));
        }
        self.state = restored.state;
        Ok(())
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
        for inode in self.state.inodes.values_mut() {
            inode.metadata.atime_ns = now;
            inode.metadata.mtime_ns = now;
            inode.metadata.ctime_ns = now;
        }
    }

    pub fn byte_command(
        &self,
        name: &str,
        args: &str,
        stdin: &[u8],
    ) -> Result<CommandResult, JsValue> {
        if args.len() > 1_048_576 || stdin.len() > 2_097_152 {
            return Err(fail("EFBIG: command input exceeds byte quota"));
        }
        let args: Vec<String> =
            serde_json::from_str(args).map_err(|_| fail("EINVAL: invalid command arguments"))?;
        Ok(CommandResult {
            output: shell::byte_command(name, &args, stdin),
        })
    }

    pub fn manifest(&self) -> Result<String, JsValue> {
        if self.snapshot_import {
            return Err(fail("EPERM: snapshot reconstruction is not complete"));
        }
        let manifest =
            serde_json::to_string(&self.state).map_err(|_| fail("EIO: serialization failed"))?;
        if manifest.len() > MAX_MANIFEST {
            return Err(fail("EFBIG: manifest exceeds byte quota"));
        }
        Ok(manifest)
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
        self.stat_resolved(&path)
    }

    pub fn stat_inode(&self, inode: u64) -> Result<String, JsValue> {
        if let Some(path) = self.inode_path(inode) {
            return self.stat_resolved(&path);
        }
        let path = self
            .state
            .retainers
            .values()
            .find_map(|retainer| retainer.inodes.get(&inode))
            .ok_or_else(|| fail("ENOENT: inode does not exist"))?;
        let inode = self
            .state
            .inodes
            .get(&inode)
            .ok_or_else(|| fail("EIO: retained inode missing"))?;
        serde_json::to_string(&inode.stat(path, 0)).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn chunks(&self, path: &str, for_write: bool) -> Result<String, JsValue> {
        let path = self.resolve(path, true).map_err(|e| fail(&e))?;
        let required = if for_write { 0o200 } else { 0o400 };
        match self.state.node(&path) {
            Some(Node::File { chunks, mode, .. }) if mode & required != 0 => {
                serde_json::to_string(chunks).map_err(|_| fail("EIO: serialization failed"))
            }
            Some(Node::File { .. }) => Err(fail("EACCES: file content access is denied")),
            Some(_) => Err(fail("EISDIR: not a regular file")),
            None => Err(fail("ENOENT: file does not exist")),
        }
    }

    pub fn read_plan(
        &self,
        path: &str,
        offset: u64,
        length: u64,
        for_write: bool,
    ) -> Result<String, JsValue> {
        let path = self.resolve(path, true).map_err(|error| fail(&error))?;
        self.read_plan_resolved(&path, offset, length, for_write, false)
    }

    pub fn read_inode_plan(&self, inode: u64, offset: u64, length: u64) -> Result<String, JsValue> {
        let inode = self
            .state
            .inodes
            .get(&inode)
            .ok_or_else(|| fail("ENOENT: inode does not exist"))?;
        self.read_node_plan(&inode.node, offset, length, false, true)
    }

    pub fn open_output(&mut self, path: &str, append: bool) -> Result<bool, JsValue> {
        let path = self.resolve(path, true).map_err(|error| fail(&error))?;
        self.package_writable(&path, false)
            .map_err(|error| fail(&error))?;
        let private_size = match (append, self.state.node(&path)) {
            (true, Some(node)) => self.private_file_bytes(node),
            _ => 0,
        };
        let mode = self
            .writable_file(&path, private_size)
            .map_err(|error| fail(&error))?;
        let changed = !append || !self.state.nodes.contains_key(&path);
        if changed {
            self.insert(
                path,
                Node::File {
                    mode,
                    size: 0,
                    chunks: Vec::new(),
                },
            )
            .map_err(|error| fail(&error))?;
        }
        Ok(changed)
    }

    pub fn write_range_plan(
        &self,
        path: &str,
        offset: Option<u64>,
        length: u64,
    ) -> Result<String, JsValue> {
        self.file_plan(path, FileMutation::Write { offset, length })
    }

    pub fn resize_plan(&self, path: &str, size: u64) -> Result<String, JsValue> {
        self.file_plan(path, FileMutation::Resize { size })
    }

    pub fn write_inode_range_plan(
        &self,
        inode: u64,
        offset: Option<u64>,
        length: u64,
    ) -> Result<String, JsValue> {
        self.file_plan_target(
            FileTarget::Inode(inode),
            FileMutation::Write { offset, length },
        )
    }

    pub fn resize_inode_plan(&self, inode: u64, size: u64) -> Result<String, JsValue> {
        self.file_plan_target(FileTarget::Inode(inode), FileMutation::Resize { size })
    }

    pub fn open_regular(
        &mut self,
        path: &str,
        access: u32,
        flags: u32,
        mode: u32,
    ) -> Result<bool, JsValue> {
        if !(1..=3).contains(&access)
            || flags & !7 != 0
            || mode & !0o777 != 0
            || flags & 2 != 0 && flags & 1 == 0
            || flags & 4 != 0 && access & 2 == 0
        {
            return Err(fail("EINVAL: invalid regular-file open options"));
        }
        if flags & 2 != 0 {
            let entry = self.resolve(path, false).map_err(|error| fail(&error))?;
            if self.state.nodes.contains_key(&entry) {
                return Err(fail("EEXIST: file exists"));
            }
        }
        let path = self.resolve(path, true).map_err(|error| fail(&error))?;
        let exists = self.state.nodes.contains_key(&path);
        if exists && flags & 2 != 0 {
            return Err(fail("EEXIST: file exists"));
        }
        if !exists && flags & 1 == 0 {
            return Err(fail("ENOENT: file does not exist"));
        }
        if exists && access & 1 != 0 {
            self.read_plan_resolved(&path, 0, 0, false, false)?;
        }
        if access & 2 != 0 || !exists {
            self.package_writable(&path, false)
                .map_err(|error| fail(&error))?;
            let private_size = match self.state.node(&path) {
                Some(node) if flags & 4 == 0 => self.private_file_bytes(node),
                _ => 0,
            };
            self.writable_file(&path, private_size)
                .map_err(|error| fail(&error))?;
        }
        if !exists || flags & 4 != 0 {
            let mode = self.state.node(&path).map_or(mode, Node::mode);
            self.insert(
                path,
                Node::File {
                    mode,
                    size: 0,
                    chunks: Vec::new(),
                },
            )
            .map_err(|error| fail(&error))?;
            return Ok(true);
        }
        Ok(false)
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
        self.commit_write(plan, size)
    }

    pub fn prepare_inode_write(
        &self,
        inode: u64,
        size: u64,
        chunks: &str,
    ) -> Result<String, JsValue> {
        let plan = self
            .write_plan_target(FileTarget::Inode(inode), size, chunks)
            .map_err(|error| fail(&error))?;
        serde_json::to_string(&plan.uploads).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn write_inode(&mut self, inode: u64, size: u64, chunks: &str) -> Result<String, JsValue> {
        let plan = self
            .write_plan_target(FileTarget::Inode(inode), size, chunks)
            .map_err(|error| fail(&error))?;
        self.commit_write(plan, size)
    }

    pub fn inode_path(&self, inode: u64) -> Option<String> {
        self.state
            .nodes
            .iter()
            .find(|(_, id)| **id == inode)
            .map(|(path, _)| path.clone())
    }

    pub fn retain_inode(
        &mut self,
        owner: &str,
        generation: u64,
        inode: u64,
        path: &str,
    ) -> Result<bool, JsValue> {
        if owner.is_empty()
            || owner.len() > 256
            || normalize(path, "/").map_err(|error| fail(&error))? != path
        {
            return Err(fail("EINVAL: invalid inode retainer"));
        }
        if !matches!(
            self.state.inodes.get(&inode).map(|inode| &inode.node),
            Some(Node::File { .. })
        ) {
            return Err(fail("ENOENT: regular inode does not exist"));
        }
        if let Some(retainer) = self.state.retainers.get(owner) {
            if retainer.generation != generation {
                return Err(fail("ESTALE: inode retainer generation changed"));
            }
            if retainer.inodes.contains_key(&inode) {
                return Ok(false);
            }
            if retainer.inodes.len() >= 125 {
                return Err(fail("EMFILE: inode retainer limit exceeded"));
            }
        } else if self.state.retainers.len() >= MAX_NODES {
            return Err(fail("ENOSPC: inode retainer quota exceeded"));
        }
        if self
            .state
            .retainers
            .values()
            .map(|retainer| retainer.inodes.len())
            .sum::<usize>()
            >= MAX_NODES
        {
            return Err(fail("ENOSPC: retained reference quota exceeded"));
        }
        self.state
            .retainers
            .entry(owner.into())
            .or_insert_with(|| Retainer {
                generation,
                inodes: BTreeMap::new(),
            })
            .inodes
            .insert(inode, path.into());
        Ok(true)
    }

    pub fn retains_inode(&self, owner: &str, generation: u64, inode: u64) -> bool {
        self.state.retainers.get(owner).is_some_and(|retainer| {
            retainer.generation == generation && retainer.inodes.contains_key(&inode)
        })
    }

    pub fn release_inode(
        &mut self,
        owner: &str,
        generation: u64,
        inode: u64,
    ) -> Result<bool, JsValue> {
        let Some(retainer) = self.state.retainers.get_mut(owner) else {
            return Ok(false);
        };
        if retainer.generation != generation {
            return Err(fail("ESTALE: inode retainer generation changed"));
        }
        let changed = retainer.inodes.remove(&inode).is_some();
        if retainer.inodes.is_empty() {
            self.state.retainers.remove(owner);
        }
        self.state.retain_linked();
        Ok(changed)
    }

    pub fn release_inode_owner(&mut self, owner: &str, generation: u64) -> bool {
        if self
            .state
            .retainers
            .get(owner)
            .is_some_and(|retainer| retainer.generation <= generation)
        {
            self.state.retainers.remove(owner);
            self.state.retain_linked();
            return true;
        }
        false
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
            if let Some(node) = self.state.node(&resolved) {
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
        match self.state.node(&path) {
            Some(Node::Directory { mode }) if mode & 0o500 == 0o500 => {}
            Some(Node::Directory { .. }) => return Err(fail("EACCES: directory is not readable")),
            Some(_) => return Err(fail("ENOTDIR: not a directory")),
            None => return Err(fail("ENOENT: directory does not exist")),
        }
        let entries: Vec<_> = self
            .state
            .entries()
            .filter(|(key, _)| key.as_str() != "/" && parent(key) == path)
            .map(|(key, value)| Entry {
                name: key.rsplit('/').next().unwrap_or_default(),
                kind: value.kind(),
                inode: self.state.metadata(key).map_or(0, |meta| meta.inode),
            })
            .collect();
        serde_json::to_string(&entries).map_err(|_| fail("EIO: serialization failed"))
    }

    pub fn snapshot_metadata(&self) -> Result<String, JsValue> {
        self.walk("/", MAX_DEPTH, "[]")
            .map_err(|error| fail(&error))?;
        let mut links: BTreeMap<u64, u64> = self
            .state
            .inodes
            .iter()
            .map(|(id, inode)| {
                let count = match inode.node {
                    Node::Directory { .. } => 2,
                    _ => 0,
                };
                (*id, count)
            })
            .collect();
        for (path, id) in &self.state.nodes {
            let inode = self
                .state
                .inodes
                .get(id)
                .ok_or_else(|| fail("EIO: missing inode"))?;
            let target = match inode.node {
                Node::Directory { .. } if path == "/" => continue,
                Node::Directory { .. } => self
                    .state
                    .nodes
                    .get(parent(path))
                    .ok_or_else(|| fail("EIO: missing parent"))?,
                _ => id,
            };
            *links
                .get_mut(target)
                .ok_or_else(|| fail("EIO: missing link count"))? += 1;
        }
        let mut bytes = Vec::new();
        let mut serializer = serde_json::Serializer::new(&mut bytes);
        let mut sequence = serializer
            .serialize_seq(Some(self.state.nodes.len()))
            .map_err(|_| fail("EIO: serialization failed"))?;
        for (path, inode) in &self.state.nodes {
            let nlink = links
                .get(inode)
                .ok_or_else(|| fail("EIO: missing link count"))?;
            sequence
                .serialize_element(&self.stat_record(path, *nlink)?)
                .map_err(|_| fail("EIO: serialization failed"))?;
        }
        sequence
            .end()
            .map_err(|_| fail("EIO: serialization failed"))?;
        String::from_utf8(bytes).map_err(|_| fail("EIO: serialization failed"))
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

        if let Some(meta) = self.state.metadata_mut(parent(&path)) {
            meta.mtime_ns = self.now;
            meta.ctime_ns = self.now;
        }
        let removed: BTreeSet<_> = self
            .state
            .nodes
            .iter()
            .filter(|(key, _)| *key == &path || key.starts_with(&prefix))
            .map(|(_, id)| *id)
            .collect();
        self.state
            .nodes
            .retain(|key, _| key != &path && !key.starts_with(&prefix));
        for id in removed {
            if let Some(inode) = self.state.inodes.get_mut(&id) {
                inode.metadata.ctime_ns = self.now;
            }
        }
        self.state.retain_linked();
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
            .node(&from)
            .ok_or_else(|| fail("ENOENT: source does not exist"))?;
        if from == to || self.state.nodes.get(&from) == self.state.nodes.get(&to) {
            return Ok(());
        }
        if let Some(destination) = self.state.node(&to) {
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
        let replaced = self.state.nodes.get(&to).copied();
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
        for (_, id) in &moved {
            if let Some(inode) = self.state.inodes.get_mut(id) {
                inode.metadata.ctime_ns = self.now;
            }
        }
        for path in [parent(&from), parent(&to)] {
            if let Some(meta) = self.state.metadata_mut(path) {
                meta.mtime_ns = self.now;
                meta.ctime_ns = self.now;
            }
        }
        self.state.nodes.extend(moved);
        if let Some(id) = replaced
            && let Some(inode) = self.state.inodes.get_mut(&id)
        {
            inode.metadata.ctime_ns = self.now;
        }
        self.state.retain_linked();
        Ok(())
    }

    pub fn link(&mut self, source: &str, destination: &str, follow: bool) -> Result<(), JsValue> {
        self.link_path(source, destination, follow)
            .map_err(|error| fail(&error))
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
        match self.state.node(&path) {
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
        let path = self.resolve(path, follow).map_err(|error| fail(&error))?;
        self.set_times_resolved(&path, atime, mtime, flags)
    }

    pub fn set_inode_times(
        &mut self,
        inode: u64,
        atime: u64,
        mtime: u64,
        flags: u32,
    ) -> Result<(), JsValue> {
        let path = self
            .inode_path(inode)
            .ok_or_else(|| fail("ENOENT: inode does not exist"))?;
        self.set_times_resolved(&path, atime, mtime, flags)
    }

    pub fn temporary_file(&mut self, directory: &str, mode: u32) -> Result<String, JsValue> {
        if mode > 0o777 {
            return Err(fail("EINVAL: invalid permission mode"));
        }
        let path = self
            .resolve(directory, true)
            .map_err(|error| fail(&error))?;
        self.package_writable(&path, false)
            .map_err(|error| fail(&error))?;
        match self.state.node(&path) {
            Some(Node::Directory { mode }) if mode & 0o300 == 0o300 => {}
            Some(Node::Directory { .. }) => return Err(fail("EACCES: directory is not writable")),
            Some(_) => return Err(fail("ENOTDIR: not a directory")),
            None => return Err(fail("ENOENT: directory does not exist")),
        }
        let next = self
            .state
            .next_inode
            .checked_add(1)
            .ok_or_else(|| fail("ENOSPC: inode identifiers exhausted"))?;
        let encoded = serde_json::to_string(&Stat {
            path: &path,
            kind: "file",
            size: 0,
            mode,
            inode: self.state.next_inode,
            nlink: 0,
            uid: 0,
            gid: 0,
            atime_ns: self.now.to_string(),
            mtime_ns: self.now.to_string(),
            ctime_ns: self.now.to_string(),
        })
        .map_err(|error| fail(&error.to_string()))?;
        self.state.next_inode = next;
        Ok(encoded)
    }

    pub fn chown(&mut self, path: &str, uid: u32, gid: u32, follow: bool) -> Result<(), JsValue> {
        let path = self.resolve(path, follow).map_err(|error| fail(&error))?;
        self.package_writable(&path, false)
            .map_err(|error| fail(&error))?;
        let metadata = self
            .state
            .metadata_mut(&path)
            .ok_or_else(|| fail("ENOENT: file does not exist"))?;
        metadata.uid = uid;
        metadata.gid = gid;
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
        match self.state.node_mut(&path) {
            Some(Node::File { mode: current, .. } | Node::Directory { mode: current }) => {
                *current = mode;
                if let Some(meta) = self.state.metadata_mut(&path) {
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
    fn filesystem_v5_migrates_to_retainer_graph_without_changing_existing_inodes()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.insert(
            "/tmp/data".into(),
            Node::File {
                mode: 0o600,
                size: 3,
                chunks: vec!["a".repeat(64)],
            },
        )?;
        let expected = kernel.manifest().map_err(|_| "manifest failed")?;
        let mut prior: serde_json::Value =
            serde_json::from_str(&expected).map_err(|error| error.to_string())?;
        let fields = prior.as_object_mut().ok_or("manifest fields missing")?;
        fields.remove("retainers");
        fields.insert("version".into(), serde_json::json!(5));
        let encoded = serde_json::to_string(&prior).map_err(|error| error.to_string())?;
        let migrated = migrate_filesystem(&encoded).map_err(|_| "v5 migration failed")?;
        assert_eq!(migrated, expected);
        assert_eq!(
            migrate_filesystem(&migrated).map_err(|_| "migration replay failed")?,
            expected
        );
        let restored = Kernel::new(Some(migrated)).map_err(|_| "restore failed")?;
        assert_eq!(restored.state.nodes, kernel.state.nodes);
        assert!(restored.state.retainers.is_empty());
        restored.validate()
    }

    #[test]
    fn retained_inodes_survive_unlink_restore_and_release_without_resurrecting_paths()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.insert(
            "/tmp/shared".into(),
            Node::File {
                mode: 0o600,
                size: 6,
                chunks: vec!["a".repeat(64)],
            },
        )?;
        let inode = kernel
            .state
            .metadata("/tmp/shared")
            .ok_or("missing metadata")?
            .inode;
        assert!(
            kernel
                .retain_inode("context:writer", 1, inode, "/tmp/shared")
                .map_err(|_| "writer retain failed")?
        );
        assert!(
            !kernel
                .retain_inode("context:writer", 1, inode, "/tmp/shared")
                .map_err(|_| "idempotent retain failed")?
        );
        assert!(
            kernel
                .retain_inode("context:reader", 2, inode, "/tmp/shared")
                .map_err(|_| "reader retain failed")?
        );
        kernel
            .remove("/tmp/shared", false)
            .map_err(|_| "unlink failed")?;
        assert!(!kernel.state.nodes.contains_key("/tmp/shared"));
        assert_eq!(kernel.used_bytes(), 6);
        kernel.validate()?;
        let encoded = kernel.manifest().map_err(|_| "serialization failed")?;
        let mut restored = Kernel::new(Some(encoded)).map_err(|_| "restoration failed")?;
        assert_eq!(
            restored
                .state
                .inodes
                .get(&inode)
                .ok_or("retained inode lost")?
                .node
                .size(),
            6
        );
        restored.insert(
            "/tmp/shared".into(),
            Node::File {
                mode: 0o644,
                size: 3,
                chunks: vec!["b".repeat(64)],
            },
        )?;
        let replacement = restored
            .state
            .metadata("/tmp/shared")
            .ok_or("replacement missing")?
            .inode;
        assert_ne!(inode, replacement);
        assert_eq!(restored.used_bytes(), 9);
        let stat: serde_json::Value = serde_json::from_str(
            &restored
                .stat_inode(inode)
                .map_err(|_| "orphan stat failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(stat["nlink"], 0);
        assert_eq!(stat["inode"], inode);
        assert_eq!(stat["size"], 6);
        let plan: serde_json::Value = serde_json::from_str(
            &restored
                .read_inode_plan(inode, 2, 2)
                .map_err(|_| "orphan read failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(plan["skip"], 2);
        assert_eq!(plan["length"], 2);
        assert_eq!(plan["blocks"][0]["hash"], "a".repeat(64));
        assert_eq!(plan["blocks"][0]["size"], 6);

        assert!(restored.release_inode_owner("context:writer", 1));
        assert!(!restored.release_inode_owner("context:reader", 1));
        assert!(restored.state.inodes.contains_key(&inode));
        assert!(
            restored
                .release_inode("context:reader", 2, inode)
                .map_err(|_| "reader release failed")?
        );
        assert!(
            !restored
                .release_inode("context:reader", 2, inode)
                .map_err(|_| "idempotent release failed")?
        );
        assert!(!restored.state.inodes.contains_key(&inode));
        assert_eq!(
            restored
                .state
                .metadata("/tmp/shared")
                .ok_or("replacement removed")?
                .inode,
            replacement
        );
        assert_eq!(restored.used_bytes(), 3);
        assert!(restored.state.retainers.is_empty());
        restored.validate()
    }

    #[test]
    fn retained_inode_mutations_ignore_recreated_names_and_keep_shared_blocks_for_restore()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        let shared = "a".repeat(64);
        kernel.insert(
            "/tmp/file".into(),
            Node::File {
                mode: 0o600,
                size: 6,
                chunks: vec![shared.clone()],
            },
        )?;
        kernel.state.shared_chunks.insert(shared.clone());
        let inode = kernel
            .state
            .metadata("/tmp/file")
            .ok_or("missing inode")?
            .inode;
        kernel
            .retain_inode("context:reader", 0, inode, "/tmp/file")
            .map_err(|_| "retain failed")?;
        kernel
            .remove("/tmp/file", false)
            .map_err(|_| "unlink failed")?;
        kernel.insert(
            "/tmp/file".into(),
            Node::File {
                mode: 0o400,
                size: 0,
                chunks: vec![],
            },
        )?;
        let references: serde_json::Value = serde_json::from_str(
            &kernel
                .retained_shared_blocks()
                .map_err(|_| "retained blocks failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(
            references,
            serde_json::json!([{"hash":shared, "size":6,"shared":true}])
        );
        let plan: serde_json::Value = serde_json::from_str(
            &kernel
                .write_inode_range_plan(inode, None, 2)
                .map_err(|_| "append plan failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(plan["offset"], 6);
        assert_eq!(plan["size"], 8);
        let hashes =
            serde_json::to_string(&vec!["b".repeat(64)]).map_err(|error| error.to_string())?;
        kernel.set_time(42);
        kernel
            .write_inode(inode, 8, &hashes)
            .map_err(|_| "orphan write failed")?;
        assert_eq!(
            kernel
                .state
                .node("/tmp/file")
                .ok_or("replacement missing")?
                .size(),
            0
        );
        assert_eq!(
            kernel
                .state
                .inodes
                .get(&inode)
                .ok_or("orphan missing")?
                .metadata
                .mtime_ns,
            42
        );
        let resized: serde_json::Value = serde_json::from_str(
            &kernel
                .resize_inode_plan(inode, 0)
                .map_err(|_| "resize plan failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(resized["size"], 0);
        kernel
            .write_inode(inode, 0, "[]")
            .map_err(|_| "truncate failed")?;
        assert_eq!(kernel.used_bytes(), 0);
        assert_eq!(
            kernel
                .write_plan_target(FileTarget::Inode(inode), MAX_FILE + 1, "[]")
                .err(),
            Some("EFBIG: file limit or chunk count exceeded".into())
        );
        kernel.validate()
    }

    #[test]
    fn retained_inodes_validate_content_and_account_for_inode_quota() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.insert(
            "/tmp/shared".into(),
            Node::File {
                mode: 0o600,
                size: 1,
                chunks: vec!["a".repeat(64)],
            },
        )?;
        let inode = kernel
            .state
            .metadata("/tmp/shared")
            .ok_or("missing metadata")?
            .inode;
        kernel
            .retain_inode("context:reader", 0, inode, "/tmp/shared")
            .map_err(|_| "retain failed")?;
        kernel
            .remove("/tmp/shared", false)
            .map_err(|_| "unlink failed")?;
        kernel
            .state
            .inodes
            .get_mut(&inode)
            .ok_or("retained inode lost")?
            .node = Node::File {
            mode: 0o600,
            size: 1,
            chunks: vec!["invalid".into()],
        };
        assert_eq!(
            kernel.validate(),
            Err("EINVAL: invalid content digest".into())
        );
        kernel
            .state
            .inodes
            .get_mut(&inode)
            .ok_or("retained inode lost")?
            .node = Node::File {
            mode: 0o600,
            size: 1,
            chunks: vec!["a".repeat(64)],
        };
        for index in 0..MAX_NODES - kernel.state.inodes.len() {
            kernel.insert(
                format!("/tmp/f{index}"),
                Node::File {
                    mode: 0o600,
                    size: 0,
                    chunks: Vec::new(),
                },
            )?;
        }
        assert_eq!(
            kernel.write_plan("/tmp/overflow", 0, "[]").err(),
            Some("ENOSPC: inode quota exceeded".into())
        );
        assert_eq!(
            kernel.insert("/tmp/overflow".into(), Node::Directory { mode: 0o700 }),
            Err("ENOSPC: inode quota exceeded".into())
        );
        kernel.validate()?;
        assert!(kernel.release_inode_owner("context:reader", 0));
        assert!(kernel.write_plan("/tmp/available", 0, "[]").is_ok());
        kernel.insert("/tmp/available".into(), Node::Directory { mode: 0o700 })?;
        kernel.validate()
    }

    #[test]
    fn hard_links_share_payload_metadata_and_survive_unlink_and_round_trip() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.insert(
            "/tmp/original".into(),
            Node::File {
                mode: 0o644,
                size: 3,
                chunks: vec!["a".repeat(64)],
            },
        )?;
        let id = kernel
            .state
            .metadata("/tmp/original")
            .ok_or("missing original")?
            .inode;
        kernel.set_time(100);
        kernel.link_path("/tmp/original", "/tmp/alias", false)?;
        assert_eq!(kernel.used_bytes(), 3);
        assert_eq!(
            kernel
                .state
                .metadata("/tmp/alias")
                .ok_or("missing alias")?
                .inode,
            id
        );
        assert_eq!(
            kernel
                .state
                .metadata("/tmp/original")
                .ok_or("missing original")?
                .ctime_ns,
            100
        );
        kernel.insert(
            "/tmp/alias".into(),
            Node::File {
                mode: 0o600,
                size: 7,
                chunks: vec!["b".repeat(64)],
            },
        )?;
        assert_eq!(
            kernel
                .state
                .node("/tmp/original")
                .ok_or("missing original")?
                .size(),
            7
        );
        assert_eq!(
            kernel
                .state
                .node("/tmp/original")
                .ok_or("missing original")?
                .mode(),
            0o600
        );
        assert_eq!(kernel.used_bytes(), 7);
        let before = kernel.state.nodes.len();
        kernel
            .rename("/tmp/original", "/tmp/alias")
            .map_err(|_| "rename failed")?;
        assert_eq!(kernel.state.nodes.len(), before);
        kernel.set_time(200);
        kernel
            .remove("/tmp/original", false)
            .map_err(|_| "unlink failed")?;
        assert!(!kernel.state.nodes.contains_key("/tmp/original"));
        assert_eq!(
            kernel
                .state
                .metadata("/tmp/alias")
                .ok_or("missing alias")?
                .ctime_ns,
            200
        );
        let encoded = kernel.manifest().map_err(|_| "serialization failed")?;
        let restored = Kernel::new(Some(encoded)).map_err(|_| "restore failed")?;
        assert_eq!(
            restored
                .state
                .metadata("/tmp/alias")
                .ok_or("missing alias")?
                .inode,
            id
        );
        assert_eq!(restored.used_bytes(), 7);
        kernel
            .remove("/tmp/alias", false)
            .map_err(|_| "last unlink failed")?;
        assert!(!kernel.state.inodes.contains_key(&id));
        kernel.validate()?;
        Ok(())
    }

    #[test]
    fn hard_links_preserve_symlink_identity_and_reject_directories_and_missing_sources()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.insert(
            "/tmp/symbolic".into(),
            Node::Symlink {
                target: "missing".into(),
            },
        )?;
        kernel.link_path("/tmp/symbolic", "/home/symbolic", false)?;
        assert_eq!(
            kernel.state.nodes.get("/tmp/symbolic"),
            kernel.state.nodes.get("/home/symbolic")
        );
        assert!(
            kernel
                .link_path("/tmp/symbolic", "/home/followed", true)
                .is_err()
        );
        assert!(kernel.link_path("/tmp", "/home/directory", false).is_err());
        assert!(
            kernel
                .link_path("/tmp/absent", "/home/absent", false)
                .is_err()
        );
        assert!(
            kernel
                .link_path("/tmp/symbolic", "/home/symbolic", false)
                .is_err()
        );
        kernel.validate()?;
        Ok(())
    }

    #[test]
    fn inode_graph_rejects_missing_payloads_unlinked_inodes_and_directory_aliases()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.state.nodes.insert("/tmp/missing".into(), 999);
        assert!(kernel.validate().is_err());
        kernel.state.nodes.remove("/tmp/missing");
        let id = *kernel.state.nodes.get("/tmp").ok_or("missing tmp")?;
        kernel.state.nodes.insert("/home/directory".into(), id);
        assert!(kernel.validate().is_err());
        kernel.state.nodes.remove("/home/directory");
        kernel.state.nodes.remove("/tmp");
        assert!(kernel.validate().is_err());
        Ok(())
    }

    #[test]
    fn ownership_preserves_identity_and_follows_only_selected_symlinks() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.initialize_times(10);
        kernel
            .symlink("/tmp", "/home/alias")
            .map_err(|_| "link failed")?;
        let inode = kernel.state.metadata("/tmp").ok_or("missing inode")?.inode;
        kernel.set_time(20);
        kernel
            .chown("/home/alias", 1000, 1001, false)
            .map_err(|_| "link ownership failed")?;
        let target = kernel.state.metadata("/tmp").ok_or("missing target")?;
        assert_eq!((target.uid, target.gid, target.ctime_ns), (0, 0, 10));
        kernel.set_time(30);
        kernel
            .chown("/home/alias", u32::MAX, 1002, true)
            .map_err(|_| "target ownership failed")?;
        let target = kernel.state.metadata("/tmp").ok_or("missing target")?;
        assert_eq!(
            (
                target.uid,
                target.gid,
                target.inode,
                target.atime_ns,
                target.mtime_ns,
                target.ctime_ns
            ),
            (u32::MAX, 1002, inode, 10, 10, 30)
        );
        let link = kernel.state.metadata("/home/alias").ok_or("missing link")?;
        assert_eq!((link.uid, link.gid, link.ctime_ns), (1000, 1001, 20));
        kernel.validate()?;
        Ok(())
    }

    #[test]
    fn admitted_regular_inode_ranges_preserve_mode_and_track_append_and_resize()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        assert!(
            kernel
                .open_regular("/tmp/descriptor", 3, 1, 0)
                .map_err(|_| "open failed")?
        );
        let inode = kernel
            .state
            .metadata("/tmp/descriptor")
            .ok_or("missing inode")?
            .inode;
        let plan: serde_json::Value = serde_json::from_str(
            &kernel
                .write_inode_range_plan(inode, Some(5), 1)
                .map_err(|_| "range failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(plan["offset"], 5);
        assert_eq!(plan["size"], 6);
        assert_eq!(plan["blocks"][0]["size"], 6);
        let chunks = serde_json::to_string(&["a".repeat(64)]).map_err(|error| error.to_string())?;
        kernel
            .prepare_inode_write(inode, 6, &chunks)
            .map_err(|_| "prepare failed")?;
        kernel
            .write_inode(inode, 6, &chunks)
            .map_err(|_| "commit failed")?;
        assert_eq!(
            kernel
                .state
                .node("/tmp/descriptor")
                .ok_or("missing file")?
                .mode(),
            0
        );
        let appended: serde_json::Value = serde_json::from_str(
            &kernel
                .write_inode_range_plan(inode, None, 2)
                .map_err(|_| "append failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(appended["offset"], 6);
        assert_eq!(appended["size"], 8);
        let resized: serde_json::Value = serde_json::from_str(
            &kernel
                .resize_inode_plan(inode, 2)
                .map_err(|_| "resize failed")?,
        )
        .map_err(|error| error.to_string())?;
        assert_eq!(resized["size"], 2);
        assert_eq!(resized["blocks"][0]["previous"]["size"], 6);
        kernel.validate()
    }

    #[test]
    fn snapshot_reconstruction_preserves_generation_and_monotonic_inode_allocation()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.advance().map_err(|_| "generation advance failed")?;
        let next = kernel.state.next_inode;
        kernel.reset_snapshot_root().map_err(|_| "reset failed")?;
        assert_eq!(kernel.state.generation, 1);
        assert_eq!(kernel.state.next_inode, next);
        assert_eq!(kernel.state.nodes.len(), 1);
        assert!(kernel.snapshot_import);
        kernel
            .mkdir("/restored", false)
            .map_err(|_| "directory failed")?;
        assert_eq!(
            kernel
                .state
                .metadata("/restored")
                .ok_or("missing inode")?
                .inode,
            next
        );
        kernel.finish_snapshot_root().map_err(|_| "finish failed")?;
        assert!(!kernel.snapshot_import);
        assert!(kernel.package_writable("/opt/cirro", false).is_err());
        kernel.validate()
    }

    #[test]
    fn descriptor_writes_preserve_authorized_inode_and_enforce_storage_limits() -> Result<(), String>
    {
        let mut kernel = Kernel::fresh();
        kernel.insert("/tmp/hidden".into(), Node::Directory { mode: 0o700 })?;
        kernel.insert(
            "/tmp/hidden/file".into(),
            Node::File {
                mode: 0,
                size: 0,
                chunks: vec![],
            },
        )?;
        let inode = kernel
            .state
            .metadata("/tmp/hidden/file")
            .ok_or("missing inode")?
            .inode;
        assert!(kernel.write_plan("/tmp/hidden/file", 0, "[]").is_err());
        kernel.chmod("/tmp/hidden", 0).map_err(|_| "chmod failed")?;
        assert!(kernel.resolve("/tmp/hidden/file", true).is_err());
        let hashes = format!("[\"{}\"]", "a".repeat(64));
        kernel
            .prepare_inode_write(inode, 3, &hashes)
            .map_err(|_| "inode preparation failed")?;
        kernel
            .write_inode(inode, 3, &hashes)
            .map_err(|_| "inode write failed")?;
        kernel.set_time(55);
        kernel
            .set_inode_times(inode, 111, 222, 5)
            .map_err(|_| "inode times failed")?;
        let stat: serde_json::Value =
            serde_json::from_str(&kernel.stat_inode(inode).map_err(|_| "inode stat failed")?)
                .map_err(|error| error.to_string())?;
        assert_eq!(stat["inode"], inode);
        assert_eq!(stat["mode"], 0);
        assert_eq!(stat["size"], 3);
        assert_eq!(stat["atimeNs"], "111");
        assert_eq!(stat["mtimeNs"], "222");
        assert!(
            kernel
                .write_plan_target(FileTarget::Inode(inode), MAX_FILE + 1, "[]")
                .is_err()
        );
        assert!(
            kernel
                .write_plan_target(FileTarget::Inode(inode), 1, "[]")
                .is_err()
        );
        assert!(
            kernel
                .write_plan_target(
                    FileTarget::Inode(
                        *kernel
                            .state
                            .nodes
                            .get("/tmp/hidden")
                            .ok_or("directory missing")?
                    ),
                    0,
                    "[]"
                )
                .is_err()
        );
        kernel.insert("/opt".into(), Node::Directory { mode: 0o700 })?;
        kernel.insert("/opt/cirro".into(), Node::Directory { mode: 0o700 })?;
        assert!(
            kernel
                .write_plan_target(FileTarget::Path("/opt/cirro/immutable".into()), 0, "[]")
                .is_err()
        );
        kernel.validate()
    }

    #[test]
    fn timestamp_flags_preserve_identity_and_unselected_fields() -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        kernel.initialize_times(10);
        kernel.set_time(20);
        kernel
            .set_times("/tmp", true, u64::MAX, 100, 1)
            .map_err(|_| "timestamp update failed")?;
        let metadata = kernel.state.metadata("/tmp").ok_or("missing inode")?;
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
        let metadata = kernel.state.metadata("/tmp").ok_or("missing inode")?;
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
        assert_eq!(plan.target, FileTarget::Path("/tmp/file".into()));
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
            snapshot_import: false,
        };
        restored.validate()?;
        assert_eq!(restored.state.nodes, kernel.state.nodes);
        Ok(())
    }

    #[test]
    fn corrupt_chunks_and_orphans_are_rejected() {
        let mut kernel = Kernel::fresh();
        kernel
            .insert(
                "/tmp/x".into(),
                Node::File {
                    size: 1,
                    mode: 0o644,
                    chunks: vec!["a".into()],
                },
            )
            .unwrap();
        assert!(kernel.validate().is_err());
        kernel.state.nodes.remove("/tmp/x");
        kernel.state.retain_linked();
        kernel
            .insert("/missing/x".into(), Node::Directory { mode: 0o755 })
            .unwrap();
        assert!(kernel.validate().is_err());
    }

    #[test]
    fn symlink_cycles_are_bounded() {
        let mut kernel = Kernel::fresh();
        kernel
            .insert("/tmp/a".into(), Node::Symlink { target: "b".into() })
            .unwrap();
        kernel
            .insert("/tmp/b".into(), Node::Symlink { target: "a".into() })
            .unwrap();
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
    #[test]
    fn public_content_does_not_spend_private_quota_and_copy_on_write_is_bounded()
    -> Result<(), String> {
        let mut kernel = Kernel::fresh();
        let shared = "a".repeat(64);
        let private = "b".repeat(64);
        kernel.state.shared_chunks.insert(shared.clone());
        for index in 0..8 {
            kernel.insert(
                format!("/tmp/public-{index}"),
                Node::File {
                    mode: 0o644,
                    size: MAX_FILE,
                    chunks: vec![shared.clone(); 64],
                },
            )?;
        }
        for index in 0..4 {
            kernel.insert(
                format!("/tmp/private-{index}"),
                Node::File {
                    mode: 0o644,
                    size: MAX_FILE,
                    chunks: vec![private.clone(); 64],
                },
            )?;
        }
        assert_eq!(kernel.used_bytes(), MAX_FILE * 12);
        assert_eq!(kernel.private_bytes(), MAX_TOTAL);
        kernel.validate()?;
        let public_chunks =
            serde_json::to_string(&vec![shared.clone(); 64]).map_err(|error| error.to_string())?;
        assert!(
            kernel
                .write_plan("/tmp/copy", MAX_FILE, &public_chunks)
                .is_ok()
        );
        assert!(
            kernel
                .write_plan("/tmp/overflow", 1, &format!("[\"{private}\"]"))
                .is_err()
        );
        assert!(kernel.writable_file("/tmp/public-0", 262_144).is_err());
        if let Some(node) = kernel.state.node_mut("/tmp/private-0") {
            *node = Node::File {
                mode: 0o644,
                size: MAX_FILE - 262_144,
                chunks: vec![private.clone(); 63],
            };
        }
        assert_eq!(kernel.private_bytes(), MAX_TOTAL - 262_144);
        assert!(kernel.write_range_plan("/tmp/public-0", Some(0), 1).is_ok());
        let mut changed = vec![shared; 64];
        changed[0] = private.clone();
        let hashes = serde_json::to_string(&changed).map_err(|error| error.to_string())?;
        let plan = kernel.write_plan("/tmp/public-0", MAX_FILE, &hashes)?;
        kernel
            .commit_write(plan, MAX_FILE)
            .map_err(|_| "commit failed")?;
        assert_eq!(kernel.private_bytes(), MAX_TOTAL);
        kernel.validate()?;
        assert!(kernel.writable_file("/tmp/public-1", 262_144).is_err());
        assert!(
            kernel
                .write_plan("/tmp/overflow", 1, &format!("[\"{private}\"]"))
                .is_err()
        );
        Ok(())
    }
}
