#[rustpython_vm::pymodule(name = "os")]
pub mod native {
    use crate::filesystem::{exchange, fault};
    use base64::Engine;
    use rustpython_vm::{
        FromArgs, PyObjectRef, PyPayload, PyRef, PyResult, VirtualMachine,
        builtins::{PyDictRef, PyStrRef},
        convert::ToPyObject,
        function::{ArgBytesLike, ArgMemoryBuffer, FsPath, OptionalArg},
        pyclass, pystruct_sequence, pystruct_sequence_data,
        types::PyStructSequence,
    };
    use serde_json::{Value, json};
    use std::{
        cell::{Cell, RefCell},
        collections::BTreeMap,
        rc::{Rc, Weak},
    };

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

    const DETACHED_BYTES: usize = 16_777_216;
    #[derive(Debug)]
    struct DetachedData {
        bytes: Vec<u8>,
        budget: Rc<Cell<usize>>,
    }
    impl Drop for DetachedData {
        fn drop(&mut self) {
            self.budget
                .set(self.budget.get().saturating_sub(self.bytes.len()));
        }
    }
    #[derive(Debug)]
    struct FileImage {
        snapshot: Value,
        detached: Option<DetachedData>,
    }
    #[derive(Debug)]
    struct Description {
        image: Rc<RefCell<FileImage>>,
        offset: u64,
        readable: bool,
        writable: bool,
        append: bool,
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
        mask: Cell<u32>,
        images: RefCell<BTreeMap<u64, Weak<RefCell<FileImage>>>>,
        detached_bytes: Rc<Cell<usize>>,
    }
    #[pyclass]
    impl DescriptorTable {}

