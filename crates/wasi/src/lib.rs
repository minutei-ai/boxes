use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;
use wasmi::{
    Caller, Config, Engine, Error, Func, Linker, Memory, Module, ResumableCall,
    ResumableCallHostTrap, Store, StoreLimits, StoreLimitsBuilder, Val,
};

const MAX_FILES: usize = 128;
const MAX_BYTES: usize = 16_777_216;

#[derive(Clone)]
struct Descriptor {
    path: String,
    directory: bool,
    read: bool,
    write: bool,
    append: bool,
    offset: usize,
    rights: u64,
    inheriting: u64,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
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
    },
    Flush {
        path: String,
        fd: u32,
    },
    Sync,
    Random {
        length: usize,
    },
    Clock {
        clock: u32,
    },
}

enum Completion {
    Open {
        descriptor: Descriptor,
        pointer: usize,
        truncate: bool,
    },
    Flush {
        fd: u32,
        pointer: usize,
        length: usize,
        previous: Vec<u8>,
        previous_length: usize,
        start: usize,
        previous_offset: usize,
        offset: usize,
        positioned: bool,
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

struct Pending {
    request: Request,
    completion: Completion,
}

struct State {
    limits: StoreLimits,
    descriptors: BTreeMap<u32, Descriptor>,
    files: BTreeMap<String, Vec<u8>>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    max_output: usize,
    pending: Option<Pending>,
    requests: usize,
    closed: BTreeSet<u32>,
}

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

fn close(state: &mut State, fd: u32) {
    if let Some(descriptor) = state.descriptors.remove(&fd)
        && !state
            .descriptors
            .values()
            .any(|other| other.path == descriptor.path)
    {
        state.files.remove(&descriptor.path);
    }
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
        "args_sizes_get" | "environ_sizes_get" => {
            put(caller, a[0], &0u32.to_le_bytes())?;
            put(caller, a[1], &0u32.to_le_bytes())?;
        }
        "args_get" | "environ_get" | "sched_yield" => {}
        "fd_prestat_get" => {
            if a[0] != 3 {
                return Err(Failure::Errno(8));
            }
            put(caller, a[1], &[0, 0, 0, 0, 1, 0, 0, 0])?;
        }
        "fd_prestat_dir_name" => {
            if a[0] != 3 {
                return Err(Failure::Errno(8));
            }
            if a[2] < 1 {
                return Err(Failure::Errno(37));
            }
            put(caller, a[1], b"/")?;
        }
        "fd_fdstat_get" => {
            let mut stat = [0u8; 24];
            if a[0] < 3 {
                stat[0] = 2;
                let rights: u64 = if a[0] == 0 { 2 } else { 64 };
                stat[8..16].copy_from_slice(&rights.to_le_bytes());
            } else {
                let descriptor = caller
                    .data()
                    .descriptors
                    .get(&(a[0] as u32))
                    .ok_or(Failure::Errno(8))?;
                stat[0] = if descriptor.directory { 3 } else { 4 };
                stat[2] = u8::from(descriptor.append);
                stat[8..16].copy_from_slice(&descriptor.rights.to_le_bytes());
                stat[16..24].copy_from_slice(&descriptor.inheriting.to_le_bytes());
            }
            put(caller, a[1], &stat)?;
        }
        "fd_read" | "fd_pread" => {
            let output = *a.last().ok_or(Failure::Errno(28))?;
            bytes(caller, output, 4)?;
            let vectors = vectors(caller, a[1], a[2])?;
            if a[0] == 0 {
                put(caller, output, &0u32.to_le_bytes())?;
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
            let mut offset = if name == "fd_pread" {
                usize::try_from(args[3]).map_err(|_| Failure::Errno(28))?
            } else {
                descriptor.offset
            };
            let mut read = 0usize;
            for (pointer, length) in vectors {
                let data = caller
                    .data()
                    .files
                    .get(&descriptor.path)
                    .ok_or(Failure::Errno(8))?;
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
                    .offset = offset;
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
            if a[0] == 1 || a[0] == 2 {
                if name == "fd_pwrite" {
                    return Err(Failure::Errno(70));
                }
                let state = caller.data_mut();
                if state.stdout.len() + state.stderr.len() + data.len() > state.max_output {
                    return Err(Failure::Errno(22));
                }
                if a[0] == 1 {
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
                let file = state.files.get(&descriptor.path).ok_or(Failure::Errno(8))?;
                let offset = if name == "fd_pwrite" {
                    usize::try_from(args[3]).map_err(|_| Failure::Errno(28))?
                } else if descriptor.append {
                    file.len()
                } else {
                    descriptor.offset
                };
                let end = offset.checked_add(data.len()).ok_or(Failure::Errno(22))?;
                let total: usize = state.files.values().map(Vec::len).sum();
                if end > MAX_BYTES {
                    return Err(Failure::Errno(22));
                }
                if total - file.len() + file.len().max(end) > MAX_BYTES {
                    return Err(Failure::Errno(48));
                }
                let file = state
                    .files
                    .get_mut(&descriptor.path)
                    .ok_or(Failure::Errno(8))?;
                let previous_length = file.len();
                let previous = file[offset.min(file.len())..end.min(file.len())].to_vec();
                if end > file.len() {
                    file.resize(end, 0);
                }
                file[offset..end].copy_from_slice(&data);
                let path = descriptor.path.clone();
                suspend(
                    caller,
                    Request::Flush {
                        path,
                        fd: a[0] as u32,
                    },
                    Completion::Flush {
                        fd: a[0] as u32,
                        pointer: output,
                        length: data.len(),
                        previous,
                        previous_length,
                        start: offset,
                        previous_offset: descriptor.offset,
                        offset: end,
                        positioned: name == "fd_pwrite",
                    },
                )?;
            }
            put(caller, output, &(data.len() as u32).to_le_bytes())?;
        }
        "path_open" => {
            bytes(caller, a[8], 4)?;
            if a[1] & !1 != 0 || a[4] & !15 != 0 || a[7] & !1 != 0 {
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
                append: a[7] & 1 != 0,
                offset: 0,
                rights: args[5],
                inheriting: args[6],
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
                },
                Completion::Open {
                    descriptor,
                    pointer: a[8],
                    truncate: a[4] & 8 != 0,
                },
            )?;
        }
        "fd_close" => {
            if a[0] < 3 {
                caller.data_mut().closed.insert(a[0] as u32);
                return Ok(0);
            }
            if !caller.data().descriptors.contains_key(&(a[0] as u32)) {
                return Err(Failure::Errno(8));
            }
            close(caller.data_mut(), a[0] as u32);
        }
        "fd_sync" | "fd_datasync" => {
            if a[0] < 3 {
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
            if a[0] < 3 {
                return Err(Failure::Errno(70));
            }
            let state = caller.data_mut();
            let descriptor = state
                .descriptors
                .get(&(a[0] as u32))
                .cloned()
                .ok_or(Failure::Errno(8))?;
            if descriptor.directory {
                return Err(Failure::Errno(31));
            }
            let required = if name == "fd_seek" { 4 } else { 32 };
            if descriptor.rights & required == 0 {
                return Err(Failure::Errno(76));
            }
            let offset = if name == "fd_tell" {
                descriptor.offset
            } else {
                let base = match a[2] {
                    0 => 0,
                    1 => descriptor.offset,
                    2 => state
                        .files
                        .get(&descriptor.path)
                        .ok_or(Failure::Errno(8))?
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
                .offset = offset;
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
        ($name:literal $(,$arg:ident:$type:ty)*) => {
            linker.func_wrap("wasi_snapshot_preview1",$name,|mut caller:Caller<'_,State>,$($arg:$type),*| -> Result<i32,Error> {
                match dispatch(&mut caller,$name,&[$($arg as u64),*]) {
                    Ok(value) => Ok(value),
                    Err(Failure::Errno(errno)) => Ok(errno),
                    Err(Failure::Suspend) => Err(Error::new("Cirro host request")),
                    Err(Failure::Budget) => Err(Error::new("WASI host request budget exceeded")),
                }
            }).map_err(|error|error.to_string())?;
        }
    }
    bind!("args_sizes_get",a:i32,b:i32);
    bind!("args_get",a:i32,b:i32);
    bind!("environ_sizes_get",a:i32,b:i32);
    bind!("environ_get",a:i32,b:i32);
    bind!("fd_prestat_get",a:i32,b:i32);
    bind!("fd_prestat_dir_name",a:i32,b:i32,c:i32);
    bind!("fd_fdstat_get",a:i32,b:i32);
    bind!("fd_fdstat_set_flags",a:i32,b:i32);
    bind!("fd_read",a:i32,b:i32,c:i32,d:i32);
    bind!("fd_write",a:i32,b:i32,c:i32,d:i32);
    bind!("fd_pread",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("fd_pwrite",a:i32,b:i32,c:i32,d:i64,e:i32);
    bind!("path_open",a:i32,b:i32,c:i32,d:i32,e:i32,f:i64,g:i64,h:i32,i:i32);
    bind!("fd_close",a:i32);
    bind!("fd_sync",a:i32);
    bind!("fd_datasync",a:i32);
    bind!("fd_seek",a:i32,b:i64,c:i32,d:i32);
    bind!("fd_tell",a:i32,b:i32);
    bind!("fd_filestat_get",a:i32,b:i32);
    bind!("path_filestat_get",a:i32,b:i32,c:i32,d:i32,e:i32);
    bind!("random_get",a:i32,b:i32);
    bind!("clock_time_get",a:i32,b:i64,c:i32);
    bind!("clock_res_get",a:i32,b:i32);
    bind!("sched_yield");
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
    response: Option<i32>,
    outputs: Vec<Val>,
    done: Option<i32>,
}

impl WasmGuest {
    fn create(bytes: &[u8], memory: usize, fuel: u64, max_output: usize) -> Result<Self, String> {
        if bytes.len() > 1_048_576
            || !(4_194_304..=33_554_432).contains(&memory)
            || fuel == 0
            || fuel > 100_000_000
            || !(1024..=1_048_576).contains(&max_output)
        {
            return Err("Invalid Wasm execution limits".into());
        }
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
        let mut store = Store::new(
            &engine,
            State {
                limits,
                descriptors: BTreeMap::from([(
                    3,
                    Descriptor {
                        path: "/".into(),
                        directory: true,
                        read: true,
                        write: true,
                        append: false,
                        offset: 0,
                        rights: (1 << 30) - 1,
                        inheriting: (1 << 30) - 1,
                    },
                )]),
                files: BTreeMap::new(),
                stdout: Vec::new(),
                stderr: Vec::new(),
                max_output,
                pending: None,
                requests: 0,
                closed: BTreeSet::new(),
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
                invocation.resume(&mut self.store, &[Val::I32(response)], &mut self.outputs)
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
        memory: usize,
        fuel: u64,
        max_output: usize,
    ) -> Result<WasmGuest, JsValue> {
        Self::create(bytes, memory, fuel, max_output).map_err(|error| JsValue::from_str(&error))
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

    pub fn has_file(&self, path: &str) -> bool {
        self.store.data().files.contains_key(path)
    }
    pub fn buffered_bytes(&self) -> usize {
        self.store.data().files.values().map(Vec::len).sum()
    }

    pub fn file_data(&self, fd: u32) -> Result<Vec<u8>, JsValue> {
        let state = self.store.data();
        let descriptor = state
            .descriptors
            .get(&fd)
            .ok_or_else(|| JsValue::from_str("Missing file descriptor"))?;
        state
            .files
            .get(&descriptor.path)
            .cloned()
            .ok_or_else(|| JsValue::from_str("Missing file buffer"))
    }

    pub fn respond(
        &mut self,
        errno: i32,
        data: &[u8],
        path: &str,
        directory: bool,
        value: u64,
    ) -> Result<(), JsValue> {
        let pending = self
            .store
            .data_mut()
            .pending
            .take()
            .ok_or_else(|| JsValue::from_str("No pending Wasm request"))?;
        let mut result = errno;
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
            descriptor.offset = *previous_offset;
            let file = state
                .files
                .get_mut(&descriptor.path)
                .ok_or_else(|| JsValue::from_str("Missing file buffer"))?;
            file.truncate(*previous_length);
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
                Completion::Open {
                    mut descriptor,
                    pointer,
                    truncate,
                } => {
                    let state = self.store.data_mut();
                    let total: usize = state
                        .files
                        .iter()
                        .filter(|(key, _)| key.as_str() != path)
                        .map(|(_, file)| file.len())
                        .sum();
                    if state.descriptors.len() >= MAX_FILES
                        || total.saturating_add(data.len()) > MAX_BYTES
                    {
                        result = 48;
                    } else {
                        descriptor.path = path.into();
                        descriptor.directory = directory;
                        if !directory && (truncate || !state.files.contains_key(path)) {
                            state.files.insert(path.into(), data.to_vec());
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
                    if !positioned {
                        self.store
                            .data_mut()
                            .descriptors
                            .get_mut(&fd)
                            .ok_or_else(|| JsValue::from_str("Missing descriptor"))?
                            .offset = offset;
                    }
                    self.memory
                        .ok_or_else(|| JsValue::from_str("Missing Wasm memory"))?
                        .write(&mut self.store, pointer, &(length as u32).to_le_bytes())
                        .map_err(|error| JsValue::from_str(&error.to_string()))?;
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
        self.response = Some(result);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_binary_and_limits_are_rejected() {
        assert!(WasmGuest::create(b"invalid", 8_388_608, 1000, 1024).is_err());
    }
    #[test]
    fn paths_cannot_escape_the_directory_descriptor() {
        assert!(confined("/tmp", "../escape").is_err());
        assert!(confined("/", "../../escape").is_err());
        assert!(matches!(confined("/tmp","a/../b"),Ok(path) if path == "/tmp/b"));
    }
}
