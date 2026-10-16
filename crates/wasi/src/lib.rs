use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::rc::{Rc, Weak};
use wasm_bindgen::prelude::*;
use wasmi::{
    Caller, CompilationMode, Config, CustomFuelCosts, Engine, Error, Func, Linker, Memory, Module,
    ResumableCall, ResumableCallHostTrap, ResumableCallOutOfFuel, Store, StoreLimits,
    StoreLimitsBuilder, TrapCode, Val,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
}

include!(concat!(env!("OUT_DIR"), "/module_limit.rs"));

const FUEL_SLICE: u64 = 1_000_000;
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
    Exec {
        path: Option<String>,
        fd: Option<u32>,
        cwd: String,
        argv: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Spawn {
        path: String,
        argv: Vec<String>,
        env: BTreeMap<String, String>,
        cwd_steps: Vec<String>,
        search_path: Option<String>,
        actions: Vec<SpawnAction>,
    },
    Handler,
    Stopped,
    Wait {
        pids: Vec<u32>,
    },
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
        mode: u32,
    },
    Remove {
        path: String,
        base: String,
        directory: bool,
    },
    Link {
        from: String,
        from_base: String,
        to: String,
        to_base: String,
        follow: bool,
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
    Exec {
        closed: BTreeSet<u32>,
    },
    PipeRead {
        fd: u32,
        vectors: Vec<(usize, usize)>,
        output: usize,
    },
    PipeWrite {
        fd: u32,
        data: Vec<u8>,
        output: usize,
    },
    Spawn {
        pointer: usize,
        resources: SpawnResources,
        actions: Vec<SpawnAction>,
        mask: u64,
        group: Option<u32>,
        new_session: bool,
        signal_defaults: u64,
    },
    Wait {
        pids: Vec<u32>,
        pointers: [usize; 4],
    },
    WaitRaw {
        pids: Vec<u32>,
        options: u32,
        status: usize,
        pid: usize,
    },
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
        pipe_fds: BTreeMap<usize, u32>,
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

#[derive(Clone, Deserialize)]
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

#[derive(Clone)]
struct SignalDisposition {
    action: u32,
    mask: u64,
    flags: u32,
}
struct HandlerFrame {
    function: Func,
    parameters: Vec<Val>,
    outputs: Vec<Val>,
    invocation: Option<ResumableCallHostTrap>,
    exhaustion: Option<ResumableCallOutOfFuel>,
    response: Option<Val>,
    pending: Option<Pending>,
    mask: u64,
    restart: bool,
}

struct ChildStatus {
    parent: u32,
    group: u32,
    session: u32,
    pending_signals: Rc<Cell<u64>>,
    dispositions: Rc<RefCell<BTreeMap<u32, SignalDisposition>>>,
    stopped: Rc<Cell<bool>>,
    transitions: Rc<RefCell<VecDeque<u32>>>,
    signal: u32,
    code: Option<i32>,
    failed: bool,
}
struct ProcessTable {
    next_pid: u32,
    root_group: u32,
    root_session: u32,
    root_pending_signals: Rc<Cell<u64>>,
    root_dispositions: Rc<RefCell<BTreeMap<u32, SignalDisposition>>>,
    root_stopped: Rc<Cell<bool>>,
    root_transitions: Rc<RefCell<VecDeque<u32>>>,
    memory_bytes: usize,
    children: BTreeMap<u32, ChildStatus>,
    buffers: Vec<Weak<RefCell<FileBuffer>>>,
    pipes: Vec<Weak<Pipe>>,
}
#[derive(Clone, Serialize)]
struct SpawnAction {
    command: u32,
    fd: u32,
    source: u32,
    flags: u32,
    mode: u32,
    path: String,
}
#[derive(Clone)]
struct SpawnResources {
    descriptors: BTreeMap<u32, Descriptor>,
    files: BTreeMap<u32, Rc<RefCell<FileBuffer>>>,
    closed: BTreeSet<u32>,
    cloexec: BTreeSet<u32>,
}
impl SpawnResources {
    fn close(&mut self, fd: u32) {
        self.cloexec.remove(&fd);
        if fd < 3 {
            self.closed.insert(fd);
        }
        if let Some(descriptor) = self.descriptors.remove(&fd)
            && let Some(cache) = descriptor.cache
            && !self
                .descriptors
                .values()
                .any(|other| other.cache == Some(cache))
        {
            self.files.remove(&cache);
        }
    }
}

struct State {
    limits: StoreLimits,
    descriptors: BTreeMap<u32, Descriptor>,
    files: BTreeMap<u32, Rc<RefCell<FileBuffer>>>,
    stdout: Rc<RefCell<Vec<u8>>>,
    stderr: Rc<RefCell<Vec<u8>>>,
    max_output: usize,
    pending: Option<Pending>,
    requests: Rc<Cell<usize>>,
    pid: u32,
    parent_pid: u32,
    cwd: String,
    processes: Rc<RefCell<ProcessTable>>,
    closed: BTreeSet<u32>,
    cloexec: BTreeSet<u32>,
    signal_mask: u64,
    pending_signals: Rc<Cell<u64>>,
    delivered_signal: u32,
    dispositions: Rc<RefCell<BTreeMap<u32, SignalDisposition>>>,
    caught_signal: Option<u32>,
    stopped: Rc<Cell<bool>>,
    transitions: Rc<RefCell<VecDeque<u32>>>,
    readiness_notification: bool,
    stdio_flags: [Rc<Cell<u16>>; 3],
    argv: Vec<Vec<u8>>,
    environment: Vec<Vec<u8>>,
    stdin_pipe: Option<Rc<Pipe>>,
    stdin_writer: Rc<RefCell<Option<Rc<PipeEndpoint>>>>,
    stdin: Rc<Vec<u8>>,
    stdin_offset: Rc<Cell<usize>>,
    directories: BTreeMap<u32, Vec<DirectoryEntry>>,
    umask: u32,
    open_mode: Option<u32>,
    open_direct: bool,
}

#[derive(Debug)]
enum Failure {
    Errno(i32),
    Suspend,
    Budget,
    Signal(u32),
}

fn notify_signal_parent(table: &ProcessTable, pid: u32, transition: bool) -> bool {
    let Some(child) = table.children.get(&pid) else {
        return false;
    };
    let target = if child.parent == 1 {
        Some((
            table.root_pending_signals.clone(),
            table.root_dispositions.clone(),
        ))
    } else {
        table
            .children
            .get(&child.parent)
            .map(|parent| (parent.pending_signals.clone(), parent.dispositions.clone()))
    };
    if let Some((pending, dispositions)) = target {
        let disposition = dispositions.borrow().get(&17).cloned();
        let caught = disposition.as_ref().is_some_and(|disposition| {
            disposition.action == 2 && (!transition || disposition.flags & 1 == 0)
        });
        if caught {
            pending.set(pending.get() | (1 << 16));
        }
        return !transition
            && disposition
                .as_ref()
                .is_some_and(|disposition| disposition.action == 1 || disposition.flags & 2 != 0);
    }
    false
}

fn deliver_signal(state: &mut State) -> Option<u32> {
    let mut available = state.pending_signals.get() & !state.signal_mask;
    if state.stopped.get() {
        available &= 1 << 8;
    }
    if available == 0 {
        return None;
    }
    let signal = if available & (1 << 8) != 0 {
        9
    } else if available & (1 << 18) != 0 {
        19
    } else {
        available.trailing_zeros() + 1
    };
    let disposition = state.dispositions.borrow().get(&signal).cloned();
    if disposition
        .as_ref()
        .is_some_and(|disposition| disposition.action == 1)
        || (disposition
            .as_ref()
            .is_none_or(|disposition| disposition.action == 0)
            && matches!(signal, 17 | 23 | 28))
    {
        state
            .pending_signals
            .set(state.pending_signals.get() & !(1u64 << (signal - 1)));
        return deliver_signal(state);
    }
    if disposition
        .as_ref()
        .is_some_and(|disposition| disposition.action == 2)
    {
        state
            .pending_signals
            .set(state.pending_signals.get() & !(1u64 << (signal - 1)));
        state.caught_signal = Some(signal);
        return Some(signal);
    }
    if matches!(signal, 19..=22) {
        state
            .pending_signals
            .set(state.pending_signals.get() & !(1u64 << (signal - 1)));
        if !state.stopped.replace(true) {
            state
                .transitions
                .borrow_mut()
                .push_back((signal << 8) | 0x7f);
            notify_signal_parent(&state.processes.borrow(), state.pid, true);
        }
        state.readiness_notification = true;
    } else {
        state.pending_signals.set(0);
        state.delivered_signal = signal;
        state.stopped.set(false);
    }
    Some(signal)
}

fn take_wait_status(
    table: &mut ProcessTable,
    pids: &[u32],
    options: u32,
) -> Option<(u32, u32, bool)> {
    for pid in pids {
        let Some(child) = table.children.get(pid) else {
            continue;
        };
        let selected = child.transitions.borrow().iter().position(|status| {
            (*status == 0xffff && options & 8 != 0) || (*status & 0xff == 0x7f && options & 2 != 0)
        });
        if let Some(index) = selected {
            let status = child.transitions.borrow_mut().remove(index)?;
            return Some((*pid, status, false));
        }
        if child.code.is_some() || child.failed {
            let child = table.children.remove(pid)?;
            let status = if child.signal != 0 {
                child.signal
            } else {
                (child.code.unwrap_or(0) as u32 & 0xff) << 8
            };
            return Some((*pid, status, child.failed));
        }
    }
    None
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
    state.requests.set(state.requests.get() + 1);
    if state.requests.get() > 256 {
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

fn pipe_event(state: &State, fd: u32, event: &mut [u8; 32]) -> bool {
    let Some(pipe) = state
        .descriptors
        .get(&fd)
        .and_then(|descriptor| descriptor.pipe.as_ref())
    else {
        event[8..10].copy_from_slice(&8u16.to_le_bytes());
        return true;
    };
    let writing = event[10] == 2;
    let length = pipe.pipe.bytes.borrow().len();
    let available = if writing { PIPE_BYTES - length } else { length };
    event[8..10].fill(0);
    event[24..26].fill(0);
    event[16..24].copy_from_slice(&(available as u64).to_le_bytes());
    if !pipe.has_peer() {
        if writing {
            event[8..10].copy_from_slice(&64u16.to_le_bytes());
        } else {
            event[24..26].copy_from_slice(&1u16.to_le_bytes());
        }
        return true;
    }
    available > 0
}

fn buffered_bytes(state: &State) -> usize {
    state
        .processes
        .borrow()
        .buffers
        .iter()
        .filter_map(Weak::upgrade)
        .map(|file| file.borrow().bytes.len())
        .sum()
}

fn descriptor_alias(path: &str) -> Result<Option<u32>, Failure> {
    let Some(number) = path.strip_prefix("/dev/fd/") else {
        return Ok(None);
    };
    let fd = number.parse::<u32>().map_err(|_| Failure::Errno(44))?;
    if fd.to_string() != number {
        return Err(Failure::Errno(44));
    }
    Ok(Some(fd))
}

fn descriptor_path(state: &State, descriptor: &Descriptor) -> Result<Option<String>, Failure> {
    if let Some(cache) = descriptor.cache {
        return Ok(state
            .files
            .get(&cache)
            .ok_or(Failure::Errno(8))?
            .borrow()
            .path
            .clone());
    }
    Ok(descriptor.linked.then(|| descriptor.path.clone()))
}

fn detach(state: &mut State, path: &str) {
    for file in state
        .processes
        .borrow()
        .buffers
        .iter()
        .filter_map(Weak::upgrade)
    {
        let mut file = file.borrow_mut();
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
    if state
        .descriptors
        .get(&fd)
        .is_some_and(|descriptor| descriptor.pipe.is_some())
    {
        state.readiness_notification = true;
    }
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

fn descriptor_rights(state: &State, fd: u32) -> Result<(u64, u64), Failure> {
    if state.closed.contains(&fd) || fd == HIDDEN_PREOPEN {
        return Err(Failure::Errno(8));
    }
    if let Some(descriptor) = state.descriptors.get(&fd) {
        return Ok((descriptor.rights, descriptor.inheriting));
    }
    if let Some(index) = stream(state, fd) {
        return Ok(((if index == 0 { 2 } else { 64 }) | (1 << 27) | (1 << 3), 0));
    }
    Err(Failure::Errno(8))
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
            rights: descriptor_rights(state, fd)?.0,
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

fn spawn_strings(
    caller: &Caller<'_, State>,
    pointer: usize,
    length: usize,
) -> Result<Vec<String>, Failure> {
    if length > 65_536 {
        return Err(Failure::Errno(22));
    }
    let raw = bytes(caller, pointer, length)?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let text = std::str::from_utf8(&raw).map_err(|_| Failure::Errno(25))?;
    let text = text.strip_suffix('\0').unwrap_or(text);
    let entries: Vec<String> = text.split('\0').map(str::to_string).collect();
    if entries.iter().any(|value| value.len() > 4096) {
        return Err(Failure::Errno(22));
    }
    Ok(entries)
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
    let required = match name {
        "fd_read" | "fd_pread" => Some(2),
        "fd_write" | "fd_pwrite" => Some(64),
        "fd_fdstat_set_flags" => Some(1 << 3),
        _ => None,
    };
    if let Some(required) = required
        && descriptor_rights(caller.data(), a[0] as u32)?.0 & required == 0
    {
        return Err(Failure::Errno(76));
    }
    match name {
        "proc_getpid" | "proc_getppid" => {
            bytes(caller, a[0], 4)?;
            let pid = if name == "proc_getpid" {
                caller.data().pid
            } else {
                caller.data().parent_pid
            };
            put(caller, a[0], &pid.to_le_bytes())?;
        }
        "proc_sigaction" => {
            let signal = a[0] as u32;
            let action = a[1] as u32;
            if signal == 0 || signal > 64 || matches!(signal, 9 | 19) || action > 2 {
                return Err(Failure::Errno(28));
            }
            let flags = a[4] as u32;
            if flags & !0xd0000007 != 0 {
                return Err(Failure::Errno(58));
            }
            if action == 2 {
                let trampoline = caller
                    .get_export("__wasi_signal_trampoline")
                    .and_then(|export| export.into_func())
                    .ok_or(Failure::Errno(58))?;
                let signature = trampoline.ty(&*caller);
                if signature.params() != [wasmi::ValType::I32] || !signature.results().is_empty() {
                    return Err(Failure::Errno(28));
                }
            }
            let mask =
                (u64::from(a[2] as u32) | (u64::from(a[3] as u32) << 32)) & !((1 << 8) | (1 << 18));
            if action == 0 && flags == 0 {
                caller.data().dispositions.borrow_mut().remove(&signal);
            } else {
                caller.data().dispositions.borrow_mut().insert(
                    signal,
                    SignalDisposition {
                        action,
                        mask,
                        flags,
                    },
                );
            }
            if action == 1 || (action == 0 && matches!(signal, 17 | 23 | 28)) {
                caller
                    .data()
                    .pending_signals
                    .set(caller.data().pending_signals.get() & !(1u64 << (signal - 1)));
            }
        }
        "proc_kill" => {
            let pid = a[0] as u32 as i32;
            let signal = a[1] as u32;
            if signal > 64 {
                return Err(Failure::Errno(28));
            }
            let table = caller.data().processes.borrow();
            let targets = if pid <= 0 {
                let group = if pid < 0 {
                    pid.unsigned_abs()
                } else if caller.data().pid == 1 {
                    table.root_group
                } else {
                    table
                        .children
                        .get(&caller.data().pid)
                        .ok_or(Failure::Errno(71))?
                        .group
                };
                let mut targets: Vec<_> = table
                    .children
                    .values()
                    .filter(|child| child.group == group)
                    .map(|child| {
                        (
                            child.pending_signals.clone(),
                            child.stopped.clone(),
                            child.transitions.clone(),
                            child.dispositions.clone(),
                        )
                    })
                    .collect();
                if table.root_group == group {
                    targets.push((
                        table.root_pending_signals.clone(),
                        table.root_stopped.clone(),
                        table.root_transitions.clone(),
                        table.root_dispositions.clone(),
                    ));
                }
                targets
            } else if pid == 1 {
                vec![(
                    table.root_pending_signals.clone(),
                    table.root_stopped.clone(),
                    table.root_transitions.clone(),
                    table.root_dispositions.clone(),
                )]
            } else {
                let child = table
                    .children
                    .get(&(pid as u32))
                    .ok_or(Failure::Errno(71))?;
                vec![(
                    child.pending_signals.clone(),
                    child.stopped.clone(),
                    child.transitions.clone(),
                    child.dispositions.clone(),
                )]
            };
            drop(table);
            if targets.is_empty() {
                return Err(Failure::Errno(71));
            }
            if signal == 0 {
                return Ok(0);
            }
            let operations = caller.data().requests.get();
            if operations >= 256 {
                return Err(Failure::Budget);
            }
            caller.data().requests.set(operations + 1);
            for (pending, stopped, transitions, dispositions) in targets {
                let disposition = dispositions.borrow().get(&signal).cloned();
                let ignored = disposition
                    .as_ref()
                    .is_some_and(|disposition| disposition.action == 1)
                    || (disposition
                        .as_ref()
                        .is_none_or(|disposition| disposition.action == 0)
                        && matches!(signal, 17 | 23 | 28));
                if signal == 18 {
                    pending.set(pending.get() & !((1 << 18) | (1 << 19) | (1 << 20) | (1 << 21)));
                    if stopped.replace(false) {
                        transitions.borrow_mut().push_back(0xffff);
                        let table = caller.data().processes.borrow();
                        for (pid, child) in &table.children {
                            if Rc::ptr_eq(&child.transitions, &transitions) {
                                notify_signal_parent(&table, *pid, true);
                            }
                        }
                    }
                    if disposition
                        .as_ref()
                        .is_some_and(|disposition| disposition.action == 2)
                    {
                        pending.set(pending.get() | (1 << 17));
                    }
                } else if !ignored {
                    pending.set(pending.get() | (1u64 << (signal - 1)));
                }
            }
            caller.data_mut().readiness_notification = true;
            if let Some(signal) = deliver_signal(caller.data_mut()) {
                if caller.data().caught_signal.is_some() {
                    suspend(caller, Request::Handler, Completion::Sync)?;
                }
                if caller.data().stopped.get() {
                    suspend(caller, Request::Stopped, Completion::Sync)?;
                }
                return Err(Failure::Signal(signal));
            }
        }
        "proc_getpgid" => {
            bytes(caller, a[1], 4)?;
            let requested = a[0] as u32;
            let pid = if requested == 0 {
                caller.data().pid
            } else {
                requested
            };
            let table = caller.data().processes.borrow();
            let group = if pid == 1 {
                table.root_group
            } else {
                table.children.get(&pid).ok_or(Failure::Errno(71))?.group
            };
            drop(table);
            put(caller, a[1], &group.to_le_bytes())?;
        }
        "proc_setpgid" => {
            let requested = a[0] as u32;
            let requested_group = a[1] as u32;
            if requested > i32::MAX as u32 || requested_group > i32::MAX as u32 {
                return Err(Failure::Errno(28));
            }
            let pid = if requested == 0 {
                caller.data().pid
            } else {
                requested
            };
            let mut table = caller.data().processes.borrow_mut();
            if pid != 1 && !table.children.contains_key(&pid) {
                return Err(Failure::Errno(71));
            }
            let group = if requested_group == 0 {
                pid
            } else {
                requested_group
            };
            let session = if pid == 1 {
                table.root_session
            } else {
                table.children.get(&pid).ok_or(Failure::Errno(71))?.session
            };
            if group != pid
                && !((group == table.root_group && session == table.root_session)
                    || table.children.values().any(|child| {
                        child.group == group
                            && child.session == session
                            && child.code.is_none()
                            && !child.failed
                    }))
            {
                return Err(Failure::Errno(63));
            }
            if pid == 1 {
                table.root_group = group;
            } else {
                table
                    .children
                    .get_mut(&pid)
                    .ok_or(Failure::Errno(71))?
                    .group = group;
            }
        }
        "proc_exec" | "proc_fexec" => {
            let shift = usize::from(name == "proc_exec");
            let (path, fd) = if name == "proc_exec" {
                let raw = bytes(caller, a[0], a[1])?;
                if raw.is_empty() {
                    return Err(Failure::Errno(44));
                }
                if raw.len() > 4096 || raw.contains(&0) {
                    return Err(Failure::Errno(28));
                }
                (
                    Some(
                        std::str::from_utf8(&raw)
                            .map_err(|_| Failure::Errno(25))?
                            .into(),
                    ),
                    None,
                )
            } else {
                let fd = a[0] as u32;
                let descriptor = caller
                    .data()
                    .descriptors
                    .get(&fd)
                    .ok_or(Failure::Errno(8))?;
                if descriptor.directory || descriptor.cache.is_none() {
                    return Err(Failure::Errno(8));
                }
                let cache = descriptor.cache.ok_or(Failure::Errno(8))?;
                let file = caller
                    .data()
                    .files
                    .get(&cache)
                    .ok_or(Failure::Errno(8))?
                    .borrow();
                if u32::from_le_bytes(file.metadata[64..68].try_into().unwrap()) & 0o111 == 0 {
                    return Err(Failure::Errno(2));
                }
                (None, Some(fd))
            };
            let argv = spawn_strings(caller, a[1 + shift], a[2 + shift])?;
            let envp = spawn_strings(caller, a[3 + shift], a[4 + shift])?;
            if argv.len() > 129 || envp.len() > 128 {
                return Err(Failure::Errno(22));
            }
            let mut env = BTreeMap::new();
            for entry in envp {
                let (key, value) = entry.split_once('=').ok_or(Failure::Errno(28))?;
                if key.is_empty() || key.chars().count() > 128 {
                    return Err(Failure::Errno(28));
                }
                env.insert(key.to_string(), value.to_string());
            }
            if a[6 + shift] > MAX_FILES {
                return Err(Failure::Errno(28));
            }
            let list = bytes(caller, a[5 + shift], a[6 + shift] * 4)?;
            let closed: BTreeSet<u32> = list
                .as_chunks::<4>()
                .0
                .iter()
                .map(|part| u32::from_le_bytes(*part))
                .collect();
            if let Some(fd) = fd {
                let state = caller.data();
                let descriptor = state.descriptors.get(&fd).ok_or(Failure::Errno(8))?;
                let cache = descriptor.cache.ok_or(Failure::Errno(8))?;
                let file = state.files.get(&cache).ok_or(Failure::Errno(8))?.borrow();
                if file.bytes.starts_with(b"#!")
                    && (state.cloexec.contains(&fd) || closed.contains(&fd))
                {
                    return Err(Failure::Errno(44));
                }
            }
            suspend(
                caller,
                Request::Exec {
                    path,
                    fd,
                    cwd: caller.data().cwd.clone(),
                    argv,
                    env,
                },
                Completion::Exec { closed },
            )?;
        }
        "proc_spawn_v4" => {
            bytes(caller, a[20], 4)?;
            let flags = a[12] as u32;
            if flags & !255 != 0 {
                return Err(Failure::Errno(58));
            }
            if flags & (16 | 32) != 0 && a[19] != 0 {
                return Err(Failure::Errno(28));
            }
            if flags & 32 != 0 && a[18] != 0 {
                return Err(Failure::Errno(63));
            }
            if a[11] > 65536 {
                return Err(Failure::Errno(22));
            }
            let search_path = if a[10] == 0 {
                if a[11] != 0 {
                    return Err(Failure::Errno(21));
                }
                None
            } else {
                let raw = bytes(caller, a[10], a[11])?;
                let value = std::str::from_utf8(&raw).map_err(|_| Failure::Errno(25))?;
                if value.contains('\0') || value.split(':').count() > 256 {
                    return Err(Failure::Errno(28));
                }
                Some(value.to_string())
            };
            let mut normalized = args[..10].to_vec();
            normalized.push(u64::from(flags & !(16 | 32)));
            normalized.extend_from_slice(&args[13..18]);
            normalized.push(args[20]);
            let result = dispatch(caller, "proc_spawn_v3", &normalized);
            if matches!(result, Err(Failure::Suspend))
                && let Some(pending) = caller.data_mut().pending.as_mut()
                && let Request::Spawn {
                    search_path: target,
                    ..
                } = &mut pending.request
            {
                *target = search_path;
            }
            return result;
        }
        "proc_spawn_v3" => {
            bytes(caller, a[16], 4)?;
            if a[10] & !207 != 0 {
                return Err(Failure::Errno(58));
            }
            let signal_defaults = if a[10] & 4 != 0 {
                u64::from(a[11] as u32) | (u64::from(a[12] as u32) << 32)
            } else {
                0
            };
            let new_session = a[10] & 128 != 0;
            if new_session && a[10] & 2 != 0 {
                return Err(Failure::Errno(63));
            }
            let group = if a[10] & 2 != 0 {
                if a[15] as u32 > i32::MAX as u32 {
                    return Err(Failure::Errno(28));
                }
                Some(a[15] as u32)
            } else {
                if a[15] != 0 {
                    return Err(Failure::Errno(28));
                }
                None
            };
            let cwd = bytes(caller, a[8], a[9])?;
            let cwd = std::str::from_utf8(&cwd).map_err(|_| Failure::Errno(25))?;
            if cwd.len() > 4096 || cwd.contains('\0') {
                return Err(Failure::Errno(28));
            }
            let mut cwd_steps = vec![caller.data().cwd.clone()];
            if !cwd.is_empty() {
                cwd_steps.push(cwd.into());
            }
            let raw = bytes(caller, a[0], a[1])?;
            if raw.is_empty() || raw.len() > 4096 || raw.contains(&0) {
                return Err(Failure::Errno(28));
            }
            let path = std::str::from_utf8(&raw)
                .map_err(|_| Failure::Errno(25))?
                .to_string();
            let argv = spawn_strings(caller, a[2], a[3])?;
            let envp = spawn_strings(caller, a[4], a[5])?;
            if argv.len() > 129 || envp.len() > 128 {
                return Err(Failure::Errno(22));
            }
            let mut env = BTreeMap::new();
            for entry in envp {
                let (key, value) = entry.split_once('=').ok_or(Failure::Errno(28))?;
                if key.is_empty() || key.chars().count() > 128 {
                    return Err(Failure::Errno(28));
                }
                env.insert(key.to_string(), value.to_string());
            }
            if a[7] > 65536 {
                return Err(Failure::Errno(22));
            }
            let encoded = bytes(caller, a[6], a[7])?;
            let mut actions = Vec::new();
            let mut resources = SpawnResources {
                descriptors: caller.data().descriptors.clone(),
                files: caller.data().files.clone(),
                closed: caller.data().closed.clone(),
                cloexec: caller.data().cloexec.clone(),
            };
            for fd in 0..3 {
                if let Ok(descriptor) = duplicate_source(caller.data(), fd) {
                    resources.descriptors.entry(fd).or_insert(descriptor);
                }
            }
            let mut offset = 0usize;
            while offset < encoded.len() {
                let header = encoded.get(offset..offset + 24).ok_or(Failure::Errno(28))?;
                let fields: Vec<u32> = header
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|word| u32::from_le_bytes(*word))
                    .collect();
                offset += 24;
                let length = fields[5] as usize;
                let end = offset.checked_add(length).ok_or(Failure::Errno(28))?;
                let raw = encoded.get(offset..end).ok_or(Failure::Errno(28))?;
                offset = end;
                if actions.len() >= 128 || length > 4096 {
                    return Err(Failure::Errno(22));
                }
                let path = std::str::from_utf8(raw).map_err(|_| Failure::Errno(25))?;
                if path.contains('\0') {
                    return Err(Failure::Errno(28));
                }
                match fields[0] {
                    1 | 2 | 5 => {
                        if length != 0 || fields[1] >= MAX_FILES as u32 + 4 {
                            return Err(Failure::Errno(8));
                        }
                        if fields[0] == 2 && fields[2] >= MAX_FILES as u32 + 4 {
                            return Err(Failure::Errno(8));
                        }
                        if fields[3] != 0 || fields[4] != 0 {
                            return Err(Failure::Errno(58));
                        }
                    }
                    6 => {
                        if fields[1] > i32::MAX as u32 {
                            return Err(Failure::Errno(8));
                        }
                        if length != 0 {
                            return Err(Failure::Errno(28));
                        }
                        if fields[2] != 0 || fields[3] != 0 || fields[4] != 0 {
                            return Err(Failure::Errno(58));
                        }
                    }
                    3 => {
                        if fields[1] >= MAX_FILES as u32 + 4 || path.is_empty() {
                            return Err(Failure::Errno(28));
                        }
                        if fields[3] & !0xb0ec3 != 0 {
                            return Err(Failure::Errno(58));
                        }
                        if fields[3] & 3 == 3 || fields[4] & !0o7777 != 0 {
                            return Err(Failure::Errno(28));
                        }
                    }
                    4 => {
                        if path.is_empty() {
                            return Err(Failure::Errno(28));
                        }
                    }
                    _ => return Err(Failure::Errno(58)),
                }
                actions.push(SpawnAction {
                    command: fields[0],
                    fd: fields[1],
                    source: fields[2],
                    flags: fields[3],
                    mode: fields[4],
                    path: path.into(),
                });
            }
            let mask = if a[10] & 8 != 0 {
                (u64::from(a[13] as u32) | (u64::from(a[14] as u32) << 32))
                    & !((1 << 8) | (1 << 18))
            } else {
                caller.data().signal_mask
            };
            suspend(
                caller,
                Request::Spawn {
                    path,
                    argv,
                    env,
                    cwd_steps,
                    search_path: None,
                    actions: actions.clone(),
                },
                Completion::Spawn {
                    pointer: a[16],
                    resources,
                    actions,
                    mask,
                    group,
                    new_session,
                    signal_defaults,
                },
            )?;
        }
        "proc_waitpid_v3" => {
            if a[1] & !11 != 0 {
                return Err(Failure::Errno(28));
            }
            let selector = a[0] as u32 as i32;
            let table = caller.data().processes.borrow();
            let group = if caller.data().pid == 1 {
                table.root_group
            } else {
                table
                    .children
                    .get(&caller.data().pid)
                    .ok_or(Failure::Errno(71))?
                    .group
            };
            let pids: Vec<u32> = table
                .children
                .iter()
                .filter(|(pid, child)| {
                    child.parent == caller.data().pid
                        && (selector == -1
                            || (selector > 0 && **pid == selector as u32)
                            || (selector == 0 && child.group == group)
                            || (selector < -1 && child.group == selector.unsigned_abs()))
                })
                .map(|(pid, _)| *pid)
                .collect();
            drop(table);
            if pids.is_empty() {
                return Err(Failure::Errno(12));
            }
            bytes(caller, a[2], 4)?;
            bytes(caller, a[3], 4)?;
            let ready = take_wait_status(
                &mut caller.data().processes.borrow_mut(),
                &pids,
                a[1] as u32,
            );
            if let Some((pid, status, failed)) = ready {
                if failed {
                    return Err(Failure::Errno(29));
                }
                put(caller, a[2], &status.to_le_bytes())?;
                put(caller, a[3], &pid.to_le_bytes())?;
                return Ok(0);
            }
            if a[1] & 1 != 0 {
                put(caller, a[2], &0u32.to_le_bytes())?;
                put(caller, a[3], &0u32.to_le_bytes())?;
                return Ok(0);
            }
            suspend(
                caller,
                Request::Wait { pids: pids.clone() },
                Completion::WaitRaw {
                    pids,
                    options: a[1] as u32,
                    status: a[2],
                    pid: a[3],
                },
            )?;
        }
        "proc_waitpid_v2" => {
            if a[1] & !1 != 0 {
                return Err(Failure::Errno(28));
            }
            let pid = a[0] as u32;
            let pids: Vec<u32> = caller
                .data()
                .processes
                .borrow()
                .children
                .iter()
                .filter(|(id, child)| {
                    child.parent == caller.data().pid && (pid == u32::MAX || pid == **id)
                })
                .map(|(id, _)| *id)
                .collect();
            if pids.is_empty() {
                return Err(Failure::Errno(12));
            }
            let pointers = [a[2], a[3], a[4], a[5]];
            for pointer in pointers {
                bytes(caller, pointer, 4)?;
            }
            let ready = caller
                .data()
                .processes
                .borrow()
                .children
                .iter()
                .find(|(id, child)| pids.contains(id) && (child.code.is_some() || child.failed))
                .map(|(id, child)| (*id, child.code, child.failed, child.signal));
            if let Some((pid, code, failed, signal)) = ready {
                caller.data().processes.borrow_mut().children.remove(&pid);
                if failed {
                    return Err(Failure::Errno(29));
                }
                let code = code.ok_or(Failure::Errno(29))?;
                for (pointer, value) in pointers.into_iter().zip([code as u32, signal, pid, 0]) {
                    put(caller, pointer, &value.to_le_bytes())?;
                }
                return Ok(0);
            }
            if a[1] == 1 {
                for pointer in pointers {
                    put(caller, pointer, &0u32.to_le_bytes())?;
                }
                return Ok(0);
            }
            suspend(
                caller,
                Request::Wait { pids: pids.clone() },
                Completion::Wait { pids, pointers },
            )?;
        }
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
            if let Some(signal) = deliver_signal(caller.data_mut()) {
                if caller.data().caught_signal.is_some() {
                    suspend(caller, Request::Handler, Completion::Sync)?;
                }
                if caller.data().stopped.get() {
                    suspend(caller, Request::Stopped, Completion::Sync)?;
                }
                return Err(Failure::Signal(signal));
            }
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
            caller
                .data()
                .processes
                .borrow_mut()
                .pipes
                .retain(|pipe| pipe.strong_count() > 0);
            if caller.data().processes.borrow().pipes.len() >= 64 {
                return Err(Failure::Errno(33));
            }
            let pipe = Rc::new(Pipe {
                bytes: RefCell::new(VecDeque::new()),
                readers: Cell::new(1),
                writers: Cell::new(1),
            });
            caller
                .data()
                .processes
                .borrow_mut()
                .pipes
                .push(Rc::downgrade(&pipe));
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
                let path = descriptor_path(caller.data(), descriptor)?;
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
                let rights = descriptor_rights(caller.data(), a[0] as u32)?.0;
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
        "fd_fdstat_set_rights" => {
            let fd = a[0] as u32;
            let (base, inheriting) = descriptor_rights(caller.data(), fd)?;
            if args[1] & !base != 0 || args[2] & !inheriting != 0 {
                return Err(Failure::Errno(76));
            }
            if let Some(descriptor) = caller.data_mut().descriptors.get_mut(&fd) {
                descriptor.rights = args[1];
                descriptor.inheriting = args[2];
            } else {
                let mut descriptor = duplicate_source(caller.data(), fd)?;
                descriptor.rights = args[1];
                descriptor.inheriting = args[2];
                caller.data_mut().descriptors.insert(fd, descriptor);
            }
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
                    let start = state.stdin_offset.get();
                    let end = start.saturating_add(length).min(state.stdin.len());
                    let data = state.stdin[start..end].to_vec();
                    put(caller, pointer, &data)?;
                    caller.data().stdin_offset.set(end);
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
                    return suspend(
                        caller,
                        Request::Poll {
                            clocks: Vec::new(),
                            immediate: false,
                        },
                        Completion::PipeRead {
                            fd: a[0] as u32,
                            vectors,
                            output,
                        },
                    );
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
                if read != 0 {
                    caller.data_mut().readiness_notification = true;
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
                let data = {
                    let file = caller
                        .data()
                        .files
                        .get(&descriptor.cache.ok_or(Failure::Errno(8))?)
                        .ok_or(Failure::Errno(8))?
                        .borrow();
                    let start = offset.min(file.bytes.len());
                    let end = start.saturating_add(length).min(file.bytes.len());
                    file.bytes[start..end].to_vec()
                };
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
                if state.stdout.borrow().len() + state.stderr.borrow().len() + data.len()
                    > state.max_output
                {
                    return Err(Failure::Errno(22));
                }
                if index == 1 {
                    state.stdout.borrow_mut().extend(&data);
                } else {
                    state.stderr.borrow_mut().extend(&data);
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
                        return suspend(
                            caller,
                            Request::Poll {
                                clocks: Vec::new(),
                                immediate: false,
                            },
                            Completion::PipeWrite {
                                fd: a[0] as u32,
                                data,
                                output,
                            },
                        );
                    }
                    let count = data.len().min(available);
                    pipe.pipe.bytes.borrow_mut().extend(&data[..count]);
                    if count != 0 {
                        state.readiness_notification = true;
                    }
                    put(caller, output, &(count as u32).to_le_bytes())?;
                    return Ok(0);
                }
                let file = state
                    .files
                    .get(&descriptor.cache.ok_or(Failure::Errno(8))?)
                    .ok_or(Failure::Errno(8))?
                    .borrow()
                    .bytes
                    .len();
                let offset = if name == "fd_pwrite" {
                    usize::try_from(args[3]).map_err(|_| Failure::Errno(28))?
                } else if descriptor.flags.get() & 1 != 0 {
                    file
                } else {
                    descriptor.offset.get()
                };
                let end = offset.checked_add(data.len()).ok_or(Failure::Errno(22))?;
                let total: usize = buffered_bytes(state);
                if end > MAX_BYTES {
                    return Err(Failure::Errno(22));
                }
                if total - file + file.max(end) > MAX_BYTES {
                    return Err(Failure::Errno(48));
                }
                let file = state
                    .files
                    .get_mut(&descriptor.cache.ok_or(Failure::Errno(8))?)
                    .ok_or(Failure::Errno(8))?;
                let mut buffer = file.borrow_mut();
                let linked_path = buffer.path.clone();
                let file = &mut buffer.bytes;
                let previous_length = file.len();
                let previous = file[offset.min(file.len())..end.min(file.len())].to_vec();
                if end > file.len() {
                    file.resize(end, 0);
                }
                file[offset..end].copy_from_slice(&data);
                let path = linked_path;
                drop(buffer);
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
        "fd_advise" => {
            if !(0..=5).contains(&a[3]) {
                return Err(Failure::Errno(28));
            }
            let state = caller.data();
            let fd = a[0] as u32;
            if state.closed.contains(&fd) || fd == HIDDEN_PREOPEN {
                return Err(Failure::Errno(8));
            }
            let descriptor = match state.descriptors.get(&fd) {
                Some(descriptor) => descriptor,
                None if stream(state, fd).is_some() => return Err(Failure::Errno(76)),
                None => return Err(Failure::Errno(8)),
            };
            if descriptor.rights & (1 << 7) == 0 {
                return Err(Failure::Errno(76));
            }
            if descriptor.directory {
                return Err(Failure::Errno(31));
            }
            if descriptor.stdio.is_some() || descriptor.pipe.is_some() {
                return Err(Failure::Errno(70));
            }
            args[1].checked_add(args[2]).ok_or(Failure::Errno(61))?;
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
                .borrow()
                .bytes
                .len();
            let size = if name == "fd_allocate" {
                size.max(previous_length)
            } else {
                size
            };
            let total: usize = buffered_bytes(state);
            if total - previous_length + size > MAX_BYTES {
                return Err(Failure::Errno(48));
            }
            let file = state.files.get_mut(&cache).ok_or(Failure::Errno(8))?;
            let mut file = file.borrow_mut();
            let previous = file.bytes[size.min(previous_length)..].to_vec();
            let path = file.path.clone();
            file.bytes.resize(size, 0);
            drop(file);
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
            let path = descriptor_path(caller.data(), descriptor)?;
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
            let mut pipe_fds = BTreeMap::new();
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
                            if descriptor_rights(state, fd)?.0 & (1 << 27) == 0 {
                                errno = 76;
                            } else if index == 0 && !writing {
                                let available =
                                    state.stdin.len().saturating_sub(state.stdin_offset.get());
                                event[16..24].copy_from_slice(&(available as u64).to_le_bytes());
                                if available == 0 {
                                    event[24..26].copy_from_slice(&1u16.to_le_bytes());
                                }
                            } else if index > 0 && writing {
                                let available = state.max_output.saturating_sub(
                                    state.stdout.borrow().len() + state.stderr.borrow().len(),
                                );
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
                                pipe_fds.insert(index, fd);
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
                                let file = file.borrow();
                                let available = if writing {
                                    let total: usize = buffered_bytes(state);
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
                    pipe_fds,
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
            let path = descriptor_path(caller.data(), descriptor)?;
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
            if let Some(fd) = descriptor_alias(&path)? {
                if a[1] & 1 == 0 {
                    return Err(Failure::Errno(58));
                }
                let descriptor = caller
                    .data()
                    .descriptors
                    .get(&fd)
                    .ok_or(Failure::Errno(44))?;
                let cache = descriptor.cache.ok_or(Failure::Errno(58))?;
                let metadata = caller
                    .data()
                    .files
                    .get(&cache)
                    .ok_or(Failure::Errno(8))?
                    .borrow()
                    .metadata;
                put(caller, a[4], &metadata[..64])?;
                return Ok(0);
            }
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
                    let mode = 0o777 & !caller.data().umask;
                    suspend(
                        caller,
                        Request::Mkdir { path, base, mode },
                        Completion::Unit,
                    )?;
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
        "path_link" => {
            if a[1] & !1 != 0 {
                return Err(Failure::Errno(28));
            }
            let (from, from_base) = directory_path(caller, a[0] as u32, a[2], a[3], 1 << 11)?;
            let (to, to_base) = directory_path(caller, a[4] as u32, a[5], a[6], 1 << 12)?;
            suspend(
                caller,
                Request::Link {
                    from,
                    from_base,
                    to,
                    to_base,
                    follow: a[1] & 1 != 0,
                },
                Completion::Unit,
            )?;
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
        "umask" | "proc_umask" => {
            let (set_mask, pointer) = if name == "umask" {
                if !matches!(a[1], 0 | 1) {
                    return Err(Failure::Errno(28));
                }
                (a[1] != 0, a[2])
            } else {
                (true, a[1])
            };
            bytes(caller, pointer, 4)?;
            let previous = caller.data().umask;
            put(caller, pointer, &previous.to_le_bytes())?;
            if set_mask {
                caller.data_mut().umask = a[0] as u32 & 0o777;
            }
        }
        "set_raw_mode" => return Err(Failure::Errno(59)),
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
                | (1 << 7)
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
                    mode: a[4] as u32 & 0o7777 & !caller.data().umask,
                },
                Completion::Tmpfile {
                    descriptor,
                    pointer: a[5],
                },
            )?;
        }
        "path_open" => {
            let requested_mode = caller.data_mut().open_mode.take().unwrap_or(0o666);
            let direct = std::mem::take(&mut caller.data_mut().open_direct);
            if direct {
                return Err(Failure::Errno(58));
            }
            if requested_mode > 0o777 {
                return Err(Failure::Errno(28));
            }
            let mode = requested_mode & !caller.data().umask;
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
                || (a[4] & 1 != 0 && parent.rights & (1 << 10) == 0)
                || (a[4] & 8 != 0 && parent.rights & (1 << 19) == 0)
                || args[5] & !parent.inheriting != 0
                || args[6] & !parent.inheriting != 0
            {
                return Err(Failure::Errno(76));
            }
            let base = parent.path.clone();
            let raw = bytes(caller, a[2], a[3])?;
            let raw = std::str::from_utf8(&raw).map_err(|_| Failure::Errno(25))?;
            let path = confined(&base, raw)?;
            if let Some(fd) = descriptor_alias(&path)? {
                if a[1] & 1 == 0 {
                    return Err(Failure::Errno(32));
                }
                if a[4] != 0 || args[5] & 64 != 0 || args[6] != 0 || a[7] != 0 {
                    return Err(Failure::Errno(58));
                }
                let source = caller
                    .data()
                    .descriptors
                    .get(&fd)
                    .ok_or(Failure::Errno(44))?;
                if source.directory || source.cache.is_none() {
                    return Err(Failure::Errno(58));
                }
                if args[5] & !source.rights != 0 || !source.read {
                    return Err(Failure::Errno(76));
                }
                let descriptor = Descriptor {
                    rights: args[5],
                    inheriting: 0,
                    write: false,
                    flags: Rc::new(Cell::new(0)),
                    offset: Rc::new(Cell::new(0)),
                    ..source.clone()
                };
                let next = (4..MAX_FILES as u32 + 4)
                    .find(|candidate| !caller.data().descriptors.contains_key(candidate))
                    .ok_or(Failure::Errno(33))?;
                caller.data_mut().descriptors.insert(next, descriptor);
                put(caller, a[8], &next.to_le_bytes())?;
                return Ok(0);
            }
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
        "proc_closefrom" => {
            let minimum = a[0] as u32;
            let state = caller.data_mut();
            let closing: Vec<u32> = state
                .descriptors
                .keys()
                .copied()
                .filter(|fd| *fd >= minimum && *fd != HIDDEN_PREOPEN)
                .collect();
            for fd in closing {
                close(state, fd);
            }
            for fd in minimum.min(3)..3 {
                close(state, fd);
            }
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
                        .borrow()
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
                    Err(Failure::Signal(signal)) => Err(Error::i32_exit(128 + signal as i32)),
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
    bind!("wasi_snapshot_preview1","fd_fdstat_set_rights",a:i32,b:i64,c:i64);
    bind!("wasi_snapshot_preview1","fd_read",a:i32,b:i32,c:i32,d:i32);
    bind!("wasi_snapshot_preview1","fd_write",a:i32,b:i32,c:i32,d:i32);
    bind!("wasi_snapshot_preview1","fd_pread",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("wasi_snapshot_preview1","fd_pwrite",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("wasi_snapshot_preview1","path_open",a:i32,b:i32,c:i32,d:i32,e:i32,f:i64,g:i64,h:i32,i:i32);
    bind!("wasi_snapshot_preview1","path_create_directory",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","path_remove_directory",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","path_unlink_file",a:i32,b:i32,c:i32);
    bind!("wasi_snapshot_preview1","path_readlink",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32);
    bind!("wasi_snapshot_preview1","path_link",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32,g:i32);
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
    bind!("wasi_snapshot_preview1","fd_advise",a:i32,b:i64,c:i64,d:i32);
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
    bind!("host_process","umask",a:i32,b:i32,c:i32);
    bind!("host_process","proc_umask",a:i32,b:i32);
    bind!("host_tty","set_raw_mode",a:i32);
    linker
        .func_wrap(
            "host_tty",
            "read",
            |_caller: Caller<'_, State>,
             _pointer: i32,
             _length: i32,
             _timeout: i32|
             -> Result<i32, Error> {
                Err(Error::new("TTY input requires an attached terminal"))
            },
        )
        .map_err(|error| error.to_string())?;
    bind!("host_process","proc_getpid",a:i32);
    bind!("host_process","proc_kill",a:i32,b:i32);
    bind!("host_process","proc_sigaction",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("host_process","proc_waitpid_v3",a:i32,b:i32,c:i32,d:i32);
    bind!("host_process","proc_getpgid",a:i32,b:i32);
    bind!("host_process","proc_setpgid",a:i32,b:i32);
    bind!("host_process","proc_getppid",a:i32);
    bind!("host_process","proc_exec",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32,g:i32,h:i32);
    bind!("host_process","proc_fexec",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32,g:i32);
    for (name, count) in [("proc_spawn_v3", 17), ("proc_spawn_v4", 21)] {
        linker
            .func_new(
                "host_process",
                name,
                wasmi::FuncType::new(vec![wasmi::ValType::I32; count], [wasmi::ValType::I32]),
                move |mut caller, inputs, outputs| {
                    let args: Vec<u64> = inputs
                        .iter()
                        .map(|value| u64::from(value.i32().unwrap() as u32))
                        .collect();
                    outputs[0] = Val::I32(match dispatch(&mut caller, name, &args) {
                        Ok(value) => value,
                        Err(Failure::Errno(errno)) => errno,
                        Err(Failure::Suspend) => return Err(Error::new("Cirro host request")),
                        Err(Failure::Budget) => {
                            return Err(Error::new("WASI host request budget exceeded"));
                        }
                        Err(Failure::Signal(signal)) => {
                            return Err(Error::i32_exit(128 + signal as i32));
                        }
                    });
                    Ok(())
                },
            )
            .map_err(|error| error.to_string())?;
    }
    bind!("host_process","proc_waitpid_v2",a:i32,b:i32,c:i32,d:i32,e:i32,f:i32);
    bind!("host_process","proc_signal_mask_v2",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("host_process","fd_pipe",a:i32,b:i32);
    bind!("host_process","fd_dup",a:i32,b:i32);
    bind!("host_process","fd_dup2",a:i32,b:i32);
    bind!("host_process","proc_closefrom",a:i32);
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
                    Err(Failure::Signal(signal)) => Err(Error::i32_exit(128 + signal as i32)),
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
    trampoline: Option<Func>,
    entry: Option<(Func, Vec<Val>)>,
    parameters: Vec<Val>,
    handlers: Vec<HandlerFrame>,
    function: Func,
    memory: Option<Memory>,
    invocation: Option<ResumableCallHostTrap>,
    exhaustion: Option<ResumableCallOutOfFuel>,
    budget: Rc<Cell<u64>>,
    memory_limit: usize,
    fuel_limit: u64,
    response: Option<Val>,
    outputs: Vec<Val>,
    done: Option<i32>,
}

enum GuestInitialization<'a> {
    Fresh(&'a [u8]),
    Replacement {
        state: &'a State,
        closed: &'a BTreeSet<u32>,
    },
}

fn resumable_start(bytes: &[u8]) -> Result<Option<(Vec<u8>, String)>, String> {
    use wasm_encoder::reencode::Reencode;
    let mut start = None;
    let mut names = BTreeSet::new();
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        match payload.map_err(|error| error.to_string())? {
            wasmparser::Payload::StartSection { func, .. } => start = Some(func),
            wasmparser::Payload::ExportSection(reader) => {
                for export in reader {
                    names.insert(export.map_err(|error| error.to_string())?.name.to_string());
                }
            }
            _ => {}
        }
    }
    let Some(start) = start else {
        return Ok(None);
    };
    let name = (0..=names.len())
        .map(|index| format!("__cirro_start_{index}"))
        .find(|name| !names.contains(name))
        .ok_or("No available start export")?;
    let mut module = wasm_encoder::Module::new();
    let mut exported = false;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|error| error.to_string())?;
        match payload {
            wasmparser::Payload::ExportSection(reader) => {
                let mut exports = wasm_encoder::ExportSection::new();
                wasm_encoder::reencode::RoundtripReencoder
                    .parse_export_section(&mut exports, reader)
                    .map_err(|error| error.to_string())?;
                exports.export(&name, wasm_encoder::ExportKind::Func, start);
                module.section(&exports);
                exported = true;
            }
            wasmparser::Payload::StartSection { .. } => {
                if !exported {
                    let mut exports = wasm_encoder::ExportSection::new();
                    exports.export(&name, wasm_encoder::ExportKind::Func, start);
                    module.section(&exports);
                }
            }
            _ => {
                if let Some((id, range)) = payload.as_section() {
                    module.section(&wasm_encoder::RawSection {
                        id,
                        data: &bytes[range],
                    });
                }
            }
        }
    }
    Ok(Some((module.finish(), name)))
}

impl WasmGuest {
    fn create(
        bytes: &[u8],
        configuration: &str,
        initialization: GuestInitialization<'_>,
        memory: usize,
        fuel: u64,
        max_output: usize,
        pool: Option<Rc<Cell<u64>>>,
    ) -> Result<Self, String> {
        if bytes.len() > MAX_MODULE_BYTES
            || !(4_194_304..=33_554_432).contains(&memory)
            || fuel == 0
            || fuel > 100_000_000
            || !(1024..=1_048_576).contains(&max_output)
        {
            return Err("Invalid Wasm execution limits".into());
        }
        let stdin = match initialization {
            GuestInitialization::Fresh(stdin) => stdin,
            GuestInitialization::Replacement { .. } => &[],
        };
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
        config.compilation_mode(CompilationMode::LazyTranslation);
        config.fuel_cost(CustomFuelCosts {
            bytes_copied_per_fuel: 64,
            fuel_per_bytes_translated: 0,
            fuel_per_bytes_validated: 0,
        });
        config.wasm_tail_call(false);
        let engine = Engine::new(&config);
        let prepared = resumable_start(bytes)?;
        let image = prepared
            .as_ref()
            .map(|(bytes, _)| bytes.as_slice())
            .unwrap_or(bytes);
        let module = Module::new(&engine, image).map_err(|error| error.to_string())?;
        let limits = StoreLimitsBuilder::new()
            .memory_size(memory)
            .table_elements(4096)
            .instances(1)
            .tables(1)
            .memories(1)
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
        let pending_signals = Rc::new(Cell::new(0));
        let stopped = Rc::new(Cell::new(false));
        let transitions = Rc::new(RefCell::new(VecDeque::new()));
        let dispositions = Rc::new(RefCell::new(BTreeMap::new()));
        let mut store = Store::new(
            &engine,
            State {
                limits,
                descriptors: BTreeMap::from([(3, root.clone()), (HIDDEN_PREOPEN, root)]),
                files: BTreeMap::new(),
                stdout: Rc::new(RefCell::new(Vec::new())),
                stderr: Rc::new(RefCell::new(Vec::new())),
                max_output,
                pending: None,
                requests: Rc::new(Cell::new(0)),
                pid: 1,
                parent_pid: 0,
                cwd: "/".into(),
                processes: Rc::new(RefCell::new(ProcessTable {
                    next_pid: 2,
                    root_group: 1,
                    root_session: 1,
                    root_pending_signals: pending_signals.clone(),
                    root_dispositions: dispositions.clone(),
                    root_stopped: stopped.clone(),
                    root_transitions: transitions.clone(),
                    memory_bytes: memory,
                    children: BTreeMap::new(),
                    buffers: Vec::new(),
                    pipes: Vec::new(),
                })),
                closed: BTreeSet::new(),
                cloexec: BTreeSet::new(),
                signal_mask: 0,
                pending_signals,
                delivered_signal: 0,
                dispositions,
                caught_signal: None,
                stopped,
                transitions,
                readiness_notification: false,
                stdio_flags: std::array::from_fn(|_| Rc::new(Cell::new(0))),
                argv,
                environment,
                stdin_pipe: None,
                stdin_writer: Rc::new(RefCell::new(None)),
                stdin: Rc::new(stdin.to_vec()),
                stdin_offset: Rc::new(Cell::new(0)),
                directories: BTreeMap::new(),
                umask: 0o022,
                open_mode: None,
                open_direct: false,
            },
        );
        if let GuestInitialization::Replacement {
            state: previous,
            closed,
        } = &initialization
        {
            let state = store.data_mut();
            state.descriptors = previous.descriptors.clone();
            state.files = previous.files.clone();
            state.closed = previous.closed.clone();
            state.cloexec = previous.cloexec.clone();
            state.stdout = previous.stdout.clone();
            state.stderr = previous.stderr.clone();
            state.stdin_pipe = previous.stdin_pipe.clone();
            state.stdin_writer = previous.stdin_writer.clone();
            state.stdin = previous.stdin.clone();
            state.stdin_offset = previous.stdin_offset.clone();
            state.stdio_flags = previous.stdio_flags.clone();
            state.requests = previous.requests.clone();
            state.pid = previous.pid;
            state.parent_pid = previous.parent_pid;
            state.cwd = previous.cwd.clone();
            state.umask = previous.umask;
            state.signal_mask = previous.signal_mask;
            state.pending_signals = previous.pending_signals.clone();
            state.stopped = previous.stopped.clone();
            state.transitions = previous.transitions.clone();
            state.directories = previous.directories.clone();
            state.processes = previous.processes.clone();
            *state.dispositions.borrow_mut() = previous
                .dispositions
                .borrow()
                .iter()
                .filter(|(_, disposition)| disposition.action == 1)
                .map(|(signal, disposition)| (*signal, disposition.clone()))
                .collect();
            for fd in state
                .cloexec
                .clone()
                .union(closed)
                .copied()
                .collect::<Vec<_>>()
            {
                close(state, fd);
            }
        }
        store.limiter(|state| &mut state.limits);
        store.set_fuel(fuel).map_err(|error| error.to_string())?;
        let linker = linker(&engine)?;
        if let Some(pool) = &pool {
            pool.set(0);
        }
        let started = linker.instantiate_and_start(&mut store, &module);
        if let Some(pool) = &pool {
            pool.set(store.get_fuel().map_err(|error| error.to_string())?);
        }
        let instance = started.map_err(|error| error.to_string())?;
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
        let initializer = prepared
            .as_ref()
            .map(|(_, name)| {
                instance
                    .get_func(&store, name)
                    .ok_or("Missing start export")
            })
            .transpose()?;
        if let Some(initializer) = initializer {
            let ty = initializer.ty(&store);
            if !ty.params().is_empty() || !ty.results().is_empty() {
                return Err("Invalid Wasm start signature".into());
            }
        }
        let (function, outputs, entry) = if let Some(initializer) = initializer {
            (initializer, Vec::new(), Some((function, outputs)))
        } else {
            (function, outputs, None)
        };
        let memory_limit = memory;
        let memory = instance.get_memory(&store, "memory");
        let available = store.get_fuel().map_err(|error| error.to_string())?;
        store.set_fuel(0).map_err(|error| error.to_string())?;
        let trampoline = instance.get_func(&store, "__wasi_signal_trampoline");
        if matches!(initialization, GuestInitialization::Replacement { .. }) {
            store.data().processes.borrow_mut().memory_bytes += memory_limit;
        }
        Ok(Self {
            entry,
            trampoline,
            parameters: Vec::new(),
            handlers: Vec::new(),
            store,
            function,
            memory,
            invocation: None,
            exhaustion: None,
            budget: pool.unwrap_or_else(|| Rc::new(Cell::new(available))),
            memory_limit,
            fuel_limit: fuel,
            response: None,
            outputs,
            done: None,
        })
    }

    fn enter_handler(&mut self, signal: u32) -> Result<(), String> {
        if self.handlers.len() >= 32 {
            return Err("Wasm signal handler nesting exceeds 32".into());
        }
        let disposition = self
            .store
            .data()
            .dispositions
            .borrow()
            .get(&signal)
            .cloned()
            .ok_or("Missing signal disposition")?;
        let trampoline = self.trampoline.ok_or("Missing signal trampoline")?;
        let state = self.store.data_mut();
        let mask = state.signal_mask;
        state.signal_mask |= disposition.mask;
        if disposition.flags & 0x40000000 == 0 {
            state.signal_mask |= 1u64 << (signal - 1);
        }
        if disposition.flags & 0x80000000 != 0 {
            state.dispositions.borrow_mut().remove(&signal);
        }
        state.caught_signal = None;
        let pending = state.pending.take();
        self.handlers.push(HandlerFrame {
            function: self.function,
            parameters: std::mem::take(&mut self.parameters),
            outputs: std::mem::take(&mut self.outputs),
            invocation: self.invocation.take(),
            exhaustion: self.exhaustion.take(),
            response: self.response.take(),
            pending,
            mask,
            restart: disposition.flags & 0x10000000 != 0,
        });
        self.function = trampoline;
        self.parameters = vec![Val::I32(signal as i32)];
        Ok(())
    }
    fn finish_handler(&mut self) -> Result<(), String> {
        let frame = self.handlers.pop().ok_or("Missing signal handler frame")?;
        self.function = frame.function;
        self.parameters = frame.parameters;
        self.outputs = frame.outputs;
        self.invocation = frame.invocation;
        self.exhaustion = frame.exhaustion;
        self.response = frame.response;
        self.store.data_mut().pending = frame.pending;
        self.store.data_mut().signal_mask = frame.mask;
        let interrupt = self.store.data().pending.as_ref().is_some_and(|pending| {
            matches!(
                pending.completion,
                Completion::PipeRead { .. }
                    | Completion::PipeWrite { .. }
                    | Completion::Poll { .. }
                    | Completion::Wait { .. }
                    | Completion::WaitRaw { .. }
            )
        });
        let restartable = self.store.data().pending.as_ref().is_some_and(|pending| {
            matches!(
                pending.completion,
                Completion::PipeRead { .. }
                    | Completion::PipeWrite { .. }
                    | Completion::Wait { .. }
                    | Completion::WaitRaw { .. }
            )
        });
        if interrupt && !(frame.restart && restartable) && !self.wait_ready() {
            self.respond(27, &[], "/", false, 0, &[])
                .map_err(|error| format!("{error:?}"))?;
        }
        Ok(())
    }
    fn observe_signal(&mut self, handlers: bool) -> Result<bool, String> {
        if self.done.is_some() {
            return Ok(false);
        }
        let pending = self.store.data().pending_signals.get();
        let selected = if pending & (1 << 8) != 0 {
            self.store.data_mut().caught_signal = None;
            deliver_signal(self.store.data_mut())
        } else if self.store.data().stopped.get() {
            return Ok(false);
        } else if pending & (1 << 18) != 0 {
            deliver_signal(self.store.data_mut())
        } else if self.store.data().caught_signal.is_some() {
            self.store.data().caught_signal
        } else {
            deliver_signal(self.store.data_mut())
        };
        if let Some(signal) = selected {
            if self.store.data().stopped.get() {
                return Ok(false);
            }
            if self.store.data().caught_signal.is_some() {
                if handlers {
                    self.enter_handler(signal)?;
                    return Ok(true);
                }
                return Ok(self.store.data().pending.as_ref().is_some_and(|pending| {
                    matches!(
                        pending.completion,
                        Completion::PipeRead { .. }
                            | Completion::PipeWrite { .. }
                            | Completion::Poll { .. }
                            | Completion::Wait { .. }
                            | Completion::WaitRaw { .. }
                    )
                }));
            }
            self.done = Some(128 + signal as i32);
            self.outputs.clear();
            self.invocation = None;
            self.exhaustion = None;
            self.response = None;
            self.handlers.clear();
            self.store.data_mut().pending = None;
            return Ok(true);
        }
        Ok(false)
    }

    fn advance(&mut self) -> Result<(), String> {
        let required = self
            .exhaustion
            .as_ref()
            .map(ResumableCallOutOfFuel::required_fuel)
            .unwrap_or(1);
        let available = self.budget.get();
        if available < required {
            return Err("Wasm fuel exhausted".into());
        }
        let slice = available.min(FUEL_SLICE).max(required);
        self.budget.set(available - slice);
        self.store
            .set_fuel(slice)
            .map_err(|error| error.to_string())?;
        let call = if let Some(invocation) = self.exhaustion.take() {
            invocation.resume(&mut self.store, &mut self.outputs)
        } else {
            match self.invocation.take() {
                Some(invocation) => {
                    let response = self
                        .response
                        .take()
                        .ok_or("Wasm host response is required")?;
                    invocation.resume(&mut self.store, &[response], &mut self.outputs)
                }
                None => self.function.call_resumable(
                    &mut self.store,
                    &self.parameters,
                    &mut self.outputs,
                ),
            }
        };
        let unused = self.store.get_fuel().map_err(|error| error.to_string())?;
        self.budget.set(self.budget.get() + unused);
        self.store.set_fuel(0).map_err(|error| error.to_string())?;
        match call {
            Ok(ResumableCall::Finished) => {
                if self.handlers.is_empty() {
                    if let Some((function, outputs)) = self.entry.take() {
                        self.function = function;
                        self.outputs = outputs;
                        self.parameters.clear();
                    } else {
                        self.done = Some(0);
                    }
                } else {
                    self.finish_handler()?;
                }
            }
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
            Ok(ResumableCall::OutOfFuel(invocation)) => {
                let available = self.budget.get();
                if available < invocation.required_fuel() {
                    return Err("Wasm fuel exhausted".into());
                }
                self.exhaustion = Some(invocation);
            }
            Err(error) => {
                if let Some(code) = error.i32_exit_status() {
                    self.done = Some(code);
                    self.outputs.clear();
                } else if self.store.data().pid != 1
                    && matches!(
                        error.as_trap_code(),
                        Some(
                            TrapCode::UnreachableCodeReached
                                | TrapCode::MemoryOutOfBounds
                                | TrapCode::TableOutOfBounds
                                | TrapCode::IndirectCallToNull
                                | TrapCode::IntegerDivisionByZero
                                | TrapCode::IntegerOverflow
                                | TrapCode::BadConversionToInteger
                                | TrapCode::StackOverflow
                                | TrapCode::BadSignature
                        )
                    )
                {
                    self.done = Some(1);
                    self.outputs.clear();
                } else {
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }
}

thread_local! {
    static PARKED_GUESTS: RefCell<BTreeMap<u32,WasmGuest>> = const {RefCell::new(BTreeMap::new())};
    static NEXT_PARKED_GUEST: Cell<u32> = const {Cell::new(1)};
}

impl Drop for WasmGuest {
    fn drop(&mut self) {
        self.store.data().processes.borrow_mut().memory_bytes -= self.memory_limit;
    }
}

#[wasm_bindgen]
impl WasmGuest {
    pub fn park(self) -> Result<u32, JsValue> {
        PARKED_GUESTS.with(|guests| {
            let mut guests = guests.borrow_mut();
            if guests.len() >= 9 {
                return Err(JsValue::from_str("Checkpoint guest limit exceeded"));
            }
            let id = NEXT_PARKED_GUEST.with(|next| {
                let id = next.get();
                next.set(id.saturating_add(1));
                id
            });
            if guests.contains_key(&id) {
                return Err(JsValue::from_str("Checkpoint handle exhausted"));
            }
            guests.insert(id, self);
            Ok(id)
        })
    }
    pub fn resume(handle: u32) -> Result<WasmGuest, JsValue> {
        PARKED_GUESTS.with(|guests| {
            guests
                .borrow_mut()
                .remove(&handle)
                .ok_or_else(|| JsValue::from_str("Checkpoint handle does not exist"))
        })
    }

    #[wasm_bindgen(constructor)]
    pub fn new(
        bytes: &[u8],
        configuration: &str,
        stdin: &[u8],
        memory: usize,
        fuel: u64,
        max_output: usize,
    ) -> Result<WasmGuest, JsValue> {
        Self::create(
            bytes,
            configuration,
            GuestInitialization::Fresh(stdin),
            memory,
            fuel,
            max_output,
            None,
        )
        .map_err(|error| JsValue::from_str(&error))
    }

    #[wasm_bindgen(getter)]
    pub fn pid(&self) -> u32 {
        self.store.data().pid
    }

    pub fn set_poll_deadline(&mut self, index: usize, deadline: &str) -> Result<(), JsValue> {
        deadline
            .parse::<u128>()
            .map_err(|_| JsValue::from_str("Invalid poll deadline"))?;
        let pending = self
            .store
            .data_mut()
            .pending
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No pending poll"))?;
        let Request::Poll { clocks, .. } = &mut pending.request else {
            return Err(JsValue::from_str("No pending poll"));
        };
        let clock = clocks
            .iter_mut()
            .find(|clock| clock.index == index)
            .ok_or_else(|| JsValue::from_str("Missing poll clock"))?;
        clock.timeout = deadline.into();
        clock.absolute = true;
        Ok(())
    }

    pub fn take_readiness_notification(&mut self) -> bool {
        let state = self.store.data_mut();
        let notify = state.readiness_notification;
        state.readiness_notification = false;
        notify
    }

    pub fn is_stopped(&self) -> bool {
        self.store.data().stopped.get() && self.store.data().pending_signals.get() & (1 << 8) == 0
    }
    pub fn wait_ready(&self) -> bool {
        let state = self.store.data();
        let table = state.processes.borrow();
        match state.pending.as_ref().map(|pending| &pending.completion) {
            Some(Completion::Wait { pids, .. }) => {
                pids.iter().all(|pid| !table.children.contains_key(pid))
                    || pids.iter().any(|pid| {
                        table
                            .children
                            .get(pid)
                            .is_some_and(|child| child.code.is_some() || child.failed)
                    })
            }
            Some(Completion::WaitRaw { pids, options, .. }) => {
                pids.iter().all(|pid| !table.children.contains_key(pid))
                    || pids.iter().any(|pid| {
                        table.children.get(pid).is_some_and(|child| {
                            child.code.is_some()
                                || child.failed
                                || child.transitions.borrow().iter().any(|status| {
                                    (*status == 0xffff && options & 8 != 0)
                                        || (*status & 0xff == 0x7f && options & 2 != 0)
                                })
                        })
                    })
            }
            _ => false,
        }
    }
    pub fn signal_ready(&self) -> bool {
        let state = self.store.data();
        if state.stopped.get() {
            return state.pending_signals.get() & (1 << 8) != 0;
        }
        self.done.is_none() && state.pending_signals.get() & !state.signal_mask != 0
    }

    pub fn io_ready(&self) -> bool {
        if self.signal_ready() {
            return true;
        }
        let state = self.store.data();
        let Some(pending) = &state.pending else {
            return false;
        };
        match &pending.completion {
            Completion::PipeRead { fd, .. } => state
                .descriptors
                .get(fd)
                .and_then(|descriptor| descriptor.pipe.as_ref())
                .is_some_and(|pipe| !pipe.pipe.bytes.borrow().is_empty() || !pipe.has_peer()),
            Completion::PipeWrite { fd, data, .. } => state
                .descriptors
                .get(fd)
                .and_then(|descriptor| descriptor.pipe.as_ref())
                .is_some_and(|pipe| {
                    let space = PIPE_BYTES - pipe.pipe.bytes.borrow().len();
                    !pipe.has_peer()
                        || space > 0 && (data.len() > PIPE_ATOMIC_BYTES || space >= data.len())
                }),
            Completion::Poll {
                events, pipe_fds, ..
            } => pipe_fds.iter().any(|(index, fd)| {
                let mut event = events[*index];
                pipe_event(state, *fd, &mut event)
            }),
            _ => false,
        }
    }

    pub fn finish_child(&self, failed: bool) {
        let table = self.store.data().processes.clone();
        let mut table = table.borrow_mut();
        if let Some(child) = table.children.get_mut(&self.store.data().pid) {
            child.code = self.done;
            child.signal = self.store.data().delivered_signal;
            if child.signal != 0 {
                child.code = Some(0);
            }
            child.failed = failed || self.done.is_none();
        }
        let auto_reap = notify_signal_parent(&table, self.store.data().pid, false);
        if auto_reap && !failed {
            table.children.remove(&self.store.data().pid);
        }
    }

    pub fn spawn_action(&mut self, index: usize) -> Result<String, JsValue> {
        let pending = self
            .store
            .data_mut()
            .pending
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No pending spawn"))?;
        let Completion::Spawn {
            actions, resources, ..
        } = &mut pending.completion
        else {
            return Err(JsValue::from_str("No pending spawn"));
        };
        let action = actions
            .get(index)
            .ok_or_else(|| JsValue::from_str("Invalid spawn action"))?;
        let mut errno = 0;
        let mut path = None;
        match action.command {
            1 => {
                if resources.descriptors.contains_key(&action.fd) {
                    resources.close(action.fd);
                } else {
                    errno = 8;
                }
            }
            2 => {
                if let Some(source) = resources.descriptors.get(&action.source).cloned() {
                    if action.fd != action.source {
                        if !resources.descriptors.contains_key(&action.fd)
                            && resources.descriptors.len() >= MAX_FILES
                        {
                            errno = 33;
                        } else {
                            resources.close(action.fd);
                            resources.descriptors.insert(action.fd, source);
                            resources.closed.remove(&action.fd);
                        }
                    }
                    if errno == 0 {
                        resources.cloexec.remove(&action.fd);
                    }
                } else {
                    errno = 8;
                }
            }
            6 => {
                let closing: Vec<u32> = resources
                    .descriptors
                    .keys()
                    .copied()
                    .filter(|fd| *fd >= action.fd && *fd != HIDDEN_PREOPEN)
                    .collect();
                for fd in closing {
                    resources.close(fd);
                }
                for fd in action.fd.min(3)..3 {
                    resources.close(fd);
                }
            }
            5 => match resources.descriptors.get(&action.fd) {
                Some(directory) if directory.directory && directory.linked => {
                    path = Some(directory.path.clone())
                }
                Some(directory) if !directory.directory => errno = 54,
                Some(_) => errno = 44,
                None => errno = 8,
            },
            _ => errno = 28,
        }
        serde_json::to_string(&serde_json::json!({"errno":errno,"path":path}))
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn spawn_open(
        &mut self,
        index: usize,
        data: &[u8],
        path: &str,
        directory: bool,
        metadata: &[u8],
    ) -> Result<String, JsValue> {
        let table = self.store.data().processes.clone();
        let pending = self
            .store
            .data_mut()
            .pending
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No pending spawn"))?;
        let Completion::Spawn {
            actions, resources, ..
        } = &mut pending.completion
        else {
            return Err(JsValue::from_str("No pending spawn"));
        };
        let action = actions
            .get(index)
            .ok_or_else(|| JsValue::from_str("Invalid spawn action"))?;
        if action.command != 3 {
            return Err(JsValue::from_str("Invalid spawn open"));
        }
        let metadata: [u8; 76] = metadata
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid spawn metadata"))?;
        let mut errno = 0;
        let mut descriptor = Descriptor {
            path: path.into(),
            directory,
            read: action.flags & 3 != 1,
            write: action.flags & 3 != 0,
            flags: Rc::new(Cell::new(0)),
            offset: Rc::new(Cell::new(0)),
            stdio: None,
            pipe: None,
            rights: 4 | 8 | 32 | (1 << 21) | (1 << 27),
            inheriting: 0,
            cache: None,
            linked: true,
            metadata,
        };
        if descriptor.read {
            descriptor.rights |= 2;
        }
        if descriptor.write {
            descriptor.rights |= 1 | 16 | 64 | (1 << 8) | (1 << 22) | (1 << 23);
        }
        if directory {
            descriptor.rights = (1 << 30) - 1;
            descriptor.inheriting = (1 << 30) - 1;
        }
        if action.flags & 0x400 != 0 {
            descriptor.flags.set(descriptor.flags.get() | 1);
        }
        if action.flags & 0x800 != 0 {
            descriptor.flags.set(descriptor.flags.get() | 4);
        }
        if !resources.descriptors.contains_key(&action.fd)
            && resources.descriptors.len() >= MAX_FILES
        {
            errno = 33;
        } else {
            let mut retained = None;
            if !directory {
                let shared = table
                    .borrow()
                    .buffers
                    .iter()
                    .filter_map(Weak::upgrade)
                    .find(|file| file.borrow().metadata[8..16] == metadata[8..16]);
                let used: usize = table
                    .borrow()
                    .buffers
                    .iter()
                    .filter_map(Weak::upgrade)
                    .map(|file| file.borrow().bytes.len())
                    .sum();
                if shared.is_none() && used.saturating_add(data.len()) > 16_777_216 {
                    return serde_json::to_string(&serde_json::json!({"errno":48,"path":null}))
                        .map_err(|error| JsValue::from_str(&error.to_string()));
                }
                let buffer = if let Some(buffer) = shared {
                    {
                        let mut file = buffer.borrow_mut();
                        if action.flags & 0x200 != 0 {
                            file.bytes = data.to_vec();
                        }
                        file.metadata = metadata;
                    }
                    buffer
                } else {
                    let buffer = Rc::new(RefCell::new(FileBuffer {
                        path: Some(path.into()),
                        bytes: data.to_vec(),
                        metadata,
                    }));
                    table
                        .borrow_mut()
                        .buffers
                        .retain(|file| file.strong_count() > 0);
                    table.borrow_mut().buffers.push(Rc::downgrade(&buffer));
                    buffer
                };
                let existing = resources
                    .files
                    .iter()
                    .find(|(_, file)| Rc::ptr_eq(file, &buffer))
                    .map(|(cache, _)| *cache);
                let cache = existing.or_else(|| {
                    (0..MAX_FILES as u32).find(|cache| !resources.files.contains_key(cache))
                });
                if let Some(cache) = cache {
                    retained = Some((cache, buffer));
                    descriptor.cache = Some(cache);
                } else {
                    errno = 33;
                }
            }
            if errno == 0 {
                resources.close(action.fd);
                if let Some((cache, buffer)) = retained {
                    resources.files.insert(cache, buffer);
                }
                resources.descriptors.insert(action.fd, descriptor);
                resources.closed.remove(&action.fd);
                if action.flags & 0x80000 != 0 {
                    resources.cloexec.insert(action.fd);
                }
            }
        }
        serde_json::to_string(&serde_json::json!({"errno":errno,"path":null}))
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn replace_image(&mut self, bytes: &[u8], configuration: &str) -> Result<(), JsValue> {
        let closed = match self
            .store
            .data()
            .pending
            .as_ref()
            .map(|pending| &pending.completion)
        {
            Some(Completion::Exec { closed }) => closed.clone(),
            _ => return Err(JsValue::from_str("No pending exec")),
        };
        if self
            .store
            .data()
            .processes
            .borrow()
            .memory_bytes
            .saturating_add(self.memory_limit)
            > 67_108_864
        {
            return self.respond(48, &[], "/", false, 0, &[]);
        }
        let replacement = Self::create(
            bytes,
            configuration,
            GuestInitialization::Replacement {
                state: self.store.data(),
                closed: &closed,
            },
            self.memory_limit,
            self.budget.get(),
            self.store.data().max_output,
            Some(self.budget.clone()),
        );
        let mut replacement = match replacement {
            Ok(replacement) => replacement,
            Err(_) => return self.respond(45, &[], "/", false, 0, &[]),
        };
        replacement.fuel_limit = self.fuel_limit;
        let state = replacement.store.data();
        if state.pid == 1 {
            state.processes.borrow_mut().root_dispositions = state.dispositions.clone();
        } else if let Some(child) = state.processes.borrow_mut().children.get_mut(&state.pid) {
            child.dispositions = state.dispositions.clone();
        }
        *self = replacement;
        Ok(())
    }

    pub fn spawn_child(
        &mut self,
        bytes: &[u8],
        configuration: &str,
        cwd: &str,
    ) -> Result<Option<WasmGuest>, JsValue> {
        let (resources, mask, requested_group, new_session, signal_defaults) = match self
            .store
            .data()
            .pending
            .as_ref()
            .map(|pending| &pending.completion)
        {
            Some(Completion::Spawn {
                resources,
                mask,
                group,
                new_session,
                signal_defaults,
                ..
            }) => (
                resources.clone(),
                *mask,
                *group,
                *new_session,
                *signal_defaults,
            ),
            _ => return Err(JsValue::from_str("No pending spawn")),
        };
        let table = self.store.data().processes.clone();
        if table.borrow().children.len() >= 8
            || table.borrow().memory_bytes + self.memory_limit > 67_108_864
        {
            self.respond(48, &[], "/", false, 0, &[])?;
            return Ok(None);
        }
        let pid = table.borrow().next_pid;
        let (inherited_group, inherited_session) = if self.store.data().pid == 1 {
            let table = table.borrow();
            (table.root_group, table.root_session)
        } else {
            let table = table.borrow();
            let parent = table
                .children
                .get(&self.store.data().pid)
                .ok_or_else(|| JsValue::from_str("Missing parent process"))?;
            (parent.group, parent.session)
        };
        let session = if new_session { pid } else { inherited_session };
        let group = if new_session {
            pid
        } else {
            match requested_group {
                Some(0) => pid,
                Some(group) => group,
                None => inherited_group,
            }
        };
        if requested_group.is_some()
            && group != pid
            && !((group == table.borrow().root_group && session == table.borrow().root_session)
                || table.borrow().children.values().any(|child| {
                    child.group == group
                        && child.session == session
                        && child.code.is_none()
                        && !child.failed
                }))
        {
            self.respond(63, &[], "/", false, 0, &[])?;
            return Ok(None);
        }
        let available = self.budget.get();
        let mut child = match Self::create(
            bytes,
            configuration,
            GuestInitialization::Fresh(&[]),
            self.memory_limit,
            available,
            self.store.data().max_output,
            Some(self.budget.clone()),
        ) {
            Ok(child) => child,
            Err(_) => {
                self.respond(45, &[], "/", false, 0, &[])?;
                return Ok(None);
            }
        };
        self.budget.set(child.budget.get());
        child.budget = self.budget.clone();
        child.fuel_limit = self.fuel_limit;
        let parent = self.store.data();
        let state = child.store.data_mut();
        state.descriptors = resources.descriptors;
        state.files = resources.files;
        state.closed = resources.closed;
        state.cloexec = resources.cloexec;
        state.stdout = parent.stdout.clone();
        state.stderr = parent.stderr.clone();
        state.stdin_pipe = parent.stdin_pipe.clone();
        state.stdin_writer = parent.stdin_writer.clone();
        state.stdin = parent.stdin.clone();
        state.stdin_offset = parent.stdin_offset.clone();
        state.stdio_flags = parent.stdio_flags.clone();
        state.requests = parent.requests.clone();
        *state.dispositions.borrow_mut() = parent
            .dispositions
            .borrow()
            .iter()
            .filter(|(signal, disposition)| {
                disposition.action == 1 && signal_defaults & (1u64 << (**signal - 1)) == 0
            })
            .map(|(signal, disposition)| (*signal, disposition.clone()))
            .collect();
        state.signal_mask = mask;
        for fd in state.cloexec.clone() {
            close(state, fd);
        }
        state.pid = pid;
        state.parent_pid = parent.pid;
        state.cwd = cwd.into();
        state.umask = parent.umask;
        state.processes = table.clone();
        table.borrow_mut().next_pid += 1;
        table.borrow_mut().memory_bytes += self.memory_limit;
        table.borrow_mut().children.insert(
            pid,
            ChildStatus {
                parent: parent.pid,
                group,
                session,
                pending_signals: state.pending_signals.clone(),
                dispositions: state.dispositions.clone(),
                stopped: state.stopped.clone(),
                transitions: state.transitions.clone(),
                signal: 0,
                code: None,
                failed: false,
            },
        );
        self.respond(0, &[], "/", false, u64::from(pid), &[])?;
        Ok(Some(child))
    }

    pub fn step(&mut self) -> Result<String, JsValue> {
        self.observe_signal(true)
            .map_err(|error| JsValue::from_str(&error))?;
        if self.store.data().stopped.get() {
            return serde_json::to_string(&Request::Stopped)
                .map_err(|error| JsValue::from_str(&error.to_string()));
        }
        if self
            .store
            .data()
            .pending
            .as_ref()
            .is_some_and(|pending| matches!(pending.request, Request::Stopped | Request::Handler))
        {
            self.respond(0, &[], "/", false, 0, &[])?;
        }
        if self.store.data().pending.is_none() && self.done.is_none() {
            self.advance().map_err(|error| JsValue::from_str(&error))?;
        }
        if self
            .store
            .data()
            .pending
            .as_ref()
            .is_some_and(|pending| matches!(pending.request, Request::Handler))
        {
            return self.step();
        }
        if self.done.is_none() && self.store.data().pending.is_none() && self.exhaustion.is_none() {
            return self.step();
        }
        if self.exhaustion.is_some() {
            let available = self.budget.get();
            return serde_json::to_string(
                &serde_json::json!({"kind":"yield","fuelUsed":self.fuel_limit - available}),
            )
            .map_err(|error| JsValue::from_str(&error.to_string()));
        }
        if let Some(pending) = &self.store.data().pending {
            return serde_json::to_string(&pending.request)
                .map_err(|error| JsValue::from_str(&error.to_string()));
        }
        let state = self.store.data();
        let result = self.outputs.first().and_then(Val::i32);
        let output = serde_json::json!({"stdout":String::from_utf8_lossy(&state.stdout.borrow()),"stderr":String::from_utf8_lossy(&state.stderr.borrow()),"exitCode":self.done,"result":result});
        serde_json::to_string(&serde_json::json!({"kind":"done","output":output}))
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn output_bytes(&self) -> usize {
        let state = self.store.data();
        state.stdout.borrow().len() + state.stderr.borrow().len()
    }

    pub fn stdout_bytes(&self) -> Vec<u8> {
        self.store.data().stdout.borrow().clone()
    }

    pub fn stderr_bytes(&self) -> Vec<u8> {
        self.store.data().stderr.borrow().clone()
    }

    pub fn refresh_file(&mut self, metadata: &[u8], path: Option<String>) -> Result<(), JsValue> {
        let metadata: [u8; 76] = metadata
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid inode metadata"))?;
        let linked = metadata[24..32] != [0; 8];
        if path.is_some() != linked {
            return Err(JsValue::from_str("Invalid inode path lifetime"));
        }
        for file in self
            .store
            .data()
            .processes
            .borrow()
            .buffers
            .iter()
            .filter_map(Weak::upgrade)
        {
            let mut file = file.borrow_mut();
            if file.metadata[8..16] == metadata[8..16] {
                file.path = path.clone();
                file.metadata = metadata;
            }
        }
        Ok(())
    }

    pub fn has_file(&self, inode: u64) -> bool {
        self.store
            .data()
            .processes
            .borrow()
            .buffers
            .iter()
            .filter_map(Weak::upgrade)
            .any(|file| file.borrow().metadata[8..16] == inode.to_le_bytes())
    }
    pub fn buffered_bytes(&self) -> usize {
        buffered_bytes(self.store.data())
    }

    pub fn enable_stdin(&mut self) -> Result<(), JsValue> {
        let state = self.store.data_mut();
        if state.stdin_pipe.is_some() {
            return Err(JsValue::from_str("Stdin pipe is already initialized"));
        }
        let pipe = Rc::new(Pipe {
            bytes: RefCell::new(VecDeque::new()),
            readers: Cell::new(1),
            writers: Cell::new(1),
        });
        let mut descriptor = duplicate_source(state, 0)
            .map_err(|_| JsValue::from_str("Missing stdin descriptor"))?;
        descriptor.stdio = None;
        descriptor.rights |= 1 << 21;
        descriptor.metadata[64..68].copy_from_slice(&0o10600u32.to_le_bytes());
        descriptor.pipe = Some(Rc::new(PipeEndpoint {
            pipe: pipe.clone(),
            reading: true,
        }));
        state.descriptors.insert(0, descriptor);
        *state.stdin_writer.borrow_mut() = Some(Rc::new(PipeEndpoint {
            pipe: pipe.clone(),
            reading: false,
        }));
        state
            .processes
            .borrow_mut()
            .pipes
            .push(Rc::downgrade(&pipe));
        state.stdin_pipe = Some(pipe);
        Ok(())
    }
    pub fn fuel_used(&self) -> u64 {
        self.fuel_limit - self.budget.get()
    }
    pub fn input_offset(&self) -> usize {
        self.store.data().stdin_offset.get()
    }
    pub fn stdin_capacity(&self) -> usize {
        self.store
            .data()
            .stdin_pipe
            .as_ref()
            .map(|pipe| PIPE_BYTES - pipe.bytes.borrow().len())
            .unwrap_or(0)
    }
    pub fn stdin_has_reader(&self) -> bool {
        self.store
            .data()
            .stdin_pipe
            .as_ref()
            .is_some_and(|pipe| pipe.readers.get() > 0)
    }
    pub fn feed_stdin(&mut self, data: &[u8], closed: bool) -> Result<(), JsValue> {
        let state = self.store.data_mut();
        let pipe = state
            .stdin_pipe
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Missing stdin pipe"))?;
        if data.len() > PIPE_BYTES - pipe.bytes.borrow().len()
            || state.stdin_writer.borrow().is_none()
        {
            return Err(JsValue::from_str("Stdin pipe cannot accept data"));
        }
        pipe.bytes.borrow_mut().extend(data.iter().copied());
        state
            .stdin_offset
            .set(state.stdin_offset.get() + data.len());
        if closed {
            state.stdin_writer.borrow_mut().take();
        }
        state.readiness_notification = true;
        Ok(())
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
                .map(|file| file.borrow().metadata.to_vec())
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
            .map(|file| file.borrow().bytes.clone())
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
        if self
            .observe_signal(false)
            .map_err(|error| JsValue::from_str(&error))?
            || self.store.data().stopped.get()
        {
            return Ok(());
        }
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
            let mut buffer = file.borrow_mut();
            let file = &mut buffer.bytes;
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
                Completion::PipeRead {
                    fd,
                    vectors,
                    output,
                } => {
                    let pipe = self
                        .store
                        .data()
                        .descriptors
                        .get(&fd)
                        .and_then(|descriptor| descriptor.pipe.clone())
                        .ok_or_else(|| JsValue::from_str("Missing pipe"))?;
                    let mut count = 0usize;
                    let memory = self
                        .memory
                        .ok_or_else(|| JsValue::from_str("Missing memory"))?;
                    for (pointer, length) in vectors {
                        let available = pipe.pipe.bytes.borrow().len();
                        let bytes: Vec<u8> = pipe
                            .pipe
                            .bytes
                            .borrow_mut()
                            .drain(..length.min(available))
                            .collect();
                        memory
                            .write(&mut self.store, pointer, &bytes)
                            .map_err(|error| JsValue::from_str(&error.to_string()))?;
                        count += bytes.len();
                        if bytes.len() < length {
                            break;
                        }
                    }
                    memory
                        .write(&mut self.store, output, &(count as u32).to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::PipeWrite { fd, data, output } => {
                    let pipe = self
                        .store
                        .data()
                        .descriptors
                        .get(&fd)
                        .and_then(|descriptor| descriptor.pipe.clone())
                        .ok_or_else(|| JsValue::from_str("Missing pipe"))?;
                    if !pipe.has_peer() {
                        result = 64;
                    } else {
                        let count = data.len().min(PIPE_BYTES - pipe.pipe.bytes.borrow().len());
                        pipe.pipe.bytes.borrow_mut().extend(&data[..count]);
                        self.memory
                            .ok_or_else(|| JsValue::from_str("Missing memory"))?
                            .write(&mut self.store, output, &(count as u32).to_le_bytes())
                            .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    }
                }
                Completion::Spawn { pointer, .. } => {
                    self.memory
                        .ok_or_else(|| JsValue::from_str("Missing memory"))?
                        .write(&mut self.store, pointer, &(value as u32).to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                }
                Completion::WaitRaw {
                    pids,
                    options,
                    status,
                    pid,
                } => {
                    let ready = take_wait_status(
                        &mut self.store.data().processes.borrow_mut(),
                        &pids,
                        options,
                    );
                    if let Some((found, raw, failed)) = ready {
                        if failed {
                            result = 29;
                        } else {
                            let memory = self
                                .memory
                                .ok_or_else(|| JsValue::from_str("Missing memory"))?;
                            memory
                                .write(&mut self.store, status, &raw.to_le_bytes())
                                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                            memory
                                .write(&mut self.store, pid, &found.to_le_bytes())
                                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                        }
                    } else {
                        result = 12;
                    }
                }
                Completion::Wait { pids, pointers } => {
                    let ready = self
                        .store
                        .data()
                        .processes
                        .borrow()
                        .children
                        .iter()
                        .find(|(pid, child)| {
                            pids.contains(pid) && (child.code.is_some() || child.failed)
                        })
                        .map(|(pid, child)| (*pid, child.code, child.failed, child.signal));
                    if let Some((pid, code, failed, signal)) = ready {
                        self.store
                            .data()
                            .processes
                            .borrow_mut()
                            .children
                            .remove(&pid);
                        if failed {
                            result = 29;
                        } else {
                            for (pointer, value) in pointers.into_iter().zip([
                                code.ok_or_else(|| JsValue::from_str("Missing child exit"))? as u32,
                                signal,
                                pid,
                                0,
                            ]) {
                                self.memory
                                    .ok_or_else(|| JsValue::from_str("Missing memory"))?
                                    .write(&mut self.store, pointer, &value.to_le_bytes())
                                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                            }
                        }
                    } else {
                        result = 12;
                    }
                }
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
                    let buffer = Rc::new(RefCell::new(FileBuffer {
                        path: None,
                        bytes: Vec::new(),
                        metadata: descriptor.metadata,
                    }));
                    state
                        .processes
                        .borrow_mut()
                        .buffers
                        .retain(|file| file.strong_count() > 0);
                    state
                        .processes
                        .borrow_mut()
                        .buffers
                        .push(Rc::downgrade(&buffer));
                    state.files.insert(cache, buffer);
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
                        .processes
                        .borrow()
                        .buffers
                        .iter()
                        .filter_map(Weak::upgrade)
                        .filter(|file| file.borrow().metadata[8..16] != metadata[8..16])
                        .map(|file| file.borrow().bytes.len())
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
                                .find(|(_, file)| file.borrow().metadata[8..16] == metadata[8..16])
                                .map(|(cache, _)| *cache)
                                .or_else(|| {
                                    (0..MAX_FILES as u32)
                                        .find(|cache| !state.files.contains_key(cache))
                                })
                                .ok_or_else(|| JsValue::from_str("File cache quota exceeded"))?;
                            let shared = state
                                .processes
                                .borrow()
                                .buffers
                                .iter()
                                .filter_map(Weak::upgrade)
                                .find(|file| file.borrow().metadata[8..16] == metadata[8..16]);
                            let buffer = if let Some(buffer) = shared {
                                {
                                    let mut file = buffer.borrow_mut();
                                    if truncate {
                                        file.bytes = data.to_vec();
                                    }
                                    file.metadata = descriptor.metadata;
                                }
                                buffer
                            } else {
                                let buffer = Rc::new(RefCell::new(FileBuffer {
                                    path: Some(path.into()),
                                    bytes: data.to_vec(),
                                    metadata: descriptor.metadata,
                                }));
                                state
                                    .processes
                                    .borrow_mut()
                                    .buffers
                                    .retain(|file| file.strong_count() > 0);
                                state
                                    .processes
                                    .borrow_mut()
                                    .buffers
                                    .push(Rc::downgrade(&buffer));
                                buffer
                            };
                            state.files.insert(cache, buffer);
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
                        .borrow_mut()
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
                                .borrow_mut()
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
                                .borrow_mut()
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
                                    .borrow_mut()
                                    .metadata = metadata;
                            }
                        }
                    }
                }
                Completion::Poll {
                    mut events,
                    clocks,
                    mut blocked,
                    pipe_fds,
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
                    for (index, fd) in pipe_fds {
                        if pipe_event(self.store.data(), fd, &mut events[index]) {
                            blocked.remove(&index);
                        } else {
                            blocked.insert(index);
                        }
                    }
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
                Completion::Unit | Completion::Exec { .. } => {}
                Completion::Remove => detach(self.store.data_mut(), path),
                Completion::Rename => {
                    let to = std::str::from_utf8(data)
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
                    if path != to && value == 0 {
                        let state = self.store.data_mut();
                        detach(state, to);
                        for file in state
                            .processes
                            .borrow()
                            .buffers
                            .iter()
                            .filter_map(Weak::upgrade)
                        {
                            let mut file = file.borrow_mut();
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
                GuestInitialization::Fresh(&[]),
                8_388_608,
                1000,
                1024,
                None
            )
            .is_err()
        );
    }
    #[test]
    fn guest_traps_are_local_to_children_but_root_traps_remain_failures() {
        let module = [
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 114, 117,
            110, 0, 0, 10, 5, 1, 3, 0, 0, 11,
        ];
        let configuration = r#"{"argv":[],"env":{}}"#;
        let mut root = WasmGuest::create(
            &module,
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            100_000,
            1024,
            None,
        )
        .unwrap();
        assert_eq!(
            root.advance().unwrap_err(),
            "wasm `unreachable` instruction executed"
        );
        assert_eq!(root.done, None);
        let mut child = WasmGuest::create(
            &module,
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            100_000,
            1024,
            None,
        )
        .unwrap();
        child.store.data_mut().pid = 2;
        child.advance().unwrap();
        assert_eq!(child.done, Some(1));
        assert!(child.outputs.is_empty());
    }
    #[test]
    fn inherited_pipe_endpoints_survive_other_stores_and_release_on_guest_drop() {
        let module = include_bytes!("../../../dist/wasi-pipe-blocked.wasm");
        let configuration = r#"{"argv":[],"env":{}}"#;
        let mut parent = WasmGuest::create(
            module,
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            100_000,
            1024,
            None,
        )
        .unwrap();
        let mut child = WasmGuest::create(
            module,
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            100_000,
            1024,
            None,
        )
        .unwrap();
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
        let mut receiver = WasmGuest::create(
            module,
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            100_000,
            1024,
            None,
        )
        .unwrap();
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
    fn inherited_file_buffers_survive_close_and_share_guest_writes_and_rollback() {
        let configuration = r#"{"argv":[],"env":{}}"#;
        for errno in [0, 2] {
            let mut parent = WasmGuest::create(
                include_bytes!("../../../dist/wasi-shared-file-parent.wasm"),
                configuration,
                GuestInitialization::Fresh(&[]),
                8_388_608,
                100_000,
                1024,
                None,
            )
            .unwrap();
            let mut child = WasmGuest::create(
                include_bytes!("../../../dist/wasi-shared-file-child.wasm"),
                configuration,
                GuestInitialization::Fresh(&[]),
                8_388_608,
                100_000,
                1024,
                None,
            )
            .unwrap();
            parent.advance().unwrap();
            assert!(matches!(
                parent.store.data().pending.as_ref().unwrap().request,
                Request::Open { .. }
            ));
            let mut metadata = [0u8; 76];
            metadata[32..40].copy_from_slice(&3u64.to_le_bytes());
            parent
                .respond(0, b"abc", "/tmp/shared", false, 0, &metadata)
                .unwrap();
            parent.advance().unwrap();
            assert!(matches!(
                parent.store.data().pending.as_ref().unwrap().request,
                Request::Clock { .. }
            ));
            child.store.data_mut().files = parent.store.data().files.clone();
            child.store.data().processes.borrow_mut().buffers =
                parent.store.data().processes.borrow().buffers.clone();
            child
                .store
                .data_mut()
                .descriptors
                .insert(4, duplicate_source(parent.store.data(), 4).unwrap());
            let buffer = Rc::downgrade(parent.store.data().files.values().next().unwrap());
            close(parent.store.data_mut(), 4);
            assert!(parent.store.data().files.is_empty());
            assert_eq!(child.file_data(4).unwrap(), b"abc");
            child.advance().unwrap();
            assert!(matches!(
                child.store.data().pending.as_ref().unwrap().request,
                Request::Flush { .. }
            ));
            assert_eq!(child.file_data(4).unwrap(), b"abcX");
            metadata[32..40].copy_from_slice(&4u64.to_le_bytes());
            child
                .respond(errno, &[], "/tmp/shared", false, 0, &metadata)
                .unwrap();
            child.advance().unwrap();
            assert_eq!(child.done, Some(0));
            assert_eq!(child.outputs.first().and_then(Val::i32), Some(0));
            assert_eq!(child.buffered_bytes(), if errno == 0 { 4 } else { 3 });
            assert!(buffer.upgrade().is_some());
            drop(child);
            assert!(buffer.upgrade().is_none());
        }
    }

    #[test]
    fn fuel_slices_resume_without_restarting_or_extending_the_total_budget() {
        let configuration = r#"{"argv":[],"env":{}}"#;
        let mut guest = WasmGuest::create(
            include_bytes!("../../../dist/wasi-slices-finite.wasm"),
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            100_000_000,
            1024,
            None,
        )
        .unwrap();
        let mut slices = 0;
        let mut consumed = 0;
        while guest.done.is_none() {
            let step: serde_json::Value = serde_json::from_str(&guest.step().unwrap()).unwrap();
            if step["kind"] == "yield" {
                let reported = step["fuelUsed"].as_u64().unwrap();
                assert!(reported > consumed && reported <= 100_000_000);
                consumed = reported;
            }
            slices += 1;
            assert!(slices < 1000);
        }
        assert!(slices > 1);
        assert_eq!(guest.outputs.first().and_then(Val::i32), Some(352));
        assert_eq!(*guest.store.data().stdout.borrow(), b"cpu loop started\n");
        let mut guest = WasmGuest::create(
            include_bytes!("../../../dist/wasi-slices-infinite.wasm"),
            configuration,
            GuestInitialization::Fresh(&[]),
            8_388_608,
            500_000,
            1024,
            None,
        )
        .unwrap();
        guest.store.data_mut().pid = 2;
        let mut slices = 0;
        loop {
            match guest.advance() {
                Ok(()) => {
                    slices += 1;
                    assert!(slices < 10);
                }
                Err(error) => {
                    assert_eq!(error, "Wasm fuel exhausted");
                    break;
                }
            }
        }
        assert_eq!(slices, 0);
        assert_eq!(*guest.store.data().stdout.borrow(), b"cpu loop started\n");
        assert!(guest.budget.get() < FUEL_SLICE);
    }

    #[test]
    fn paths_cannot_escape_the_directory_descriptor() {
        assert!(confined("/tmp", "../escape").is_err());
        assert!(confined("/", "../../escape").is_err());
        assert!(matches!(confined("/tmp","a/../b"),Ok(path) if path == "/tmp/b"));
    }
}
