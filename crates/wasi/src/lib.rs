use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasmi::{
    Caller, Config, Engine, Error, Func, Linker, Memory, Module, ResumableCall,
    ResumableCallHostTrap, Store, StoreLimits, StoreLimitsBuilder, Val,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
}

include!(concat!(env!("OUT_DIR"), "/module_limit.rs"));

const MAX_FILES: usize = 128;
const PIPE_BYTES: usize = 65_536;
const PIPE_ATOMIC_BYTES: usize = 4096;
const HIDDEN_PREOPEN: u32 = 0x40000003;
const MAX_BYTES: usize = 16_777_216;

struct Pipe {
    bytes: RefCell<VecDeque<u8>>,
    readers: Cell<usize>,
    writers: Cell<usize>,
}

struct PipeEndpoint {
    pipe: Rc<Pipe>,
    reading: bool,
}

impl PipeEndpoint {
    fn has_peer(&self) -> bool {
        if self.reading {
            self.pipe.writers.get() > 0
        } else {
            self.pipe.readers.get() > 0
        }
    }
}

impl Drop for PipeEndpoint {
    fn drop(&mut self) {
        let count = if self.reading {
            &self.pipe.readers
        } else {
            &self.pipe.writers
        };
        count.set(count.get() - 1);
    }
}

#[derive(Clone)]
struct Descriptor {
    path: String,
    directory: bool,
    read: bool,
    write: bool,
    flags: Rc<Cell<u16>>,
    offset: Rc<Cell<usize>>,
    stdio: Option<u32>,
    pipe: Option<Rc<PipeEndpoint>>,
    rights: u64,
    inheriting: u64,
    cache: Option<u32>,
    linked: bool,
    metadata: [u8; 76],
}

