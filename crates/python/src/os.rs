#[rustpython_vm::pymodule(name = "os")]
pub mod native {
    use crate::filesystem::{exchange, fault};
    use base64::Engine;
    use rustpython_vm::{
        FromArgs, PyObjectRef, PyPayload, PyRef, PyResult, VirtualMachine,
        builtins::{PyDictRef, PyStrRef},
        convert::ToPyObject,
        function::{ArgMemoryBuffer, FsPath, OptionalArg},
        pyclass, pystruct_sequence, pystruct_sequence_data,
        types::PyStructSequence,
    };
    use serde_json::{Value, json};
    use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

    #[pyattr]
    const O_RDONLY: i32 = 0;
    #[pyattr]
    const O_WRONLY: i32 = 1;
    #[pyattr]
    const O_RDWR: i32 = 2;
    #[pyattr]
    const O_CREAT: i32 = 64;
    #[pyattr]
    const O_EXCL: i32 = 128;
    #[pyattr]
    const O_TRUNC: i32 = 512;
    #[pyattr]
    const O_APPEND: i32 = 1024;
    #[pyattr]
    const O_CLOEXEC: i32 = 524288;
    #[pyattr]
    const SEEK_SET: i32 = 0;
    #[pyattr]
    const SEEK_CUR: i32 = 1;
    #[pyattr]
    const SEEK_END: i32 = 2;

    #[derive(Debug)]
    struct Description {
        snapshot: Value,
        offset: u64,
    }
    #[derive(Debug)]
    struct Descriptor {
        description: Rc<RefCell<Description>>,
        inheritable: bool,
    }
    #[pyattr]
    #[pyclass(module = "os", name = "_DescriptorTable")]
    #[derive(Debug, PyPayload)]
    struct DescriptorTable {
        entries: RefCell<BTreeMap<i32, Descriptor>>,
    }
    #[pyclass]
    impl DescriptorTable {}