    thread_local! {
        static TABLES: RefCell<BTreeMap<usize,PyRef<DescriptorTable>>> = const {RefCell::new(BTreeMap::new())};
    }
    #[pyattr]
    fn _boxes_descriptors(vm: &VirtualMachine) -> PyRef<DescriptorTable> {
        table(vm)
    }
    fn table(vm: &VirtualMachine) -> PyRef<DescriptorTable> {
        let key = std::ptr::from_ref(&*vm.state) as usize;
        TABLES.with(|tables| {
            if let Some(table) = tables.borrow().get(&key) {
                return table.clone();
            }
            let table = DescriptorTable {
                entries: RefCell::new(BTreeMap::new()),
                mask: Cell::new(0o022),
                images: RefCell::new(BTreeMap::new()),
                detached_bytes: Rc::new(Cell::new(0)),
            }
            .into_ref(&vm.ctx);
            tables.borrow_mut().insert(key, table.clone());
            table
        })
    }
    fn available(table: &DescriptorTable, vm: &VirtualMachine) -> PyResult<i32> {
        if let Some(fd) = (3..128).find(|fd| !table.entries.borrow().contains_key(fd)) {
            return Ok(fd);
        }
        Err(fault(vm, "EMFILE", "Too many open files")?)
    }
    fn description(fd: i32, vm: &VirtualMachine) -> PyResult<Rc<RefCell<Description>>> {
        let table = table(vm);
        if let Some(entry) = table.entries.borrow().get(&fd) {
            return Ok(entry.description.clone());
        }
        Err(fault(vm, "EBADF", "Bad file descriptor")?)
    }
    fn refresh(description: &RefCell<Description>, vm: &VirtualMachine) -> PyResult<Value> {
        let snapshot = description.borrow().image.borrow().snapshot.clone();
        let snapshot = exchange(vm, &json!({"op":"python.file.stat", "snapshot":snapshot}))?;
        description.borrow().image.borrow_mut().snapshot = snapshot.clone();
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

    fn materialize(image: &RefCell<FileImage>, retain: usize, vm: &VirtualMachine) -> PyResult<()> {
        if image.borrow().detached.is_some() {
            return Ok(());
        }
        let mut snapshot = image.borrow().snapshot.clone();
        let size = (integer(&snapshot["stat"], "size", vm)? as usize).min(retain);
        let budget = table(vm).detached_bytes.clone();
        if size > DETACHED_BYTES || budget.get().saturating_add(size) > DETACHED_BYTES {
            return Err(fault(vm, "ENOSPC", "Detached file cache exceeds 16 MiB")?);
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(size)
            .map_err(|_| vm.no_memory_error())?;
        while bytes.len() < size {
            let length = (size - bytes.len()).min(262144);
            let value = exchange(
                vm,
                &json!({"op":"python.file.read","snapshot":snapshot,"offset":bytes.len(),"length":length,"forWrite":true}),
            )?;
            let encoded = value
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| vm.new_runtime_error("Detached read has no content"))?;
            let part = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| vm.new_runtime_error(error.to_string()))?;
            if part.is_empty() || part.len() > length {
                return Err(vm.new_runtime_error("Detached read length mismatch"));
            }
            bytes.extend_from_slice(&part);
            snapshot = value
                .get("snapshot")
                .ok_or_else(|| vm.new_runtime_error("Detached read has no snapshot"))?
                .clone();
        }
        snapshot["stat"]["nlink"] = json!(0);
        budget.set(budget.get() + size);
        let mut image = image.borrow_mut();
        image.snapshot = snapshot;
        image.detached = Some(DetachedData { bytes, budget });
        Ok(())
    }
    fn resize_detached(
        image: &RefCell<FileImage>,
        size: usize,
        vm: &VirtualMachine,
    ) -> PyResult<()> {
        let mut image = image.borrow_mut();
        let detached = image
            .detached
            .as_mut()
            .ok_or_else(|| vm.new_runtime_error("Detached cache unavailable"))?;
        let total = detached
            .budget
            .get()
            .checked_sub(detached.bytes.len())
            .and_then(|total| total.checked_add(size))
            .ok_or_else(|| vm.new_runtime_error("Detached cache size overflow"))?;
        if size > DETACHED_BYTES || total > DETACHED_BYTES {
            return Err(fault(vm, "ENOSPC", "Detached file cache exceeds 16 MiB")?);
        }
        if size > detached.bytes.len() {
            detached
                .bytes
                .try_reserve_exact(size - detached.bytes.len())
                .map_err(|_| vm.no_memory_error())?;
        }
        detached.bytes.resize(size, 0);
        detached.budget.set(total);
        image.snapshot["stat"]["size"] = json!(size);
        Ok(())
    }
    fn detached_time(
        image: &RefCell<FileImage>,
        reply: &Value,
        vm: &VirtualMachine,
    ) -> PyResult<()> {
        let now = reply
            .get("nowNs")
            .and_then(Value::as_str)
            .ok_or_else(|| vm.new_runtime_error("Detached mutation has no timestamp"))?;
        let mut image = image.borrow_mut();
        image.snapshot["stat"]["mtimeNs"] = json!(now);
        image.snapshot["stat"]["ctimeNs"] = json!(now);
        image.snapshot["stat"]["nlink"] = json!(0);
        Ok(())
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
        let allowed = O_CLOEXEC | O_WRONLY | O_RDWR | O_CREAT | O_EXCL | O_TRUNC | O_APPEND;
        if args.flags & !allowed != 0 || args.dir_fd.is_some() || args.mode & !0o777 != 0 {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Unsupported regular-file open options",
            )?);
        }
        let access = match args.flags & 3 {
            O_RDONLY => 1,
            O_WRONLY => 2,
            O_RDWR => 3,
            _ => return Err(fault(vm, "EINVAL", "Invalid access mode")?),
        };
        let mut creation = 0u32;
        if args.flags & O_CREAT != 0 {
            creation |= 1;
        }
        if args.flags & O_EXCL != 0 {
            creation |= 2;
        }
        if args.flags & O_TRUNC != 0 {
            creation |= 4;
        }
        let path = std::str::from_utf8(args.path.as_bytes())
            .map_err(|_| vm.new_value_error("Sandbox paths must be UTF-8"))?;
        let table = table(vm);
        let fd = available(&table, vm)?;
        let mode = args.mode & !table.mask.get();
        let snapshot = exchange(
            vm,
            &json!({"op":"python.file.open","path":path,"access":access,"creation":creation,"mode":mode}),
        )?;
        let inode = integer(&snapshot["stat"], "inode", vm)?;
        table
            .images
            .borrow_mut()
            .retain(|_, image| image.strong_count() > 0);
        let existing = table.images.borrow().get(&inode).and_then(Weak::upgrade);
        let image = match existing {
            Some(image) => {
                image.borrow_mut().snapshot = snapshot;
                image
            }
            None => {
                let image = Rc::new(RefCell::new(FileImage {
                    snapshot,
                    detached: None,
                }));
                table
                    .images
                    .borrow_mut()
                    .insert(inode, Rc::downgrade(&image));
                image
            }
        };
        table.entries.borrow_mut().insert(
            fd,
            Descriptor {
                description: Rc::new(RefCell::new(Description {
                    image,
                    offset: 0,
                    readable: access & 1 != 0,
                    writable: access & 2 != 0,
                    append: args.flags & O_APPEND != 0,
                })),
                inheritable: false,
            },
        );
        Ok(fd)
    }
    #[pyfunction]
    fn close(fd: i32, vm: &VirtualMachine) -> PyResult<()> {
        if table(vm).entries.borrow_mut().remove(&fd).is_none() {
            return Err(fault(vm, "EBADF", "Bad file descriptor")?);
        }
        Ok(())
    }
    #[pyfunction]
    fn dup(fd: i32, vm: &VirtualMachine) -> PyResult<i32> {
        let description = description(fd, vm)?;
        let table = table(vm);
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
        let table = table(vm);
        if let Some(entry) = table.entries.borrow().get(&fd) {
            return Ok(entry.inheritable);
        }
        Err(fault(vm, "EBADF", "Bad file descriptor")?)
    }
    #[pyfunction]
    fn set_inheritable(fd: i32, inheritable: bool, vm: &VirtualMachine) -> PyResult<()> {
        let table = table(vm);
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
            if !state.readable {
                return Err(fault(vm, "EBADF", "Descriptor is not readable")?);
            }
            (state.image.borrow().snapshot.clone(), state.offset)
        };
        let length = length.min(262_144) as u64;
        let cached = description.borrow().image.borrow().detached.is_some();
        let requested = if cached { 0 } else { length };
        let value = exchange(
            vm,
            &json!({"op":"python.file.read", "snapshot":snapshot, "offset":offset, "length":requested,"forWrite":false}),
        )?;
        if cached {
            let bytes = {
                let state = description.borrow();
                let image = state.image.borrow();
                let data = &image
                    .detached
                    .as_ref()
                    .ok_or_else(|| vm.new_runtime_error("Detached cache unavailable"))?
                    .bytes;
                let start = offset.min(data.len() as u64) as usize;
                data[start..(start + length as usize).min(data.len())].to_vec()
            };
            description.borrow_mut().offset += bytes.len() as u64;
            return Ok(bytes);
        }
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
        state.image.borrow_mut().snapshot = snapshot.clone();
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
    fn umask(mask: i32, vm: &VirtualMachine) -> PyResult<u32> {
        Ok(table(vm).mask.replace(mask as u32 & 0o777))
    }
    #[pyfunction]
    fn write(fd: i32, data: ArgBytesLike, vm: &VirtualMachine) -> PyResult<usize> {
        let description = description(fd, vm)?;
        let (snapshot, offset) = {
            let state = description.borrow();
            if !state.writable {
                return Err(fault(vm, "EBADF", "Descriptor is not writable")?);
            }
            let offset = if state.append {
                None
            } else {
                Some(state.offset)
            };
            (state.image.borrow().snapshot.clone(), offset)
        };
        if data.is_empty() {
            return Ok(0);
        }
        let length = data.len().min(262144);
        let encoded = data
            .with_ref(|bytes| base64::engine::general_purpose::STANDARD.encode(&bytes[..length]));
        let result = exchange(
            vm,
            &json!({"op":"python.file.write","snapshot":snapshot,"offset":offset,"content":encoded}),
        )?;
        if result.get("detached").and_then(Value::as_bool) == Some(true) {
            let image = description.borrow().image.clone();
            materialize(&image, DETACHED_BYTES, vm)?;
            let position = offset.unwrap_or(integer(&image.borrow().snapshot["stat"], "size", vm)?);
            let Some(end) = position
                .checked_add(length as u64)
                .filter(|end| *end <= DETACHED_BYTES as u64)
            else {
                return Err(fault(vm, "EFBIG", "File size exceeds its limit")?);
            };
            let old_size = integer(&image.borrow().snapshot["stat"], "size", vm)?;
            resize_detached(&image, end.max(old_size) as usize, vm)?;
            {
                let mut image = image.borrow_mut();
                let detached = image
                    .detached
                    .as_mut()
                    .ok_or_else(|| vm.new_runtime_error("Detached cache unavailable"))?;
                data.with_ref(|bytes| {
                    detached.bytes[position as usize..end as usize]
                        .copy_from_slice(&bytes[..length])
                });
            }
            detached_time(&image, &result, vm)?;
            description.borrow_mut().offset = end;
            return Ok(length);
        }
        let count = integer(&result, "count", vm)?;
        if count > length as u64 {
            return Err(vm.new_runtime_error("Write acknowledgement exceeds submitted bytes"));
        }
        let offset = integer(&result, "offset", vm)?;
        let snapshot = result
            .get("snapshot")
            .ok_or_else(|| vm.new_runtime_error("Write acknowledgement has no snapshot"))?;
        let mut state = description.borrow_mut();
        state.offset = offset;
        state.image.borrow_mut().snapshot = snapshot.clone();
        Ok(count as usize)
    }
    #[pyfunction]
    fn ftruncate(fd: i32, size: i64, vm: &VirtualMachine) -> PyResult<()> {
        if size < 0 {
            return Err(fault(vm, "EINVAL", "Negative file size")?);
        }
        if size > 16777216 {
            return Err(fault(vm, "EFBIG", "File size exceeds its limit")?);
        }
        let description = description(fd, vm)?;
        let snapshot = {
            let state = description.borrow();
            if !state.writable {
                return Err(fault(vm, "EBADF", "Descriptor is not writable")?);
            }
            state.image.borrow().snapshot.clone()
        };
        let snapshot = exchange(
            vm,
            &json!({"op":"python.file.resize","snapshot":snapshot,"size":size}),
        )?;
        let image = description.borrow().image.clone();
        if snapshot.get("detached").and_then(Value::as_bool) == Some(true) {
            materialize(&image, size as usize, vm)?;
            resize_detached(&image, size as usize, vm)?;
            detached_time(&image, &snapshot, vm)?;
        } else {
            image.borrow_mut().snapshot = snapshot;
        }
        Ok(())
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