struct FileBuffer {
    path: Option<String>,
    bytes: Vec<u8>,
    metadata: [u8; 76],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PollClock {
    index: usize,
    clock: u32,
    timeout: String,
    precision: String,
    absolute: bool,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Open {
        path: String,
        base: String,
        read: bool,
        write: bool,
        create: bool,
        truncate: bool,
        exclusive: bool,
        directory: bool,
        follow: bool,
        mode: u32,
    },
    Tmpfile {
        path: String,
        base: String,
        read: bool,
        mode: u32,
    },
    Flush {
        path: Option<String>,
        fd: u32,
    },
    FdStat {
        fd: u32,
        path: Option<String>,
        write: bool,
    },
    FdTimes {
        fd: u32,
        path: Option<String>,
        atime: String,
        mtime: String,
        flags: u16,
    },
    PathTimes {
        path: String,
        base: String,
        follow: bool,
        atime: String,
        mtime: String,
        flags: u16,
    },
    PathStat {
        path: String,
        base: String,
        follow: bool,
    },
    Directory {
        path: String,
        fd: u32,
    },
    Mkdir {
        path: String,
        base: String,
    },
    Remove {
        path: String,
        base: String,
        directory: bool,
    },
    Rename {
        from: String,
        from_base: String,
        to: String,
        to_base: String,
    },
    Symlink {
        path: String,
        base: String,
        target: String,
    },
    Readlink {
        path: String,
        base: String,
    },
    Poll {
        clocks: Vec<PollClock>,
        immediate: bool,
    },
    Sync,
    Random {
        length: usize,
    },
    Clock {
        clock: u32,
    },
}

#[derive(Clone, Copy)]
enum StatProjection {
    Mode,
    Size,
    Blocks,
    Owner,
}

enum Completion {
    HostStat {
        fd: Option<u32>,
        projection: StatProjection,
        pointers: Option<(usize, usize)>,
    },
    Open {
        descriptor: Descriptor,
        pointer: usize,
        truncate: bool,
    },
    Tmpfile {
        descriptor: Descriptor,
        pointer: usize,
    },
    Flush {
        fd: u32,
        pointer: Option<usize>,
        length: usize,
        previous: Vec<u8>,
        previous_length: usize,
        start: usize,
        previous_offset: usize,
        offset: usize,
        positioned: bool,
    },
    Directory {
        fd: u32,
        pointer: usize,
        length: usize,
        cookie: u64,
        output: usize,
    },
    Remove,
    Rename,
    Stat {
        fd: Option<u32>,
        pointer: usize,
    },
    Metadata {
        fd: Option<u32>,
    },
    Poll {
        events: Vec<[u8; 32]>,
        clocks: BTreeSet<usize>,
        blocked: BTreeSet<usize>,
        pointer: usize,
        output: usize,
    },
    Unit,
    Readlink {
        pointer: usize,
        length: usize,
        output: usize,
    },
    Sync,
    Bytes {
        pointer: usize,
        length: usize,
    },
    Clock {
        pointer: usize,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectoryEntry {
    name: String,
    kind: String,
    inode: u64,
}

struct Pending {
    request: Request,
    completion: Completion,
}

struct State {
    limits: StoreLimits,
    descriptors: BTreeMap<u32, Descriptor>,
    files: BTreeMap<u32, FileBuffer>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    max_output: usize,
    pending: Option<Pending>,
    requests: usize,
    closed: BTreeSet<u32>,
    cloexec: BTreeSet<u32>,
    signal_mask: u64,
    stdio_flags: [Rc<Cell<u16>>; 3],
    argv: Vec<Vec<u8>>,
    environment: Vec<Vec<u8>>,
    stdin: Vec<u8>,
    stdin_offset: usize,
    directories: BTreeMap<u32, Vec<DirectoryEntry>>,
    open_mode: Option<u32>,
    open_direct: bool,
}

#[derive(Debug)]
enum Failure {
    Errno(i32),
    Suspend,
    Budget,
}

fn memory(caller: &Caller<'_, State>) -> Result<Memory, Failure> {
    caller
        .get_export("memory")
        .and_then(|export| export.into_memory())
        .ok_or(Failure::Errno(21))
}

fn bytes(caller: &Caller<'_, State>, pointer: usize, length: usize) -> Result<Vec<u8>, Failure> {
    if length > MAX_BYTES {
        return Err(Failure::Errno(22));
    }
    let end = pointer.checked_add(length).ok_or(Failure::Errno(21))?;
    memory(caller)?
        .data(caller)
        .get(pointer..end)
        .map(<[u8]>::to_vec)
        .ok_or(Failure::Errno(21))
}

fn put(caller: &mut Caller<'_, State>, pointer: usize, data: &[u8]) -> Result<(), Failure> {
    memory(caller)?
        .write(caller, pointer, data)
        .map_err(|_| Failure::Errno(21))
}

fn integer(caller: &Caller<'_, State>, pointer: usize) -> Result<u32, Failure> {
    let data = bytes(caller, pointer, 4)?;
    let data: [u8; 4] = data.try_into().map_err(|_| Failure::Errno(21))?;
    Ok(u32::from_le_bytes(data))
}

fn vectors(
    caller: &Caller<'_, State>,
    pointer: usize,
    count: usize,
) -> Result<Vec<(usize, usize)>, Failure> {
    if count > 128 {
        return Err(Failure::Errno(28));
    }
    let mut total = 0usize;
    let mut result = Vec::new();
    for index in 0..count {
        let pointer = pointer.checked_add(index * 8).ok_or(Failure::Errno(21))?;
        let start = integer(caller, pointer)? as usize;
        let length = integer(caller, pointer + 4)? as usize;
        total = total.checked_add(length).ok_or(Failure::Errno(22))?;
        if total > MAX_BYTES {
            return Err(Failure::Errno(22));
        }
        let end = start.checked_add(length).ok_or(Failure::Errno(21))?;
        if memory(caller)?.data(caller).get(start..end).is_none() {
            return Err(Failure::Errno(21));
        }
        result.push((start, length));
    }
    Ok(result)
}

fn suspend(
    caller: &mut Caller<'_, State>,
    request: Request,
    completion: Completion,
) -> Result<i32, Failure> {
    let state = caller.data_mut();
    state.requests += 1;
    if state.requests > 256 {
        return Err(Failure::Budget);
    }
    state.pending = Some(Pending {
        request,
        completion,
    });
    Err(Failure::Suspend)
}

fn confined(base: &str, path: &str) -> Result<String, Failure> {
    if path.is_empty() || path.starts_with('/') || path.contains('\0') || path.len() > 4096 {
        return Err(Failure::Errno(28));
    }
    let mut parts: Vec<_> = base.split('/').filter(|part| !part.is_empty()).collect();
    let minimum = parts.len();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.len() == minimum {
                    return Err(Failure::Errno(76));
                }
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    if parts.len() > 64 {
        return Err(Failure::Errno(37));
    }
    let path = format!("/{}", parts.join("/"));
    if path.len() > 4096 {
        return Err(Failure::Errno(37));
    }
    Ok(path)
}

fn detach(state: &mut State, path: &str) {
    for file in state.files.values_mut() {
        if file
            .path
            .as_deref()
            .is_some_and(|current| current == path || current.starts_with(&format!("{path}/")))
        {
            file.path = None;
            file.metadata[24..32].copy_from_slice(&0u64.to_le_bytes());
        }
    }
    for descriptor in state.descriptors.values_mut() {
        if descriptor.path == path || descriptor.path.starts_with(&format!("{path}/")) {
            descriptor.linked = false;
            descriptor.metadata[24..32].copy_from_slice(&0u64.to_le_bytes());
        }
    }
}

fn close(state: &mut State, fd: u32) {
    state.directories.remove(&fd);
    state.cloexec.remove(&fd);
    if fd < 3 {
        state.closed.insert(fd);
    }
    if let Some(descriptor) = state.descriptors.remove(&fd)
        && let Some(cache) = descriptor.cache
        && !state
            .descriptors
            .values()
            .any(|other| other.cache == Some(cache))
    {
        state.files.remove(&cache);
    }
}

fn stream(state: &State, fd: u32) -> Option<u32> {
    if state.closed.contains(&fd) {
        return None;
    }
    if let Some(descriptor) = state.descriptors.get(&fd) {
        return descriptor.stdio;
    }
    if fd < 3 {
        return Some(fd);
    }
    None
}

fn duplicate_source(state: &State, fd: u32) -> Result<Descriptor, Failure> {
    if state.closed.contains(&fd) || fd == HIDDEN_PREOPEN {
        return Err(Failure::Errno(8));
    }
    if let Some(descriptor) = state.descriptors.get(&fd) {
        return Ok(descriptor.clone());
    }
    if let Some(index) = stream(state, fd) {
        return Ok(Descriptor {
            path: "/".into(),
            directory: false,
            read: index == 0,
            write: index > 0,
            flags: state.stdio_flags[index as usize].clone(),
            offset: Rc::new(Cell::new(0)),
            stdio: Some(index),
            pipe: None,
            rights: (if index == 0 { 2 } else { 64 }) | (1 << 27) | (1 << 3),
            inheriting: 0,
            cache: None,
            linked: false,
            metadata: [0; 76],
        });
    }
    Err(Failure::Errno(8))
}

fn directory_path(
    caller: &Caller<'_, State>,
    fd: u32,
    pointer: usize,
    length: usize,
    right: u64,
) -> Result<(String, String), Failure> {
    let descriptor = caller
        .data()
        .descriptors
        .get(&fd)
        .ok_or(Failure::Errno(8))?;
    if !descriptor.directory {
        return Err(Failure::Errno(54));
    }
    if !descriptor.linked {
        return Err(Failure::Errno(44));
    }
    if descriptor.rights & right == 0 {
        return Err(Failure::Errno(76));
    }
    let raw = bytes(caller, pointer, length)?;
    let raw = std::str::from_utf8(&raw).map_err(|_| Failure::Errno(25))?;
    Ok((confined(&descriptor.path, raw)?, descriptor.path.clone()))
}

fn directory_bytes(entries: &[DirectoryEntry], cookie: u64, length: usize) -> Result<Vec<u8>, i32> {
    let start = usize::try_from(cookie).map_err(|_| 28)?;
    if start > entries.len() {
        return Err(28);
    }
    let mut data = Vec::new();
    for (index, entry) in entries.iter().enumerate().skip(start) {
        if data.len() == length {
            break;
        }
        let mut header = [0u8; 24];
        header[8..16].copy_from_slice(&entry.inode.to_le_bytes());
        header[..8].copy_from_slice(&((index + 1) as u64).to_le_bytes());
        header[16..20].copy_from_slice(&(entry.name.len() as u32).to_le_bytes());
        header[20] = match entry.kind.as_str() {
            "file" => 4,
            "directory" => 3,
            "symlink" => 7,
            _ => return Err(28),
        };
        let remaining = length - data.len();
        data.extend_from_slice(&header[..remaining.min(24)]);
        if remaining < 24 {
            break;
        }
        let remaining = length - data.len();
        data.extend_from_slice(&entry.name.as_bytes()[..remaining.min(entry.name.len())]);
        if remaining < entry.name.len() {
            break;
        }
    }
    Ok(data)
}

fn dispatch(caller: &mut Caller<'_, State>, name: &str, args: &[u64]) -> Result<i32, Failure> {
    let a: Vec<usize> = args.iter().map(|arg| *arg as usize).collect();
    if name.starts_with("fd_")
        && a.first()
            .is_some_and(|fd| caller.data().closed.contains(&(*fd as u32)))
    {
        return Err(Failure::Errno(8));
    }
    match name {
        "proc_signal_mask_v2" => {
            if a[0] > 3 {
                return Err(Failure::Errno(28));
            }
            bytes(caller, a[3], 4)?;
            bytes(caller, a[4], 4)?;
            let previous = caller.data().signal_mask;
            put(caller, a[3], &(previous as u32).to_le_bytes())?;
            put(caller, a[4], &((previous >> 32) as u32).to_le_bytes())?;
            if a[0] == 3 {
                return Ok(0);
            }
            let requested =
                (u64::from(a[1] as u32) | (u64::from(a[2] as u32) << 32)) & !((1 << 8) | (1 << 18));
            caller.data_mut().signal_mask = match a[0] {
                0 => previous | requested,
                1 => previous & !requested,
                _ => requested,
            };
        }
        "fd_pipe" => {
            bytes(caller, a[0], 4)?;
            bytes(caller, a[1], 4)?;
            if caller.data().descriptors.len() + 2 > MAX_FILES {
                return Err(Failure::Errno(33));
            }
            let numbers: Vec<u32> = (0..MAX_FILES as u32 + 4)
                .filter(|fd| {
                    stream(caller.data(), *fd).is_none()
                        && !caller.data().descriptors.contains_key(fd)
                })
                .take(2)
                .collect();
            let [reader, writer] = numbers.as_slice() else {
                return Err(Failure::Errno(33));
            };
            let pipe = Rc::new(Pipe {
                bytes: RefCell::new(VecDeque::new()),
                readers: Cell::new(1),
                writers: Cell::new(1),
            });
            let mut metadata = [0u8; 76];
            metadata[64..68].copy_from_slice(&0o10600u32.to_le_bytes());
            for (fd, read) in [(*reader, true), (*writer, false)] {
                caller.data_mut().descriptors.insert(
                    fd,
                    Descriptor {
                        path: "/".into(),
                        directory: false,
                        read,
                        write: !read,
                        flags: Rc::new(Cell::new(0)),
                        offset: Rc::new(Cell::new(0)),
                        stdio: None,
                        pipe: Some(Rc::new(PipeEndpoint {
                            pipe: pipe.clone(),
                            reading: read,
                        })),
                        rights: (if read { 2 } else { 64 }) | (1 << 3) | (1 << 21) | (1 << 27),
                        inheriting: 0,
                        cache: None,
                        linked: false,
                        metadata,
                    },
                );
                caller.data_mut().closed.remove(&fd);
                caller.data_mut().cloexec.remove(&fd);
            }
            put(caller, a[0], &reader.to_le_bytes())?;
            put(caller, a[1], &writer.to_le_bytes())?;
        }
        "fd_dup" | "fd_dup2" => {
            let source = duplicate_source(caller.data(), a[0] as u32)?;
            let target = if name == "fd_dup" {
                bytes(caller, a[1], 4)?;
                (0..MAX_FILES as u32 + 4)
                    .find(|fd| {
                        stream(caller.data(), *fd).is_none()
                            && !caller.data().descriptors.contains_key(fd)
                    })
                    .ok_or(Failure::Errno(33))?
            } else {
                let target = a[1] as u32;
                if target >= MAX_FILES as u32 + 4 {
                    return Err(Failure::Errno(8));
                }
                if target == a[0] as u32 {
                    return Ok(0);
                }
                target
            };
            let replacing = stream(caller.data(), target).is_some()
                || caller.data().descriptors.contains_key(&target);
            if !replacing && caller.data().descriptors.len() >= MAX_FILES {
                return Err(Failure::Errno(33));
            }
            let state = caller.data_mut();
            if replacing {
                close(state, target);
            }
            state.descriptors.insert(target, source);
            state.closed.remove(&target);
            state.cloexec.remove(&target);
            if name == "fd_dup" {
                put(caller, a[1], &target.to_le_bytes())?;
            }
        }
        "fd_renumber" => {
            let from = a[0] as u32;
            let to = a[1] as u32;
            let source = duplicate_source(caller.data(), from)?;
            duplicate_source(caller.data(), to)?;
            if from == to {
                return Ok(0);
            }
            let state = caller.data_mut();
            let cloexec = state.cloexec.contains(&from);
            let directory = state.directories.remove(&from);
            close(state, to);
            state.descriptors.insert(to, source);
            state.closed.remove(&to);
            close(state, from);
            if cloexec {
                state.cloexec.insert(to);
            }
            if let Some(entries) = directory {
                state.directories.insert(to, entries);
            }
        }
        "fd_getfd" | "fd_setfd" => {
            duplicate_source(caller.data(), a[0] as u32)?;
            if name == "fd_getfd" {
                bytes(caller, a[1], 4)?;
                let flags = u32::from(caller.data().cloexec.contains(&(a[0] as u32)));
                put(caller, a[1], &flags.to_le_bytes())?;
            } else {
                if a[1] & !1 != 0 {
                    return Err(Failure::Errno(28));
                }
                if a[1] & 1 != 0 {
                    caller.data_mut().cloexec.insert(a[0] as u32);
                } else {
                    caller.data_mut().cloexec.remove(&(a[0] as u32));
                }
            }
        }

        "isatty" => {
            let fd = a[0] as u32;
            if (fd >= 3 || caller.data().closed.contains(&fd))
                && !caller.data().descriptors.contains_key(&fd)
            {
                return Err(Failure::Errno(8));
            }
            bytes(caller, a[1], 4)?;
            put(caller, a[1], &0u32.to_le_bytes())?;
            return Ok(0);
        }
        "fd_mode" | "fd_size" | "fd_blocks" | "fd_owner" | "path_mode" | "path_size"
        | "path_blocks" | "path_owner" => {
            let projection = match name {
                "fd_mode" | "path_mode" => StatProjection::Mode,
                "fd_size" | "path_size" => StatProjection::Size,
                "fd_blocks" | "path_blocks" => StatProjection::Blocks,
                _ => StatProjection::Owner,
            };
            let pointers = if matches!(projection, StatProjection::Owner) {
                let start = if name.starts_with("fd_") { 1 } else { 4 };
                bytes(caller, a[start], 4)?;
                bytes(caller, a[start + 1], 4)?;
                Some((a[start], a[start + 1]))
            } else {
                None
            };
            if name.starts_with("fd_") {
                let fd = a[0] as u32;
                if stream(caller.data(), fd).is_some()
                    || caller
                        .data()
                        .descriptors
                        .get(&fd)
                        .is_some_and(|descriptor| descriptor.pipe.is_some())
                {
                    if let Some((uid, gid)) = pointers {
                        put(caller, uid, &0u32.to_le_bytes())?;
                        put(caller, gid, &0u32.to_le_bytes())?;
                    }
                    return Ok(match projection {
                        StatProjection::Mode => {
                            if stream(caller.data(), fd).is_some() {
                                0o20000
                            } else {
                                0o10600
                            }
                        }
                        _ => 0,
                    });
                }
                let descriptor = caller
                    .data()
                    .descriptors
                    .get(&fd)
                    .ok_or(Failure::Errno(8))?;
                if descriptor.rights & (1 << 21) == 0 {
                    return Err(Failure::Errno(76));
                }
                let path = if descriptor.linked {
                    Some(descriptor.path.clone())
                } else {
                    None
                };
                let write = descriptor.write;
                suspend(
                    caller,
                    Request::FdStat { fd, path, write },
                    Completion::HostStat {
                        fd: Some(fd),
                        projection,
                        pointers,
                    },
                )?;
            } else {
                if a[3] > 1 {
                    return Err(Failure::Errno(28));
                }
                let (path, base) = directory_path(caller, a[0] as u32, a[1], a[2], 1 << 18)?;
                suspend(
                    caller,
                    Request::PathStat {
                        path,
                        base,
                        follow: a[3] != 0,
                    },
                    Completion::HostStat {
                        fd: None,
                        projection,
                        pointers,
                    },
                )?;
            }
        }
        "args_sizes_get" | "environ_sizes_get" => {
            bytes(caller, a[0], 4)?;
            bytes(caller, a[1], 4)?;
            let values = if name == "args_sizes_get" {
                &caller.data().argv
            } else {
                &caller.data().environment
            };
            let count = values.len() as u32;
            let size = values.iter().map(Vec::len).sum::<usize>() as u32;
            put(caller, a[0], &count.to_le_bytes())?;
            put(caller, a[1], &size.to_le_bytes())?;
        }
        "args_get" | "environ_get" => {
            let values = if name == "args_get" {
                &caller.data().argv
            } else {
                &caller.data().environment
            };
            if values.is_empty() {
                return Ok(0);
            }
            let size: usize = values.iter().map(Vec::len).sum();
            let array_end = a[0]
                .checked_add(values.len() * 4)
                .ok_or(Failure::Errno(21))?;
            let buffer_end = a[1].checked_add(size).ok_or(Failure::Errno(21))?;
            if memory(caller)?
                .data(&*caller)
                .get(a[0]..array_end)
                .is_none()
                || memory(caller)?
                    .data(&*caller)
                    .get(a[1]..buffer_end)
                    .is_none()
            {
                return Err(Failure::Errno(21));
            }
            let values = values.clone();
            let mut offset = a[1];
            for (index, value) in values.iter().enumerate() {
                put(caller, a[0] + index * 4, &(offset as u32).to_le_bytes())?;
                put(caller, offset, value)?;
                offset += value.len();
            }
        }
        "sched_yield" => {}
        "fd_prestat_get" => {
            if (a[0] != 3 && a[0] as u32 != HIDDEN_PREOPEN)
                || !caller
                    .data()
                    .descriptors
                    .get(&(a[0] as u32))
                    .is_some_and(|descriptor| {
                        descriptor.directory && descriptor.path == "/" && descriptor.linked
                    })
            {
                return Err(Failure::Errno(8));
            }
            put(caller, a[1], &[0, 0, 0, 0, 1, 0, 0, 0])?;
        }
        "fd_prestat_dir_name" => {
            if (a[0] != 3 && a[0] as u32 != HIDDEN_PREOPEN)
                || !caller
                    .data()
                    .descriptors
                    .get(&(a[0] as u32))
                    .is_some_and(|descriptor| {
                        descriptor.directory && descriptor.path == "/" && descriptor.linked
                    })
            {
                return Err(Failure::Errno(8));
            }
            if a[2] < 1 {
                return Err(Failure::Errno(37));
            }
            put(caller, a[1], b"/")?;
        }
        "fd_fdstat_get" => {
            let mut stat = [0u8; 24];
            if let Some(index) = stream(caller.data(), a[0] as u32) {
                stat[0] = 2;
                stat[2..4].copy_from_slice(
                    &caller.data().stdio_flags[index as usize]
                        .get()
                        .to_le_bytes(),
                );
                let rights: u64 = (if index == 0 { 2 } else { 64 }) | (1 << 27) | (1 << 3);
                stat[8..16].copy_from_slice(&rights.to_le_bytes());
            } else {
                let descriptor = caller
                    .data()
                    .descriptors
                    .get(&(a[0] as u32))
                    .ok_or(Failure::Errno(8))?;
                stat[0] = if descriptor.pipe.is_some() {
                    0
                } else if descriptor.directory {
                    3
                } else {
                    4
                };
                stat[2..4].copy_from_slice(&descriptor.flags.get().to_le_bytes());
                stat[8..16].copy_from_slice(&descriptor.rights.to_le_bytes());
                stat[16..24].copy_from_slice(&descriptor.inheriting.to_le_bytes());
            }
            put(caller, a[1], &stat)?;
        }
        "fd_fdstat_set_flags" => {
            if a[1] & !5 != 0 {
                return Err(Failure::Errno(58));
            }
            if let Some(index) = stream(caller.data(), a[0] as u32) {
                caller.data().stdio_flags[index as usize].set(a[1] as u16);
                return Ok(0);
            }
            let descriptor = caller
                .data_mut()
                .descriptors
                .get_mut(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            if descriptor.rights & (1 << 3) == 0 {
                return Err(Failure::Errno(76));
            }
            descriptor.flags.set(a[1] as u16);
        }
        "fd_read" | "fd_pread" => {
            let output = *a.last().ok_or(Failure::Errno(28))?;
            bytes(caller, output, 4)?;
            let vectors = vectors(caller, a[1], a[2])?;
            if stream(caller.data(), a[0] as u32) == Some(0) {
                if name == "fd_pread" {
                    return Err(Failure::Errno(70));
                }
                let mut read = 0usize;
                for (pointer, length) in vectors {
                    let state = caller.data();
                    let start = state.stdin_offset;
                    let end = start.saturating_add(length).min(state.stdin.len());
                    let data = state.stdin[start..end].to_vec();
                    put(caller, pointer, &data)?;
                    caller.data_mut().stdin_offset = end;
                    read += data.len();
                    if data.len() < length {
                        break;
                    }
                }
                put(caller, output, &(read as u32).to_le_bytes())?;
                return Ok(0);
            }
            let descriptor = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .cloned()
                .ok_or(Failure::Errno(8))?;
            if descriptor.directory {
                return Err(Failure::Errno(31));
            }
            if !descriptor.read || (name == "fd_pread" && descriptor.rights & 4 == 0) {
                return Err(Failure::Errno(76));
            }
            if let Some(pipe) = &descriptor.pipe {
                if name == "fd_pread" {
                    return Err(Failure::Errno(70));
                }
                for (pointer, length) in &vectors {
                    bytes(caller, *pointer, *length)?;
                }
                let wanted: usize = vectors.iter().map(|(_, length)| length).sum();
                if wanted == 0 {
                    put(caller, output, &0u32.to_le_bytes())?;
                    return Ok(0);
                }
                if pipe.pipe.bytes.borrow().is_empty() && pipe.has_peer() {
                    if descriptor.flags.get() & 4 != 0 {
                        return Err(Failure::Errno(6));
                    }
                    suspend(
                        caller,
                        Request::Poll {
                            clocks: Vec::new(),
                            immediate: false,
                        },
                        Completion::Unit,
                    )?;
                }
                let mut read = 0usize;
                for (pointer, length) in vectors {
                    let available = pipe.pipe.bytes.borrow().len();
                    let data: Vec<u8> = pipe
                        .pipe
                        .bytes
                        .borrow_mut()
                        .drain(..length.min(available))
                        .collect();
                    put(caller, pointer, &data)?;
                    read += data.len();
                    if data.len() < length {
                        break;
                    }
                }
                put(caller, output, &(read as u32).to_le_bytes())?;
                return Ok(0);
            }
            let mut offset = if name == "fd_pread" {
                usize::try_from(args[3]).map_err(|_| Failure::Errno(28))?
            } else {
                descriptor.offset.get()
            };
            let mut read = 0usize;
            for (pointer, length) in vectors {
                let data = caller
                    .data()
                    .files
                    .get(&descriptor.cache.ok_or(Failure::Errno(8))?)
                    .ok_or(Failure::Errno(8))?;
                let data = &data.bytes;
                let start = offset.min(data.len());
                let end = start.saturating_add(length).min(data.len());
                let data = data[start..end].to_vec();
                put(caller, pointer, &data)?;
                offset += data.len();
                read += data.len();
                if data.len() < length {
                    break;
                }
            }
            if name == "fd_read" {
                caller
                    .data_mut()
                    .descriptors
                    .get_mut(&(a[0] as u32))
                    .ok_or(Failure::Errno(8))?
                    .offset
                    .set(offset);
            }
            put(caller, output, &(read as u32).to_le_bytes())?;
        }
        "fd_write" | "fd_pwrite" => {
            let output = *a.last().ok_or(Failure::Errno(28))?;
            bytes(caller, output, 4)?;
            let vectors = vectors(caller, a[1], a[2])?;
            let mut data = Vec::new();
            for (pointer, length) in vectors {
                data.extend(bytes(caller, pointer, length)?);
            }
            if let Some(index @ (1 | 2)) = stream(caller.data(), a[0] as u32) {
                if name == "fd_pwrite" {
                    return Err(Failure::Errno(70));
                }
                let state = caller.data_mut();
                if state.stdout.len() + state.stderr.len() + data.len() > state.max_output {
                    return Err(Failure::Errno(22));
                }
                if index == 1 {
                    state.stdout.extend(&data);
                } else {
                    state.stderr.extend(&data);
                }
            } else {
                let state = caller.data_mut();
                let descriptor = state
                    .descriptors
                    .get(&(a[0] as u32))
                    .cloned()
                    .ok_or(Failure::Errno(8))?;
                if descriptor.directory {
                    return Err(Failure::Errno(31));
                }
                if !descriptor.write || (name == "fd_pwrite" && descriptor.rights & 4 == 0) {
                    return Err(Failure::Errno(76));
                }
                if data.is_empty() {
                    put(caller, output, &0u32.to_le_bytes())?;
                    return Ok(0);
                }
                if let Some(pipe) = &descriptor.pipe {
                    if name == "fd_pwrite" {
                        return Err(Failure::Errno(70));
                    }
                    if !pipe.has_peer() {
                        return Err(Failure::Errno(64));
                    }
                    let available = PIPE_BYTES.saturating_sub(pipe.pipe.bytes.borrow().len());
                    if available == 0 || (data.len() <= PIPE_ATOMIC_BYTES && available < data.len())
                    {
                        if descriptor.flags.get() & 4 != 0 {
                            return Err(Failure::Errno(6));
                        }
                        suspend(
                            caller,
                            Request::Poll {
                                clocks: Vec::new(),
                                immediate: false,
                            },
                            Completion::Unit,
                        )?;
                    }
                    let count = data.len().min(available);
                    pipe.pipe.bytes.borrow_mut().extend(&data[..count]);
                    put(caller, output, &(count as u32).to_le_bytes())?;
                    return Ok(0);
                }
                let file = &state
                    .files
                    .get(&descriptor.cache.ok_or(Failure::Errno(8))?)
                    .ok_or(Failure::Errno(8))?
                    .bytes;
                let offset = if name == "fd_pwrite" {
                    usize::try_from(args[3]).map_err(|_| Failure::Errno(28))?
                } else if descriptor.flags.get() & 1 != 0 {
                    file.len()
                } else {
                    descriptor.offset.get()
                };
                let end = offset.checked_add(data.len()).ok_or(Failure::Errno(22))?;
                let total: usize = state.files.values().map(|file| file.bytes.len()).sum();
                if end > MAX_BYTES {
                    return Err(Failure::Errno(22));
                }
                if total - file.len() + file.len().max(end) > MAX_BYTES {
                    return Err(Failure::Errno(48));
                }
                let file = state
                    .files
                    .get_mut(&descriptor.cache.ok_or(Failure::Errno(8))?)
                    .ok_or(Failure::Errno(8))?;
                let linked_path = file.path.clone();
                let file = &mut file.bytes;
                let previous_length = file.len();
                let previous = file[offset.min(file.len())..end.min(file.len())].to_vec();
                if end > file.len() {
                    file.resize(end, 0);
                }
                file[offset..end].copy_from_slice(&data);
                let path = linked_path;
                suspend(
                    caller,
                    Request::Flush {
                        path,
                        fd: a[0] as u32,
                    },
                    Completion::Flush {
                        fd: a[0] as u32,
                        pointer: Some(output),
                        length: data.len(),
                        previous,
                        previous_length,
                        start: offset,
                        previous_offset: descriptor.offset.get(),
                        offset: end,
                        positioned: name == "fd_pwrite",
                    },
                )?;
            }
            put(caller, output, &(data.len() as u32).to_le_bytes())?;
        }
        "fd_filestat_set_size" | "fd_allocate" => {
            let state = caller.data_mut();
            let descriptor = state
                .descriptors
                .get(&(a[0] as u32))
                .cloned()
                .ok_or(Failure::Errno(8))?;
            let right = if name == "fd_allocate" {
                1 << 8
            } else {
                1 << 22
            };
            if descriptor.rights & right == 0 {
                return Err(Failure::Errno(76));
            }
            if descriptor.directory {
                return Err(Failure::Errno(31));
            }
            let requested = if name == "fd_allocate" {
                args[1].checked_add(args[2]).ok_or(Failure::Errno(61))?
            } else {
                args[1]
            };
            let size = usize::try_from(requested).map_err(|_| Failure::Errno(22))?;
            if size > MAX_BYTES {
                return Err(Failure::Errno(22));
            }
            let cache = descriptor.cache.ok_or(Failure::Errno(8))?;
            let previous_length = state
                .files
                .get(&cache)
                .ok_or(Failure::Errno(8))?
                .bytes
                .len();
            let size = if name == "fd_allocate" {
                size.max(previous_length)
            } else {
                size
            };
            let total: usize = state.files.values().map(|file| file.bytes.len()).sum();
            if total - previous_length + size > MAX_BYTES {
                return Err(Failure::Errno(48));
            }
            let file = state.files.get_mut(&cache).ok_or(Failure::Errno(8))?;
            let previous = file.bytes[size.min(previous_length)..].to_vec();
            let path = file.path.clone();
            file.bytes.resize(size, 0);
            suspend(
                caller,
                Request::Flush {
                    path,
                    fd: a[0] as u32,
                },
                Completion::Flush {
                    fd: a[0] as u32,
                    pointer: None,
                    length: 0,
                    previous,
                    previous_length,
                    start: size,
                    previous_offset: descriptor.offset.get(),
                    offset: descriptor.offset.get(),
                    positioned: true,
                },
            )?;
        }
        "fd_filestat_set_times" => {
            let flags = a[3];
            if flags & !15 != 0 || flags & 3 == 3 || flags & 12 == 12 {
                return Err(Failure::Errno(28));
            }
            let descriptor = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            if descriptor.rights & (1 << 23) == 0 {
                return Err(Failure::Errno(76));
            }
            let path = if descriptor.linked {
                Some(descriptor.path.clone())
            } else {
                None
            };
            suspend(
                caller,
                Request::FdTimes {
                    fd: a[0] as u32,
                    path,
                    atime: args[1].to_string(),
                    mtime: args[2].to_string(),
                    flags: flags as u16,
                },
                Completion::Metadata {
                    fd: Some(a[0] as u32),
                },
            )?;
        }
        "path_filestat_set_times" => {
            let flags = a[6];
            if a[1] & !1 != 0 || flags & !15 != 0 || flags & 3 == 3 || flags & 12 == 12 {
                return Err(Failure::Errno(28));
            }
            let (path, base) = directory_path(caller, a[0] as u32, a[2], a[3], 1 << 20)?;
            suspend(
                caller,
                Request::PathTimes {
                    path,
                    base,
                    follow: a[1] & 1 != 0,
                    atime: args[4].to_string(),
                    mtime: args[5].to_string(),
                    flags: flags as u16,
                },
                Completion::Metadata { fd: None },
            )?;
        }
        "poll_oneoff" => {
            if a[2] == 0 || a[2] > 128 {
                return Err(Failure::Errno(28));
            }
            let subscriptions = bytes(
                caller,
                a[0],
                a[2].checked_mul(48).ok_or(Failure::Errno(21))?,
            )?;
            bytes(
                caller,
                a[1],
                a[2].checked_mul(32).ok_or(Failure::Errno(21))?,
            )?;
            bytes(caller, a[3], 4)?;
            let mut clocks = Vec::new();
            let mut clock_indices = BTreeSet::new();
            let mut events = Vec::new();
            let mut blocked = BTreeSet::new();
            let state = caller.data();
            for (index, subscription) in subscriptions.as_chunks::<48>().0.iter().enumerate() {
                let mut event = [0u8; 32];
                event[..8].copy_from_slice(&subscription[..8]);
                event[10] = subscription[8];
                let mut errno = 0u16;
                match subscription[8] {
                    0 => {
                        let clock = u32::from_le_bytes(
                            subscription[16..20]
                                .try_into()
                                .map_err(|_| Failure::Errno(28))?,
                        );
                        let flags = u16::from_le_bytes(
                            subscription[40..42]
                                .try_into()
                                .map_err(|_| Failure::Errno(28))?,
                        );
                        if flags & !1 != 0 {
                            errno = 28;
                        } else if clock > 1 {
                            errno = 58;
                        } else {
                            let timeout = u64::from_le_bytes(
                                subscription[24..32]
                                    .try_into()
                                    .map_err(|_| Failure::Errno(28))?,
                            );
                            let precision = u64::from_le_bytes(
                                subscription[32..40]
                                    .try_into()
                                    .map_err(|_| Failure::Errno(28))?,
                            );
                            clocks.push(PollClock {
                                index,
                                clock,
                                timeout: timeout.to_string(),
                                precision: precision.to_string(),
                                absolute: flags & 1 != 0,
                            });
                            clock_indices.insert(index);
                        }
                    }
                    1 | 2 => {
                        let fd = u32::from_le_bytes(
                            subscription[16..20]
                                .try_into()
                                .map_err(|_| Failure::Errno(28))?,
                        );
                        let writing = subscription[8] == 2;
                        if state.closed.contains(&fd) {
                            errno = 8;
                        } else if let Some(index) = stream(state, fd) {
                            if index == 0 && !writing {
                                let available =
                                    state.stdin.len().saturating_sub(state.stdin_offset);
                                event[16..24].copy_from_slice(&(available as u64).to_le_bytes());
                                if available == 0 {
                                    event[24..26].copy_from_slice(&1u16.to_le_bytes());
                                }
                            } else if index > 0 && writing {
                                let available = state
                                    .max_output
                                    .saturating_sub(state.stdout.len() + state.stderr.len());
                                event[16..24].copy_from_slice(&(available as u64).to_le_bytes());
                                if available == 0 {
                                    errno = 22;
                                }
                            } else {
                                errno = 76;
                            }
                        } else if let Some(descriptor) = state.descriptors.get(&fd) {
                            if descriptor.rights & (1 << 27) == 0
                                || (writing && !descriptor.write)
                                || (!writing && !descriptor.read)
                            {
                                errno = 76;
                            } else if descriptor.directory {
                                errno = 31;
                            } else if let Some(pipe) = &descriptor.pipe {
                                let length = pipe.pipe.bytes.borrow().len();
                                let peer = pipe.has_peer();
                                let available = if writing { PIPE_BYTES - length } else { length };
                                event[16..24].copy_from_slice(&(available as u64).to_le_bytes());
                                if writing && !peer {
                                    errno = 64;
                                } else if !writing && !peer {
                                    event[24..26].copy_from_slice(&1u16.to_le_bytes());
                                } else if available == 0 {
                                    blocked.insert(index);
                                }
                            } else if let Some(file) =
                                descriptor.cache.and_then(|cache| state.files.get(&cache))
                            {
                                let available = if writing {
                                    let total: usize =
                                        state.files.values().map(|file| file.bytes.len()).sum();
                                    let position = if descriptor.flags.get() & 1 != 0 {
                                        file.bytes.len()
                                    } else {
                                        descriptor.offset.get()
                                    };
                                    (MAX_BYTES - (total - file.bytes.len()))
                                        .saturating_sub(position)
                                } else {
                                    file.bytes.len().saturating_sub(descriptor.offset.get())
                                };
                                event[16..24].copy_from_slice(&(available as u64).to_le_bytes());
                            } else {
                                errno = 8;
                            }
                        } else {
                            errno = 8;
                        }
                    }
                    _ => return Err(Failure::Errno(28)),
                }
                event[8..10].copy_from_slice(&errno.to_le_bytes());
                events.push(event);
            }
            let immediate = events.len() != clock_indices.len() + blocked.len();
            suspend(
                caller,
                Request::Poll { clocks, immediate },
                Completion::Poll {
                    events,
                    clocks: clock_indices,
                    blocked,
                    pointer: a[1],
                    output: a[3],
                },
            )?;
        }
        "fd_filestat_get" => {
            bytes(caller, a[1], 64)?;
            let descriptor = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            if descriptor.rights & (1 << 21) == 0 {
                return Err(Failure::Errno(76));
            }
            if descriptor.pipe.is_some() {
                let metadata = descriptor.metadata;
                put(caller, a[1], &metadata[..64])?;
                return Ok(0);
            }
            let path = if descriptor.linked {
                Some(descriptor.path.clone())
            } else {
                None
            };
            let write = descriptor.write;
            suspend(
                caller,
                Request::FdStat {
                    fd: a[0] as u32,
                    path,
                    write,
                },
                Completion::Stat {
                    fd: Some(a[0] as u32),
                    pointer: a[1],
                },
            )?;
        }
        "path_filestat_get" => {
            bytes(caller, a[4], 64)?;
            if a[1] & !1 != 0 {
                return Err(Failure::Errno(28));
            }
            let (path, base) = directory_path(caller, a[0] as u32, a[2], a[3], 1 << 18)?;
            suspend(
                caller,
                Request::PathStat {
                    path,
                    base,
                    follow: a[1] & 1 != 0,
                },
                Completion::Stat {
                    fd: None,
                    pointer: a[4],
                },
            )?;
        }
        "path_create_directory"
        | "path_remove_directory"
        | "path_unlink_file"
        | "path_readlink" => {
            let right = match name {
                "path_create_directory" => 1 << 9,
                "path_remove_directory" => 1 << 25,
                "path_unlink_file" => 1 << 26,
                _ => 1 << 15,
            };
            let (path, base) = directory_path(caller, a[0] as u32, a[1], a[2], right)?;
            match name {
                "path_create_directory" => {
                    suspend(caller, Request::Mkdir { path, base }, Completion::Unit)?;
                }
                "path_remove_directory" | "path_unlink_file" => {
                    suspend(
                        caller,
                        Request::Remove {
                            path,
                            base,
                            directory: name == "path_remove_directory",
                        },
                        Completion::Remove,
                    )?;
                }
                _ => {
                    bytes(caller, a[3], a[4])?;
                    bytes(caller, a[5], 4)?;
                    suspend(
                        caller,
                        Request::Readlink { path, base },
                        Completion::Readlink {
                            pointer: a[3],
                            length: a[4],
                            output: a[5],
                        },
                    )?;
                }
            }
        }
        "path_rename" => {
            let (from, from_base) = directory_path(caller, a[0] as u32, a[1], a[2], 1 << 16)?;
            let (to, to_base) = directory_path(caller, a[3] as u32, a[4], a[5], 1 << 17)?;
            suspend(
                caller,
                Request::Rename {
                    from,
                    from_base,
                    to,
                    to_base,
                },
                Completion::Rename,
            )?;
        }
        "path_symlink" => {
            let (path, base) = directory_path(caller, a[2] as u32, a[3], a[4], 1 << 24)?;
            let target = bytes(caller, a[0], a[1])?;
            let target = std::str::from_utf8(&target)
                .map_err(|_| Failure::Errno(25))?
                .to_string();
            if target.is_empty() || target.len() > 4096 || target.contains('\0') {
                return Err(Failure::Errno(28));
            }
            suspend(
                caller,
                Request::Symlink { path, base, target },
                Completion::Unit,
            )?;
        }
        "fd_readdir" => {
            bytes(caller, a[1], a[2])?;
            bytes(caller, a[4], 4)?;
            let descriptor = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            if !descriptor.directory {
                return Err(Failure::Errno(54));
            }
            if descriptor.rights & (1 << 14) == 0 {
                return Err(Failure::Errno(76));
            }
            if !descriptor.linked {
                put(caller, a[4], &0u32.to_le_bytes())?;
                return Ok(0);
            }
            if args[3] == 0 || !caller.data().directories.contains_key(&(a[0] as u32)) {
                let path = descriptor.path.clone();
                suspend(
                    caller,
                    Request::Directory {
                        path,
                        fd: a[0] as u32,
                    },
                    Completion::Directory {
                        fd: a[0] as u32,
                        pointer: a[1],
                        length: a[2],
                        cookie: args[3],
                        output: a[4],
                    },
                )?;
            }
            let entries = caller
                .data()
                .directories
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            let data = directory_bytes(entries, args[3], a[2]).map_err(Failure::Errno)?;
            put(caller, a[1], &data)?;
            put(caller, a[4], &(data.len() as u32).to_le_bytes())?;
        }
        "set_open_mode" => caller.data_mut().open_mode = Some(a[0] as u32 & 0o7777),
        "set_open_direct" => caller.data_mut().open_direct = a[0] != 0,
        "net_recv" | "net_send" => {
            let fd = a[0] as u32;
            if (fd < 3 && !caller.data().closed.contains(&fd))
                || caller.data().descriptors.contains_key(&fd)
            {
                return Err(Failure::Errno(57));
            }
            return Err(Failure::Errno(8));
        }
        "open_tmpfile" => {
            bytes(caller, a[5], 4)?;
            if caller.data().descriptors.len() >= MAX_FILES {
                return Err(Failure::Errno(33));
            }
            if a[3] & !(0x04000000 | 0x10000000 | 1 | 4 | (4 << 12)) != 0 {
                return Err(Failure::Errno(58));
            }
            let parent = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            if !parent.directory {
                return Err(Failure::Errno(54));
            }
            if !parent.linked {
                return Err(Failure::Errno(44));
            }
            if parent.rights & (1 << 10) == 0 {
                return Err(Failure::Errno(76));
            }
            let base = parent.path.clone();
            let raw = bytes(caller, a[1], a[2])?;
            let raw = std::str::from_utf8(&raw).map_err(|_| Failure::Errno(25))?;
            let path = confined(&base, raw)?;
            let read = a[3] & 0x04000000 != 0;
            let write = a[3] & 0x10000000 != 0;
            let rights = (1 << 21)
                | (1 << 27)
                | 4
                | 32
                | 8
                | 16
                | 1
                | (1 << 22)
                | (1 << 23)
                | (1 << 8)
                | if read { 2 } else { 0 }
                | if write { 64 } else { 0 };
            if rights & !parent.inheriting != 0 {
                return Err(Failure::Errno(76));
            }
            let descriptor = Descriptor {
                path: path.clone(),
                directory: false,
                read,
                write,
                flags: Rc::new(Cell::new((a[3] & 5) as u16)),
                offset: Rc::new(Cell::new(0)),
                stdio: None,
                pipe: None,
                rights,
                inheriting: 0,
                cache: None,
                linked: false,
                metadata: [0; 76],
            };
            suspend(
                caller,
                Request::Tmpfile {
                    path,
                    base,
                    read,
                    mode: a[4] as u32 & 0o7777,
                },
                Completion::Tmpfile {
                    descriptor,
                    pointer: a[5],
                },
            )?;
        }
        "path_open" => {
            let mode = caller.data_mut().open_mode.take().unwrap_or(0o644);
            let direct = std::mem::take(&mut caller.data_mut().open_direct);
            if direct {
                return Err(Failure::Errno(58));
            }
            if mode > 0o777 {
                return Err(Failure::Errno(28));
            }
            bytes(caller, a[8], 4)?;
            if a[1] & !1 != 0 || a[4] & !15 != 0 || a[7] & !5 != 0 {
                return Err(Failure::Errno(58));
            }
            if caller.data().descriptors.len() >= MAX_FILES {
                return Err(Failure::Errno(33));
            }
            let parent = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?;
            if !parent.linked {
                return Err(Failure::Errno(44));
            }
            if !parent.directory {
                return Err(Failure::Errno(54));
            }
            if parent.rights & (1 << 13) == 0
                || args[5] & !parent.inheriting != 0
                || args[6] & !parent.inheriting != 0
            {
                return Err(Failure::Errno(76));
            }
            let base = parent.path.clone();
            let raw = bytes(caller, a[2], a[3])?;
            let raw = std::str::from_utf8(&raw).map_err(|_| Failure::Errno(25))?;
            let path = confined(&base, raw)?;
            let read = args[5] & 2 != 0;
            let write = args[5] & 64 != 0;
            let directory = a[4] & 2 != 0;
            let descriptor = Descriptor {
                path: path.clone(),
                directory,
                read,
                write,
                flags: Rc::new(Cell::new(a[7] as u16)),
                offset: Rc::new(Cell::new(0)),
                stdio: None,
                pipe: None,
                rights: args[5],
                inheriting: args[6],
                cache: None,
                linked: true,
                metadata: [0; 76],
            };
            suspend(
                caller,
                Request::Open {
                    path,
                    base,
                    read,
                    write,
                    create: a[4] & 1 != 0,
                    truncate: a[4] & 8 != 0,
                    exclusive: a[4] & 4 != 0,
                    directory,
                    follow: a[1] & 1 != 0,
                    mode,
                },
                Completion::Open {
                    descriptor,
                    pointer: a[8],
                    truncate: a[4] & 8 != 0,
                },
            )?;
        }
        "fd_close" => {
            if a[0] as u32 == HIDDEN_PREOPEN {
                return Err(Failure::Errno(8));
            }
            if a[0] < 3 && !caller.data().descriptors.contains_key(&(a[0] as u32)) {
                close(caller.data_mut(), a[0] as u32);
                return Ok(0);
            }
            if !caller.data().descriptors.contains_key(&(a[0] as u32)) {
                return Err(Failure::Errno(8));
            }
            close(caller.data_mut(), a[0] as u32);
        }
        "fd_sync" | "fd_datasync" => {
            if stream(caller.data(), a[0] as u32).is_some() {
                return Err(Failure::Errno(76));
            }
            if !caller.data().descriptors.contains_key(&(a[0] as u32)) {
                return Err(Failure::Errno(8));
            }
            let rights = caller
                .data()
                .descriptors
                .get(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?
                .rights;
            let required = if name == "fd_sync" { 1 << 4 } else { 1 };
            if rights & required == 0 {
                return Err(Failure::Errno(76));
            }
            suspend(caller, Request::Sync, Completion::Sync)?;
        }
        "fd_seek" | "fd_tell" => {
            let output = *a.last().ok_or(Failure::Errno(28))?;
            bytes(caller, output, 8)?;
            if stream(caller.data(), a[0] as u32).is_some() {
                return Err(Failure::Errno(70));
            }
            let state = caller.data_mut();
            let descriptor = state
                .descriptors
                .get(&(a[0] as u32))
                .cloned()
                .ok_or(Failure::Errno(8))?;
            if descriptor.pipe.is_some() {
                return Err(Failure::Errno(70));
            }
            if descriptor.directory {
                return Err(Failure::Errno(31));
            }
            let required = if name == "fd_seek" { 4 } else { 32 };
            if descriptor.rights & required == 0 {
                return Err(Failure::Errno(76));
            }
            let offset = if name == "fd_tell" {
                descriptor.offset.get()
            } else {
                let base = match a[2] {
                    0 => 0,
                    1 => descriptor.offset.get(),
                    2 => state
                        .files
                        .get(&descriptor.cache.ok_or(Failure::Errno(8))?)
                        .ok_or(Failure::Errno(8))?
                        .bytes
                        .len(),
                    _ => return Err(Failure::Errno(28)),
                };
                let offset = (base as i128) + (args[1] as i64 as i128);
                if offset < 0 || offset > MAX_BYTES as i128 {
                    return Err(Failure::Errno(28));
                }
                offset as usize
            };
            state
                .descriptors
                .get_mut(&(a[0] as u32))
                .ok_or(Failure::Errno(8))?
                .offset
                .set(offset);
            put(caller, output, &(offset as u64).to_le_bytes())?;
        }
        "random_get" => {
            if a[1] > 65_536 {
                return Err(Failure::Errno(22));
            }
            bytes(caller, a[0], a[1])?;
            suspend(
                caller,
                Request::Random { length: a[1] },
                Completion::Bytes {
                    pointer: a[0],
                    length: a[1],
                },
            )?;
        }
        "clock_res_get" => {
            if a[0] > 1 {
                return Err(Failure::Errno(58));
            }
            put(caller, a[1], &1_000_000u64.to_le_bytes())?;
        }
        "clock_time_get" => {
            if a[0] > 1 {
                return Err(Failure::Errno(58));
            }
            bytes(caller, a[2], 8)?;
            suspend(
                caller,
                Request::Clock { clock: a[0] as u32 },
                Completion::Clock { pointer: a[2] },
            )?;
        }
        _ => return Err(Failure::Errno(58)),
    }
    Ok(0)
}

fn linker(engine: &Engine) -> Result<Linker<State>, String> {
    let mut linker = Linker::new(engine);
    macro_rules! bind {
        ($namespace:literal,$name:literal $(,$arg:ident:$type:ty)*) => {
            linker.func_wrap($namespace,$name,|mut caller:Caller<'_,State>,$($arg:$type),*| -> Result<i32,Error> {
                match dispatch(&mut caller,$name,&[$($arg as u64),*]) {
                    Ok(value) => Ok(value),
                    Err(Failure::Errno(errno)) => Ok(errno),
                    Err(Failure::Suspend) => Err(Error::new("Cirro host request")),
                    Err(Failure::Budget) => Err(Error::new("WASI host request budget exceeded")),
                }
            }).map_err(|error|error.to_string())?;
        }
    }
    bind!("wasi_snapshot_preview1","args_sizes_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","args_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","environ_sizes_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","environ_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","fd_prestat_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","fd_prestat_dir_name",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","fd_fdstat_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","fd_fdstat_set_flags",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","fd_read",a:i32,b:i32,c:i32,d:i32);
    bind!("wasi_snapshot_preview1","fd_write",a:i32,b:i32,c:i32,d:i32);
    bind!("wasi_snapshot_preview1","fd_pread",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("wasi_snapshot_preview1","fd_pwrite",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("wasi_snapshot_preview1","path_open",a:i32,b:i32,c:i32,d:i32,e:i32,f:i64,g:i64,h:i32,i:i32);
    bind!("wasi_snapshot_preview1","path_create_directory",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","path_remove_directory",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","path_unlink_file",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","path_readlink",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32);
    bind!("wasi_snapshot_preview1","path_rename",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32);
    bind!("wasi_snapshot_preview1","path_symlink",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("wasi_snapshot_preview1","fd_readdir",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("wasi_snapshot_preview1","fd_close",a:i32);
    bind!("wasi_snapshot_preview1","fd_renumber",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","fd_sync",a:i32);
    bind!("wasi_snapshot_preview1","fd_datasync",a:i32);
    bind!("wasi_snapshot_preview1","fd_seek",a:i32,b:i64,c:i32,d:i32);
    bind!("wasi_snapshot_preview1","fd_tell",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","fd_filestat_set_size",a:i32,b:i64);
    bind!("wasi_snapshot_preview1","fd_allocate",a:i32,b:i64,c:i64);
    bind!("wasi_snapshot_preview1","poll_oneoff",a:i32,b:i32,c:i32,d:i32);
    bind!("wasi_snapshot_preview1","fd_filestat_set_times",a:i32,b:i64,c:i64,d:i32);
    bind!("wasi_snapshot_preview1","path_filestat_set_times",a:i32,b:i32,c:i32,d:i32,e:i64,f:i64,g:i32);
    bind!("wasi_snapshot_preview1","fd_filestat_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","path_filestat_get",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("wasi_snapshot_preview1","random_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1","clock_time_get",a:i32,b:i64,c:i32);
    bind!("wasi_snapshot_preview1","clock_res_get",a:i32,b:i32);
    bind!("wasi_snapshot_preview1", "sched_yield");
    bind!("host_process","proc_signal_mask_v2",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("host_process","fd_pipe",a:i32,b:i32);
    bind!("host_process","fd_dup",a:i32,b:i32);
    bind!("host_process","fd_dup2",a:i32,b:i32);
    bind!("host_process","fd_getfd",a:i32,b:i32);
    bind!("host_process","fd_setfd",a:i32,b:i32);
    bind!("host_user","isatty",a:i32,b:i32);
    macro_rules! bind_stat {
        ($name:literal,$result:ty,$failure:expr $(,$arg:ident:$type:ty)*) => {
            linker.func_wrap("host_fs",$name,|mut caller:Caller<'_,State>,$($arg:$type),*| -> Result<$result,Error> {
                match dispatch(&mut caller,$name,&[$($arg as u64),*]) {
                    Ok(value) => Ok(value as $result),
                    Err(Failure::Errno(_)) => Ok($failure),
                    Err(Failure::Suspend) => Err(Error::new("Cirro host request")),
                    Err(Failure::Budget) => Err(Error::new("WASI host request budget exceeded")),
                }
            }).map_err(|error|error.to_string())?;
        }
    }
    bind_stat!("fd_mode",i32,0,a:i32);
    bind_stat!("path_mode",i32,0,a:i32,b:i32,c:i32,d:i32);
    bind_stat!("fd_size",i64,-1,a:i32);
    bind_stat!("fd_blocks",i64,-1,a:i32);
    bind_stat!("path_size",i64,-1,a:i32,b:i32,c:i32,d:i32);
    bind_stat!("path_blocks",i64,-1,a:i32,b:i32,c:i32,d:i32);
    bind!("host_fs","fd_owner",a:i32,b:i32,c:i32);
    bind!("host_fs","path_owner",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32);
    bind!("host_fs","set_open_mode",a:i32);
    bind!("host_fs","set_open_direct",a:i32);
    bind!("host_fs","open_tmpfile",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32);
    bind!("host_net","net_recv",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("host_net","net_send",a:i32,b:i32,c:i32,d:i32,e:i32);
    linker
        .func_wrap(
            "wasi_snapshot_preview1",
            "proc_exit",
            |code: i32| -> Result<(), Error> { Err(Error::i32_exit(code)) },
        )
        .map_err(|error| error.to_string())?;
    Ok(linker)
}

#[wasm_bindgen]
pub struct WasmGuest {
    store: Store<State>,
    function: Func,
    memory: Option<Memory>,
    invocation: Option<ResumableCallHostTrap>,
    response: Option<Val>,
    outputs: Vec<Val>,
    done: Option<i32>,
}

impl WasmGuest {
    fn create(
        bytes: &[u8],
        configuration: &str,
        stdin: &[u8],
        memory: usize,
        fuel: u64,
        max_output: usize,
    ) -> Result<Self, String> {
        if bytes.len() > MAX_MODULE_BYTES
            || !(4_194_304..=33_554_432).contains(&memory)
            || fuel == 0
            || fuel > 100_000_000
            || !(1024..=1_048_576).contains(&max_output)
        {
            return Err("Invalid Wasm execution limits".into());
        }
        if configuration.len() > 65_536 || stdin.len() > 1_048_576 {
            return Err("WASI input budget exceeded".into());
        }
        let configuration: Configuration =
            serde_json::from_str(configuration).map_err(|error| error.to_string())?;
        if configuration.argv.len() > 129
            || configuration.env.len() > 128
            || configuration
                .argv
                .iter()
                .any(|value| value.len() > 4096 || value.contains('\0'))
            || configuration.env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.chars().count() > 128
                    || key.contains('=')
                    || key.contains('\0')
                    || value.len() > 4096
                    || value.contains('\0')
            })
        {
            return Err("Invalid WASI argument or environment".into());
        }
        let argv = configuration
            .argv
            .into_iter()
            .map(|value| {
                let mut bytes = value.into_bytes();
                bytes.push(0);
                bytes
            })
            .collect();
        let environment = configuration
            .env
            .into_iter()
            .map(|(key, value)| {
                let mut bytes = format!("{key}={value}").into_bytes();
                bytes.push(0);
                bytes
            })
            .collect();
        let mut config = Config::default();
        config.consume_fuel(true);
        config.wasm_tail_call(false);
        let engine = Engine::new(&config);
        let module = Module::new(&engine, bytes).map_err(|error| error.to_string())?;
        let limits = StoreLimitsBuilder::new()
            .memory_size(memory)
            .table_elements(4096)
            .instances(1)
            .tables(1)
            .memories(1)
            .trap_on_grow_failure(true)
            .build();
        let root = Descriptor {
            path: "/".into(),
            directory: true,
            read: true,
            write: true,
            flags: Rc::new(Cell::new(0)),
            offset: Rc::new(Cell::new(0)),
            stdio: None,
            pipe: None,
            rights: (1 << 30) - 1,
            inheriting: (1 << 30) - 1,
            cache: None,
            linked: true,
            metadata: [0; 76],
        };
        let mut store = Store::new(
            &engine,
            State {
                limits,
                descriptors: BTreeMap::from([(3, root.clone()), (HIDDEN_PREOPEN, root)]),
                files: BTreeMap::new(),
                stdout: Vec::new(),
                stderr: Vec::new(),
                max_output,
                pending: None,
                requests: 0,
                closed: BTreeSet::new(),
                cloexec: BTreeSet::new(),
                signal_mask: 0,
                stdio_flags: std::array::from_fn(|_| Rc::new(Cell::new(0))),
                argv,
                environment,
                stdin: stdin.to_vec(),
                stdin_offset: 0,
                directories: BTreeMap::new(),
                open_mode: None,
                open_direct: false,
            },
        );
        store.limiter(|state| &mut state.limits);
        store.set_fuel(fuel).map_err(|error| error.to_string())?;
        let instance = linker(&engine)?
            .instantiate_and_start(&mut store, &module)
            .map_err(|error| error.to_string())?;
        let start = instance.get_func(&store, "_start");
        let is_start = start.is_some();
        let function = start
            .or_else(|| instance.get_func(&store, "run"))
            .ok_or("Wasm must export _start() or run() -> i32")?;
        let ty = function.ty(&store);
        if !ty.params().is_empty()
            || (is_start && !ty.results().is_empty())
            || (!is_start && ty.results() != [wasmi::ValType::I32])
        {
            return Err("Invalid Wasm entry signature".into());
        }
        let outputs = ty
            .results()
            .iter()
            .map(|ty| Val::default_for_ty(*ty))
            .collect();
        let memory = instance.get_memory(&store, "memory");
        Ok(Self {
            store,
            function,
            memory,
            invocation: None,
            response: None,
            outputs,
            done: None,
        })
    }

    fn advance(&mut self) -> Result<(), String> {
        let call = match self.invocation.take() {
            Some(invocation) => {
                let response = self
                    .response
                    .take()
                    .ok_or("Wasm host response is required")?;
                invocation.resume(&mut self.store, &[response], &mut self.outputs)
            }
            None => self
                .function
                .call_resumable(&mut self.store, &[], &mut self.outputs),
        };
        match call {
            Ok(ResumableCall::Finished) => self.done = Some(0),
            Ok(ResumableCall::HostTrap(invocation)) => {
                if let Some(code) = invocation.host_error().i32_exit_status() {
                    self.done = Some(code);
                    self.outputs.clear();
                } else if self.store.data().pending.is_some() {
                    self.invocation = Some(invocation);
                } else {
                    return Err(invocation.host_error().to_string());
                }
            }
            Ok(ResumableCall::OutOfFuel(_)) => return Err("Wasm fuel exhausted".into()),
            Err(error) => {
                if let Some(code) = error.i32_exit_status() {
                    self.done = Some(code);
                    self.outputs.clear();
                } else {
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }
}

#[wasm_bindgen]
impl WasmGuest {
    #[wasm_bindgen(constructor)]
    pub fn new(
        bytes: &[u8],
        configuration: &str,
        stdin: &[u8],
        memory: usize,
        fuel: u64,
        max_output: usize,
    ) -> Result<WasmGuest, JsValue> {
        Self::create(bytes, configuration, stdin, memory, fuel, max_output)
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn step(&mut self) -> Result<String, JsValue> {
        if self.store.data().pending.is_none() && self.done.is_none() {
            self.advance().map_err(|error| JsValue::from_str(&error))?;
        }
        if let Some(pending) = &self.store.data().pending {
            return serde_json::to_string(&pending.request)
                .map_err(|error| JsValue::from_str(&error.to_string()));
        }
        let state = self.store.data();
        let result = self.outputs.first().and_then(Val::i32);
        let output = serde_json::json!({"stdout":String::from_utf8_lossy(&state.stdout),"stderr":String::from_utf8_lossy(&state.stderr),"exitCode":self.done,"result":result});
        let encoded = serde_json::to_string(&output)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        if encoded.len() > state.max_output {
            return Err(JsValue::from_str("Wasm serialized output budget exceeded"));
        }
        serde_json::to_string(&serde_json::json!({"kind":"done","output":output}))
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn stdio(&self) -> Result<String, JsValue> {
        let state = self.store.data();
        serde_json::to_string(&serde_json::json!({"stdout":String::from_utf8_lossy(&state.stdout),"stderr":String::from_utf8_lossy(&state.stderr)})).map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn has_file(&self, path: &str) -> bool {
        self.store
            .data()
            .files
            .values()
            .any(|file| file.path.as_deref() == Some(path))
    }
    pub fn buffered_bytes(&self) -> usize {
        self.store
            .data()
            .files
            .values()
            .map(|file| file.bytes.len())
            .sum()
    }

    pub fn file_metadata(&self, fd: u32) -> Result<Vec<u8>, JsValue> {
        let state = self.store.data();
        let descriptor = state
            .descriptors
            .get(&fd)
            .ok_or_else(|| JsValue::from_str("Missing descriptor"))?;
        if let Some(cache) = descriptor.cache {
            return state
                .files
                .get(&cache)
                .map(|file| file.metadata.to_vec())
                .ok_or_else(|| JsValue::from_str("Missing file cache"));
        }
        Ok(descriptor.metadata.to_vec())
    }

    pub fn file_data(&self, fd: u32) -> Result<Vec<u8>, JsValue> {
        let state = self.store.data();
        let descriptor = state
            .descriptors
            .get(&fd)
            .ok_or_else(|| JsValue::from_str("Missing file descriptor"))?;
        let cache = descriptor
            .cache
            .ok_or_else(|| JsValue::from_str("Descriptor is not a file"))?;
        state
            .files
            .get(&cache)
            .map(|file| file.bytes.clone())
            .ok_or_else(|| JsValue::from_str("Missing file buffer"))
    }

    pub fn respond(
        &mut self,
        errno: i32,
        data: &[u8],
        path: &str,
        directory: bool,
        value: u64,
        metadata: &[u8],
    ) -> Result<(), JsValue> {
        let pending = self
            .store
            .data_mut()
            .pending
            .take()
            .ok_or_else(|| JsValue::from_str("No pending Wasm request"))?;
        let mut result = errno;
        let mut scalar = match &pending.completion {
            Completion::HostStat { projection, .. } if errno != 0 => Some(match projection {
                StatProjection::Mode => Val::I32(0),
                StatProjection::Size | StatProjection::Blocks => Val::I64(-1),
                StatProjection::Owner => Val::I32(errno),
            }),
            _ => None,
        };
        if errno != 0
            && let Completion::Flush {
                fd,
                previous,
                previous_offset,
                previous_length,
                start,
                ..
            } = &pending.completion
        {
            let state = self.store.data_mut();
            let descriptor = state
                .descriptors
                .get_mut(fd)
                .ok_or_else(|| JsValue::from_str("Missing descriptor"))?;
            descriptor.offset.set(*previous_offset);
            let file = state
                .files
                .get_mut(
                    &descriptor
                        .cache
                        .ok_or_else(|| JsValue::from_str("Missing cache reference"))?,
                )
                .ok_or_else(|| JsValue::from_str("Missing file buffer"))?;
            let file = &mut file.bytes;
            file.resize(*previous_length, 0);
            if !previous.is_empty() {
                let end = start
                    .checked_add(previous.len())
                    .ok_or_else(|| JsValue::from_str("Invalid rollback range"))?;
                file.get_mut(*start..end)
                    .ok_or_else(|| JsValue::from_str("Invalid rollback range"))?
                    .copy_from_slice(previous);
            }
        }
        if errno == 0 {
            match pending.completion {
                Completion::Tmpfile {
                    mut descriptor,
                    pointer,
                } => {
                    let state = self.store.data_mut();
                    let cache = (0..MAX_FILES as u32)
                        .find(|cache| !state.files.contains_key(cache))
                        .ok_or_else(|| JsValue::from_str("File cache quota exceeded"))?;
                    let fd = (4..MAX_FILES as u32 + 4)
                        .find(|fd| !state.descriptors.contains_key(fd))
                        .ok_or_else(|| JsValue::from_str("Descriptor quota exceeded"))?;
                    descriptor.metadata = metadata
                        .try_into()
                        .map_err(|_| JsValue::from_str("Invalid inode metadata"))?;
                    descriptor.cache = Some(cache);
                    state.files.insert(
                        cache,
                        FileBuffer {
                            path: None,
                            bytes: Vec::new(),
                            metadata: descriptor.metadata,
                        },
                    );
                    state.descriptors.insert(fd, descriptor);
                    self.memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                        .write(&mut self.store, pointer, &fd.to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::Open {
                    mut descriptor,
                    pointer,
                    truncate,
                } => {
                    let state = self.store.data_mut();
                    let total: usize = state
                        .files
                        .iter()
                        .filter(|(_, file)| file.path.as_deref() != Some(path))
                        .map(|(_, file)| file.bytes.len())
                        .sum();
                    if state.descriptors.len() >= MAX_FILES
                        || total.saturating_add(data.len()) > MAX_BYTES
                    {
                        result = 48;
                    } else {
                        descriptor.path = path.into();
                        descriptor.directory = directory;
                        descriptor.metadata = metadata
                            .try_into()
                            .map_err(|_| JsValue::from_str("Invalid inode metadata"))?;
                        if !directory {
                            let cache = state
                                .files
                                .iter()
                                .find(|(_, file)| file.path.as_deref() == Some(path))
                                .map(|(cache, _)| *cache)
                                .or_else(|| {
                                    (0..MAX_FILES as u32)
                                        .find(|cache| !state.files.contains_key(cache))
                                })
                                .ok_or_else(|| JsValue::from_str("File cache quota exceeded"))?;
                            if truncate || !state.files.contains_key(&cache) {
                                state.files.insert(
                                    cache,
                                    FileBuffer {
                                        path: Some(path.into()),
                                        bytes: data.to_vec(),
                                        metadata: descriptor.metadata,
                                    },
                                );
                            }
                            descriptor.cache = Some(cache);
                        }
                        let fd = (4..MAX_FILES as u32 + 4)
                            .find(|fd| !state.descriptors.contains_key(fd))
                            .ok_or_else(|| JsValue::from_str("Descriptor quota exceeded"))?;
                        state.descriptors.insert(fd, descriptor);
                        self.memory
                            .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                            .write(&mut self.store, pointer, &fd.to_le_bytes())
                            .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    }
                }
                Completion::Flush {
                    fd,
                    pointer,
                    length,
                    offset,
                    positioned,
                    ..
                } => {
                    let state = self.store.data_mut();
                    let cache = state
                        .descriptors
                        .get(&fd)
                        .and_then(|descriptor| descriptor.cache)
                        .ok_or_else(|| JsValue::from_str("Missing cache reference"))?;
                    state
                        .files
                        .get_mut(&cache)
                        .ok_or_else(|| JsValue::from_str("Missing file cache"))?
                        .metadata = metadata
                        .try_into()
                        .map_err(|_| JsValue::from_str("Invalid inode metadata"))?;
                    if !positioned {
                        self.store
                            .data_mut()
                            .descriptors
                            .get_mut(&fd)
                            .ok_or_else(|| JsValue::from_str("Missing descriptor"))?
                            .offset
                            .set(offset);
                    }
                    if let Some(pointer) = pointer {
                        self.memory
                            .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                            .write(&mut self.store, pointer, &(length as u32).to_le_bytes())
                            .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    }
                }
                Completion::HostStat {
                    fd,
                    projection,
                    pointers,
                } => {
                    let bytes: [u8; 76] = data
                        .try_into()
                        .map_err(|_| JsValue::from_str("Invalid host stat response"))?;
                    if let Some(fd) = fd {
                        let state = self.store.data_mut();
                        let descriptor = state
                            .descriptors
                            .get_mut(&fd)
                            .ok_or_else(|| JsValue::from_str("Missing descriptor"))?;
                        descriptor.metadata = bytes;
                        if let Some(cache) = descriptor.cache {
                            state
                                .files
                                .get_mut(&cache)
                                .ok_or_else(|| JsValue::from_str("Missing cache reference"))?
                                .metadata = bytes;
                        }
                    }
                    let size = u64::from_le_bytes(
                        bytes[32..40]
                            .try_into()
                            .map_err(|_| JsValue::from_str("Invalid size"))?,
                    );
                    scalar = Some(match projection {
                        StatProjection::Mode => Val::I32(i32::from_le_bytes(
                            bytes[64..68]
                                .try_into()
                                .map_err(|_| JsValue::from_str("Invalid mode"))?,
                        )),
                        StatProjection::Size => Val::I64(size as i64),
                        StatProjection::Blocks => Val::I64(size.div_ceil(512) as i64),
                        StatProjection::Owner => {
                            let (uid, gid) = pointers
                                .ok_or_else(|| JsValue::from_str("Missing ownership pointers"))?;
                            let memory = self
                                .memory
                                .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?;
                            memory
                                .write(&mut self.store, uid, &bytes[68..72])
                                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                            memory
                                .write(&mut self.store, gid, &bytes[72..76])
                                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                            Val::I32(0)
                        }
                    });
                }
                Completion::Stat { fd, pointer } => {
                    let bytes: [u8; 76] = data
                        .try_into()
                        .map_err(|_| JsValue::from_str("Invalid stat response"))?;
                    if let Some(fd) = fd {
                        let state = self.store.data_mut();
                        let descriptor = state
                            .descriptors
                            .get_mut(&fd)
                            .ok_or_else(|| JsValue::from_str("Missing descriptor"))?;
                        descriptor.metadata = bytes;
                        if let Some(cache) = descriptor.cache {
                            state
                                .files
                                .get_mut(&cache)
                                .ok_or_else(|| JsValue::from_str("Missing cache reference"))?
                                .metadata = bytes;
                        }
                    }
                    self.memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                        .write(&mut self.store, pointer, &bytes[..64])
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::Metadata { fd } => {
                    let metadata: [u8; 76] = data
                        .try_into()
                        .map_err(|_| JsValue::from_str("Invalid inode metadata"))?;
                    let state = self.store.data_mut();
                    for (number, descriptor) in state.descriptors.iter_mut() {
                        if fd == Some(*number) || descriptor.metadata[8..16] == metadata[8..16] {
                            descriptor.metadata = metadata;
                            if let Some(cache) = descriptor.cache {
                                state
                                    .files
                                    .get_mut(&cache)
                                    .ok_or_else(|| JsValue::from_str("Missing file cache"))?
                                    .metadata = metadata;
                            }
                        }
                    }
                }
                Completion::Poll {
                    events,
                    clocks,
                    blocked,
                    pointer,
                    output,
                } => {
                    let ready: Vec<usize> = serde_json::from_slice(data)
                        .map_err(|_| JsValue::from_str("Invalid poll response"))?;
                    if ready.iter().any(|index| !clocks.contains(index)) {
                        return Err(JsValue::from_str(
                            "Unknown clock subscription in poll response",
                        ));
                    }
                    let ready: BTreeSet<_> = ready.into_iter().collect();
                    let bytes: Vec<u8> = events
                        .into_iter()
                        .enumerate()
                        .filter(|(index, _)| {
                            !blocked.contains(index)
                                && (!clocks.contains(index) || ready.contains(index))
                        })
                        .flat_map(|(_, event)| event)
                        .collect();
                    let count = (bytes.len() / 32) as u32;
                    if count == 0 {
                        return Err(JsValue::from_str("Poll completed without a ready event"));
                    }
                    let memory = self
                        .memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?;
                    memory
                        .write(&mut self.store, pointer, &bytes)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    memory
                        .write(&mut self.store, output, &count.to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::Unit => {}
                Completion::Remove => detach(self.store.data_mut(), path),
                Completion::Rename => {
                    let to = std::str::from_utf8(data)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    if path != to {
                        let state = self.store.data_mut();
                        detach(state, to);
                        for file in state.files.values_mut() {
                            if let Some(current) = &file.path
                                && (current == path || current.starts_with(&format!("{path}/")))
                            {
                                file.path = Some(format!("{to}{}", &current[path.len()..]));
                            }
                        }
                        for descriptor in state.descriptors.values_mut() {
                            if descriptor.linked
                                && (descriptor.path == path
                                    || descriptor.path.starts_with(&format!("{path}/")))
                            {
                                descriptor.path = format!("{to}{}", &descriptor.path[path.len()..]);
                            }
                        }
                    }
                }
                Completion::Readlink {
                    pointer,
                    length,
                    output,
                } => {
                    let count = length.min(data.len());
                    let memory = self
                        .memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?;
                    memory
                        .write(&mut self.store, pointer, &data[..count])
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    memory
                        .write(&mut self.store, output, &(count as u32).to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::Directory {
                    fd,
                    pointer,
                    length,
                    cookie,
                    output,
                } => {
                    let entries: Vec<DirectoryEntry> = serde_json::from_slice(data)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    let data = directory_bytes(&entries, cookie, length);
                    self.store.data_mut().directories.insert(fd, entries);
                    match data {
                        Ok(data) => {
                            let memory = self
                                .memory
                                .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?;
                            memory
                                .write(&mut self.store, pointer, &data)
                                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                            memory
                                .write(&mut self.store, output, &(data.len() as u32).to_le_bytes())
                                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                        }
                        Err(errno) => result = errno,
                    }
                }
                Completion::Sync => {}
                Completion::Bytes { pointer, length } => {
                    if data.len() != length {
                        return Err(JsValue::from_str("Invalid entropy response length"));
                    }
                    self.memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                        .write(&mut self.store, pointer, data)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::Clock { pointer } => {
                    self.memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                        .write(&mut self.store, pointer, &value.to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
            }
        }
        self.response = Some(scalar.unwrap_or(Val::I32(result)));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_binary_and_limits_are_rejected() {
        assert!(
            WasmGuest::create(
                b"invalid",
                r#"{"argv":[],"env":{}}"#,
                &[],
                8_388_608,
                1000,
                1024
            )
            .is_err()
        );
    }
    #[test]
    fn inherited_pipe_endpoints_survive_other_stores_and_release_on_guest_drop() {
        let module = include_bytes!("../../../dist/wasi-pipe-blocked.wasm");
        let configuration = r#"{"argv":[],"env":{}}"#;
        let mut parent =
            WasmGuest::create(module, configuration, &[], 8_388_608, 100_000, 1024).unwrap();
        let mut child =
            WasmGuest::create(module, configuration, &[], 8_388_608, 100_000, 1024).unwrap();
        parent.advance().unwrap();
        child.advance().unwrap();
        assert!(matches!(
            parent.store.data().pending.as_ref().unwrap().request,
            Request::Poll {
                immediate: false,
                ..
            }
        ));
        let reader = parent
            .store
            .data()
            .descriptors
            .iter()
            .find(|(_, descriptor)| descriptor.pipe.is_some() && descriptor.read)
            .map(|(fd, _)| *fd)
            .unwrap();
        let writer = parent
            .store
            .data()
            .descriptors
            .iter()
            .find(|(_, descriptor)| descriptor.pipe.is_some() && descriptor.write)
            .map(|(fd, _)| *fd)
            .unwrap();
        close(child.store.data_mut(), reader);
        close(child.store.data_mut(), writer);
        child.store.data_mut().descriptors.insert(
            writer,
            duplicate_source(parent.store.data(), writer).unwrap(),
        );
        close(parent.store.data_mut(), writer);
        assert!(
            parent.store.data().descriptors[&reader]
                .pipe
                .as_ref()
                .unwrap()
                .has_peer()
        );
        assert!(
            child.store.data().descriptors[&writer]
                .pipe
                .as_ref()
                .unwrap()
                .has_peer()
        );
        let alias = duplicate_source(child.store.data(), writer).unwrap();
        child.store.data_mut().descriptors.insert(100, alias);
        close(child.store.data_mut(), writer);
        assert!(
            parent.store.data().descriptors[&reader]
                .pipe
                .as_ref()
                .unwrap()
                .has_peer()
        );
        drop(child);
        assert!(
            !parent.store.data().descriptors[&reader]
                .pipe
                .as_ref()
                .unwrap()
                .has_peer()
        );
        let mut receiver =
            WasmGuest::create(module, configuration, &[], 8_388_608, 100_000, 1024).unwrap();
        receiver.advance().unwrap();
        close(parent.store.data_mut(), reader);
        parent.store.data_mut().descriptors.insert(
            reader,
            duplicate_source(receiver.store.data(), reader).unwrap(),
        );
        close(receiver.store.data_mut(), reader);
        assert!(
            receiver.store.data().descriptors[&writer]
                .pipe
                .as_ref()
                .unwrap()
                .has_peer()
        );
        drop(parent);
        assert!(
            !receiver.store.data().descriptors[&writer]
                .pipe
                .as_ref()
                .unwrap()
                .has_peer()
        );
    }

    #[test]
    fn paths_cannot_escape_the_directory_descriptor() {
        assert!(confined("/tmp", "../escape").is_err());
        assert!(confined("/", "../../escape").is_err());
        assert!(matches!(confined("/tmp","a/../b"),Ok(path) if path == "/tmp/b"));
    }
}