    #[pyattr]
    fn _boxes_descriptors(_vm: &VirtualMachine) -> DescriptorTable {
        DescriptorTable {
            entries: RefCell::new(BTreeMap::new()),
        }
    }
    fn table(vm: &VirtualMachine) -> PyResult<PyRef<DescriptorTable>> {
        vm.import("os", 0)?
            .get_attr("_boxes_descriptors", vm)?
            .try_into_value(vm)
    }
    fn available(table: &DescriptorTable, vm: &VirtualMachine) -> PyResult<i32> {
        if let Some(fd) = (3..128).find(|fd| !table.entries.borrow().contains_key(fd)) {
            return Ok(fd);
        }
        Err(fault(vm, "EMFILE", "Too many open files")?)
    }
    fn description(fd: i32, vm: &VirtualMachine) -> PyResult<Rc<RefCell<Description>>> {
        let table = table(vm)?;
        if let Some(entry) = table.entries.borrow().get(&fd) {
            return Ok(entry.description.clone());
        }
        Err(fault(vm, "EBADF", "Bad file descriptor")?)
    }
    fn refresh(description: &RefCell<Description>, vm: &VirtualMachine) -> PyResult<Value> {
        let snapshot = description.borrow().snapshot.clone();
        let snapshot = exchange(vm, &json!({"op":"python.file.stat", "snapshot":snapshot}))?;
        description.borrow_mut().snapshot = snapshot.clone();
        Ok(snapshot)
    }
    fn integer(value: &Value, key: &str, vm: &VirtualMachine) -> PyResult<u64> {
        value
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| vm.new_runtime_error(format!("File metadata has no {key}")))
    }
    fn timestamp(value: &Value, key: &str, vm: &VirtualMachine) -> PyResult<u64> {
        value
            .get(key)
            .and_then(Value::as_str)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| vm.new_runtime_error(format!("File metadata has invalid {key}")))
    }

    #[derive(Debug, FromArgs)]
    #[pystruct_sequence_data]
    struct StatResultData {
        st_mode: u64,
        st_ino: u64,
        st_dev: u64,
        st_nlink: u64,
        st_uid: u64,
        st_gid: u64,
        st_size: u64,
        #[pystruct_sequence(unnamed)]
        st_atime_int: u64,
        #[pystruct_sequence(unnamed)]
        st_mtime_int: u64,
        #[pystruct_sequence(unnamed)]
        st_ctime_int: u64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_atime: f64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_mtime: f64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_ctime: f64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_atime_ns: u64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_mtime_ns: u64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_ctime_ns: u64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_blksize: u64,
        #[pyarg(any, default)]
        #[pystruct_sequence(skip)]
        st_blocks: u64,
    }
    #[pyattr]
    #[pystruct_sequence(name = "stat_result", module = "os", data = "StatResultData")]
    struct StatResult;
    #[pyclass(with(PyStructSequence))]
    impl StatResult {}

    #[pyattr]
    fn environ(vm: &VirtualMachine) -> PyDictRef {
        vm.ctx.new_dict()
    }

    #[pyfunction]
    fn getenv(key: PyStrRef, default: OptionalArg<PyObjectRef>, vm: &VirtualMachine) -> PyResult {
        let module = vm.import("os", 0)?;
        let environ = module.get_attr("environ", vm)?;
        let environ: PyDictRef = environ.try_into_value(vm)?;
        Ok(environ
            .get_item_opt(&*key, vm)?
            .unwrap_or_else(|| default.unwrap_or_else(|| vm.ctx.none())))
    }

    #[pyfunction]
    fn fspath(path: PyObjectRef, vm: &VirtualMachine) -> PyResult {
        Ok(FsPath::try_from_path_like(path, false, vm)?.to_pyobject(vm))
    }

    #[derive(FromArgs)]
    struct OpenArgs {
        #[pyarg(positional)]
        path: FsPath,
        #[pyarg(positional)]
        flags: i32,
        #[pyarg(any, default = 0o777)]
        mode: u32,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
    }
    #[pyfunction]
    fn open(args: OpenArgs, vm: &VirtualMachine) -> PyResult<i32> {
        if args.flags & !O_CLOEXEC != 0 || args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Only read-only regular-file descriptors are available",
            )?);
        }
        let _mode = args.mode;
        let path = std::str::from_utf8(args.path.as_bytes())
            .map_err(|_| vm.new_value_error("Sandbox paths must be UTF-8"))?;
        let table = table(vm)?;
        let fd = available(&table, vm)?;
        let snapshot = exchange(vm, &json!({"op":"python.file.openRead", "path":path}))?;
        table.entries.borrow_mut().insert(
            fd,
            Descriptor {
                description: Rc::new(RefCell::new(Description {
                    snapshot,
                    offset: 0,
                })),
                inheritable: false,
            },
        );
        Ok(fd)
    }
    #[pyfunction]
    fn close(fd: i32, vm: &VirtualMachine) -> PyResult<()> {
        if table(vm)?.entries.borrow_mut().remove(&fd).is_none() {
            return Err(fault(vm, "EBADF", "Bad file descriptor")?);
        }
        Ok(())
    }
    #[pyfunction]
    fn dup(fd: i32, vm: &VirtualMachine) -> PyResult<i32> {
        let description = description(fd, vm)?;
        let table = table(vm)?;
        let target = available(&table, vm)?;
        table.entries.borrow_mut().insert(
            target,
            Descriptor {
                description,
                inheritable: false,
            },
        );
        Ok(target)
    }
    #[pyfunction]
    fn get_inheritable(fd: i32, vm: &VirtualMachine) -> PyResult<bool> {
        let table = table(vm)?;
        if let Some(entry) = table.entries.borrow().get(&fd) {
            return Ok(entry.inheritable);
        }
        Err(fault(vm, "EBADF", "Bad file descriptor")?)
    }
    #[pyfunction]
    fn set_inheritable(fd: i32, inheritable: bool, vm: &VirtualMachine) -> PyResult<()> {
        let table = table(vm)?;
        let mut entries = table.entries.borrow_mut();
        let Some(entry) = entries.get_mut(&fd) else {
            return Err(fault(vm, "EBADF", "Bad file descriptor")?);
        };
        entry.inheritable = inheritable;
        Ok(())
    }
    fn read_bytes(fd: i32, length: i64, vm: &VirtualMachine) -> PyResult<Vec<u8>> {
        if length < 0 {
            return Err(fault(vm, "EINVAL", "Negative read length")?);
        }
        let description = description(fd, vm)?;
        let (snapshot, offset) = {
            let state = description.borrow();
            (state.snapshot.clone(), state.offset)
        };
        let length = length.min(262_144) as u64;
        let value = exchange(
            vm,
            &json!({"op":"python.file.read", "snapshot":snapshot, "offset":offset, "length":length}),
        )?;
        let encoded = value
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| vm.new_runtime_error("File read response has no content"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| vm.new_runtime_error(error.to_string()))?;
        if bytes.len() as u64 > length {
            return Err(vm.new_runtime_error("File read exceeded requested length"));
        }
        let snapshot = value
            .get("snapshot")
            .ok_or_else(|| vm.new_runtime_error("File read response has no snapshot"))?;
        let mut state = description.borrow_mut();
        state.snapshot = snapshot.clone();
        state.offset += bytes.len() as u64;
        Ok(bytes)
    }
    #[pyfunction]
    fn read(fd: i32, length: i64, vm: &VirtualMachine) -> PyResult {
        Ok(vm.ctx.new_bytes(read_bytes(fd, length, vm)?).into())
    }
    #[pyfunction]
    fn readinto(fd: i32, buffer: ArgMemoryBuffer, vm: &VirtualMachine) -> PyResult<usize> {
        let bytes = read_bytes(fd, buffer.len().min(262_144) as i64, vm)?;
        buffer.borrow_buf_mut()[..bytes.len()].copy_from_slice(&bytes);
        Ok(bytes.len())
    }
    #[pyfunction]
    fn isatty(fd: i32, vm: &VirtualMachine) -> PyResult<bool> {
        description(fd, vm)?;
        Ok(false)
    }
    #[pyfunction]
    fn lseek(fd: i32, offset: i64, whence: i32, vm: &VirtualMachine) -> PyResult<u64> {
        let description = description(fd, vm)?;
        let base = match whence {
            SEEK_SET => 0,
            SEEK_CUR => description.borrow().offset,
            SEEK_END => integer(&refresh(&description, vm)?["stat"], "size", vm)?,
            _ => return Err(fault(vm, "EINVAL", "Invalid seek origin")?),
        };
        let Some(next) = base
            .checked_add_signed(offset)
            .filter(|next| *next <= 9_007_199_254_740_991)
        else {
            return Err(fault(vm, "EINVAL", "Invalid seek position")?);
        };
        description.borrow_mut().offset = next;
        Ok(next)
    }
    #[pyfunction]
    fn fstat(fd: i32, vm: &VirtualMachine) -> PyResult {
        let description = description(fd, vm)?;
        let snapshot = refresh(&description, vm)?;
        let stat = &snapshot["stat"];
        let size = integer(stat, "size", vm)?;
        let atime = timestamp(stat, "atimeNs", vm)?;
        let mtime = timestamp(stat, "mtimeNs", vm)?;
        let ctime = timestamp(stat, "ctimeNs", vm)?;
        Ok(StatResultData {
            st_mode: 0o100000 | integer(stat, "mode", vm)?,
            st_ino: integer(stat, "inode", vm)?,
            st_dev: 0,
            st_nlink: integer(stat, "nlink", vm)?,
            st_uid: integer(stat, "uid", vm)?,
            st_gid: integer(stat, "gid", vm)?,
            st_size: size,
            st_atime_int: atime / 1_000_000_000,
            st_mtime_int: mtime / 1_000_000_000,
            st_ctime_int: ctime / 1_000_000_000,
            st_atime: atime as f64 / 1e9,
            st_mtime: mtime as f64 / 1e9,
            st_ctime: ctime as f64 / 1e9,
            st_atime_ns: atime,
            st_mtime_ns: mtime,
            st_ctime_ns: ctime,
            st_blksize: 262144,
            st_blocks: size.div_ceil(512),
        }
        .to_pyobject(vm))
    }
}
