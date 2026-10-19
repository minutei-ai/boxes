#[rustpython_vm::pymodule(name = "os")]
pub mod native {
    use crate::filesystem::{exchange, fault};
    use base64::Engine;
    use rustpython_vm::{
        AsObject, FromArgs, Py, PyObjectRef, PyPayload, PyRef, PyResult, VirtualMachine,
        builtins::{PyDictRef, PyStrRef, PyTupleRef},
        convert::ToPyObject,
        function::{ArgBytesLike, ArgMemoryBuffer, Either, FsPath, FuncArgs, OptionalArg},
        protocol::PyIterReturn,
        pyclass, pystruct_sequence, pystruct_sequence_data,
        types::PyStructSequence,
        types::{IterNext, Iterable, SelfIter},
    };
    use serde_json::{Value, json};
    use std::{
        cell::{Cell, RefCell},
        collections::{BTreeMap, VecDeque},
        rc::{Rc, Weak},
    };

    #[pyattr(name = "name")]
    const NAME: &str = "posix";

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
        inode: Rc<u64>,
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
        inodes: RefCell<BTreeMap<u64, Weak<u64>>>,
        cwd: Cell<Option<u64>>,
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
                inodes: RefCell::new(BTreeMap::new()),
                cwd: Cell::new(None),
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
        let inode = *description.borrow().inode;
        exchange(vm, &json!({"op":"python.file.stat", "inode":inode}))
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
    fn text<'a>(value: &'a Value, key: &str, vm: &VirtualMachine) -> PyResult<&'a str> {
        value
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| vm.new_runtime_error(format!("Filesystem response has no {key}")))
    }
    fn cwd(vm: &VirtualMachine) -> PyResult<String> {
        match table(vm).cwd.get() {
            None => Ok("/".into()),
            Some(inode) => {
                let stat = exchange(vm, &json!({"op":"python.file.cwd","inode":inode}))?;
                Ok(text(&stat, "path", vm)?.into())
            }
        }
    }
    fn path(path: &FsPath, vm: &VirtualMachine) -> PyResult<String> {
        let value = std::str::from_utf8(path.as_bytes())
            .map_err(|_| vm.new_value_error("Sandbox paths must be UTF-8"))?;
        if value.is_empty() {
            return Err(fault(vm, "ENOENT", "Empty filesystem path")?);
        }
        if value.len() > 4096 {
            return Err(fault(
                vm,
                "ENAMETOOLONG",
                "Filesystem path exceeds its bound",
            )?);
        }
        if value.starts_with('/') {
            return Ok(value.into());
        }
        let directory = cwd(vm)?;
        let resolved = if directory == "/" {
            format!("/{value}")
        } else {
            format!("{directory}/{value}")
        };
        if resolved.len() > 4096 {
            return Err(fault(
                vm,
                "ENAMETOOLONG",
                "Filesystem path exceeds its bound",
            )?);
        }
        Ok(resolved)
    }

    #[pyfunction]
    fn getcwd(vm: &VirtualMachine) -> PyResult<String> {
        cwd(vm)
    }
    #[pyfunction]
    fn getcwdb(vm: &VirtualMachine) -> PyResult {
        Ok(vm.ctx.new_bytes(cwd(vm)?.into_bytes()).into())
    }
    #[derive(FromArgs)]
    struct ChdirArgs {
        #[pyarg(any)]
        path: FsPath,
    }
    #[pyfunction]
    fn chdir(args: ChdirArgs, vm: &VirtualMachine) -> PyResult<()> {
        let value = exchange(
            vm,
            &json!({"op":"filesystem.stat","path":path(&args.path,vm)?,"follow":true}),
        )?;
        if text(&value, "kind", vm)? != "directory" {
            return Err(fault(
                vm,
                "ENOTDIR",
                "Current directory must be a directory",
            )?);
        }
        if integer(&value, "mode", vm)? & 0o100 == 0 {
            return Err(fault(vm, "EACCES", "Directory is not searchable")?);
        }
        table(vm).cwd.set(Some(integer(&value, "inode", vm)?));
        Ok(())
    }
    #[derive(FromArgs)]
    struct StatArgs {
        #[pyarg(any)]
        path: Either<i32, FsPath>,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
        #[pyarg(named, default = true)]
        follow_symlinks: bool,
    }
    #[pyfunction]
    fn stat(args: StatArgs, vm: &VirtualMachine) -> PyResult {
        if args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        match args.path {
            Either::A(fd) => {
                if !args.follow_symlinks {
                    return Err(
                        vm.new_value_error("stat: cannot use fd and follow_symlinks together")
                    );
                }
                fstat(fd, vm)
            }
            Either::B(input) => {
                let value = exchange(
                    vm,
                    &json!({"op":"filesystem.stat","path":path(&input,vm)?,"follow":args.follow_symlinks}),
                )?;
                stat_result(&value, vm)
            }
        }
    }
    #[derive(FromArgs)]
    struct PathArgs {
        #[pyarg(any)]
        path: FsPath,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
    }
    #[pyfunction]
    fn lstat(args: PathArgs, vm: &VirtualMachine) -> PyResult {
        if args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        let value = exchange(
            vm,
            &json!({"op":"filesystem.stat","path":path(&args.path,vm)?,"follow":false}),
        )?;
        stat_result(&value, vm)
    }
    #[pyfunction]
    fn readlink(args: PathArgs, vm: &VirtualMachine) -> PyResult {
        if args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        let value = exchange(
            vm,
            &json!({"op":"filesystem.readlink","path":path(&args.path,vm)?}),
        )?;
        let target = text(&value, "target", vm)?;
        match args.path {
            FsPath::Str(_) => Ok(vm.ctx.new_str(target).into()),
            FsPath::Bytes(_) => Ok(vm.ctx.new_bytes(target.as_bytes().to_vec()).into()),
        }
    }
    #[derive(FromArgs)]
    struct MkdirArgs {
        #[pyarg(any)]
        path: FsPath,
        #[pyarg(any, default = 0o777)]
        mode: u32,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
    }
    #[pyfunction]
    fn mkdir(args: MkdirArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.dir_fd.is_some() || args.mode & !0o777 != 0 {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Unsupported directory creation options",
            )?);
        }
        let mode = args.mode & !table(vm).mask.get();
        exchange(
            vm,
            &json!({"op":"python.file.mkdir","path":path(&args.path,vm)?,"mode":mode}),
        )?;
        Ok(())
    }
    #[pyfunction]
    #[pyfunction(name = "unlink")]
    fn remove(args: PathArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        exchange(
            vm,
            &json!({"op":"python.file.remove","path":path(&args.path,vm)?,"directory":false}),
        )?;
        Ok(())
    }
    #[pyfunction]
    fn rmdir(args: PathArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        exchange(
            vm,
            &json!({"op":"python.file.remove","path":path(&args.path,vm)?,"directory":true}),
        )?;
        Ok(())
    }
    #[derive(FromArgs)]
    struct RenameArgs {
        #[pyarg(any)]
        src: FsPath,
        #[pyarg(any)]
        dst: FsPath,
        #[pyarg(named, default)]
        src_dir_fd: Option<i32>,
        #[pyarg(named, default)]
        dst_dir_fd: Option<i32>,
    }
    #[pyfunction]
    #[pyfunction(name = "replace")]
    fn rename(args: RenameArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.src_dir_fd.is_some() || args.dst_dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        exchange(
            vm,
            &json!({"op":"filesystem.move","from":path(&args.src,vm)?,"to":path(&args.dst,vm)?}),
        )?;
        Ok(())
    }

    #[derive(FromArgs)]
    struct ChmodArgs {
        #[pyarg(any)]
        path: FsPath,
        #[pyarg(any)]
        mode: u32,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
        #[pyarg(named, default = true)]
        follow_symlinks: bool,
    }
    #[pyfunction]
    fn chmod(args: ChmodArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.dir_fd.is_some() || !args.follow_symlinks || args.mode & !0o777 != 0 {
            return Err(fault(vm, "ENOTSUP", "Unsupported permission options")?);
        }
        exchange(
            vm,
            &json!({"op":"filesystem.chmod","path":path(&args.path,vm)?,"mode":args.mode}),
        )?;
        Ok(())
    }
    #[derive(FromArgs)]
    struct LinkArgs {
        #[pyarg(any)]
        src: FsPath,
        #[pyarg(any)]
        dst: FsPath,
        #[pyarg(named, default)]
        src_dir_fd: Option<i32>,
        #[pyarg(named, default)]
        dst_dir_fd: Option<i32>,
        #[pyarg(named, default = true)]
        follow_symlinks: bool,
    }
    #[pyfunction]
    fn link(args: LinkArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.src_dir_fd.is_some() || args.dst_dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        exchange(
            vm,
            &json!({"op":"filesystem.link","from":path(&args.src,vm)?,"to":path(&args.dst,vm)?,"follow":args.follow_symlinks}),
        )?;
        Ok(())
    }
    #[derive(FromArgs)]
    struct SymlinkArgs {
        #[pyarg(any)]
        src: FsPath,
        #[pyarg(any)]
        dst: FsPath,
        #[pyarg(any, default = false)]
        target_is_directory: bool,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
    }
    #[pyfunction]
    fn symlink(args: SymlinkArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.dir_fd.is_some() || args.target_is_directory {
            return Err(fault(vm, "ENOTSUP", "Unsupported symlink options")?);
        }
        let target = std::str::from_utf8(args.src.as_bytes())
            .map_err(|_| vm.new_value_error("Sandbox paths must be UTF-8"))?;
        if target.is_empty() {
            return Err(fault(vm, "ENOENT", "Empty symlink target")?);
        }
        if target.len() > 4096 {
            return Err(fault(
                vm,
                "ENAMETOOLONG",
                "Symlink target exceeds its bound",
            )?);
        }
        exchange(
            vm,
            &json!({"op":"filesystem.symlink","path":path(&args.dst,vm)?,"target":target}),
        )?;
        Ok(())
    }
    #[derive(FromArgs)]
    struct UtimeArgs {
        #[pyarg(any)]
        path: FsPath,
        #[pyarg(any, default)]
        times: Option<PyTupleRef>,
        #[pyarg(named, default)]
        ns: Option<PyTupleRef>,
        #[pyarg(named, default)]
        dir_fd: Option<i32>,
        #[pyarg(named, default = true)]
        follow_symlinks: bool,
    }
    #[pyfunction]
    fn utime(args: UtimeArgs, vm: &VirtualMachine) -> PyResult<()> {
        if args.dir_fd.is_some() {
            return Err(fault(
                vm,
                "ENOTSUP",
                "Directory descriptors are not supported",
            )?);
        }
        let times = match (args.times, args.ns) {
            (None, None) => Value::Null,
            (Some(_), Some(_)) => {
                return Err(vm.new_value_error("utime: cannot specify both times and ns"));
            }
            (times, ns) => {
                let nanoseconds = ns.is_some();
                let values = times
                    .or(ns)
                    .ok_or_else(|| vm.new_runtime_error("Missing timestamp tuple"))?;
                if values.len() != 2 {
                    return Err(vm.new_type_error("utime: expected a tuple of two timestamps"));
                }
                let converted = values
                    .iter()
                    .map(|value| -> PyResult<String> {
                        if nanoseconds {
                            let value: u64 = value.try_index(vm)?.try_to_primitive_in_range(vm)?;
                            return Ok(value.to_string());
                        }
                        let value = value.try_float(vm)?.to_f64();
                        if value.is_nan() {
                            return Err(vm.new_value_error("Invalid timestamp NaN"));
                        }
                        if !value.is_finite() || !(0.0..18_446_744_074.0).contains(&value) {
                            return Err(
                                vm.new_overflow_error("Timestamp is outside the sandbox range")
                            );
                        }
                        let seconds = value.floor();
                        let fraction = ((value - seconds) * 1_000_000_000.0).floor() as u64;
                        let nanoseconds = (seconds as u64)
                            .checked_mul(1_000_000_000)
                            .and_then(|seconds| seconds.checked_add(fraction))
                            .ok_or_else(|| {
                                vm.new_overflow_error("Timestamp is outside the sandbox range")
                            })?;
                        Ok(nanoseconds.to_string())
                    })
                    .collect::<PyResult<Vec<_>>>()?;
                json!(converted)
            }
        };
        exchange(
            vm,
            &json!({"op":"python.file.utime","path":path(&args.path,vm)?,"times":times,"follow":args.follow_symlinks}),
        )?;
        Ok(())
    }

    #[derive(FromArgs)]
    struct ListDirArgs {
        #[pyarg(any, default)]
        path: Option<FsPath>,
    }
    #[pyfunction]
    fn listdir(args: ListDirArgs, vm: &VirtualMachine) -> PyResult<Vec<PyObjectRef>> {
        let input = args
            .path
            .unwrap_or_else(|| FsPath::Str(vm.ctx.new_str(".")));
        let value = exchange(
            vm,
            &json!({"op":"filesystem.readdir","path":path(&input,vm)?}),
        )?;
        let entries = value
            .as_array()
            .ok_or_else(|| vm.new_runtime_error("Directory response is not an array"))?;
        entries
            .iter()
            .map(|entry| {
                let name = text(entry, "name", vm)?;
                match &input {
                    FsPath::Str(_) => Ok(vm.ctx.new_str(name).into()),
                    FsPath::Bytes(_) => Ok(vm.ctx.new_bytes(name.as_bytes().to_vec()).into()),
                }
            })
            .collect()
    }

    #[derive(FromArgs)]
    struct FollowArgs {
        #[pyarg(named, default = true)]
        follow_symlinks: bool,
    }

    #[pyattr]
    #[pyclass(module = "os", name = "DirEntry")]
    #[derive(Debug, PyPayload)]
    struct DirEntry {
        name: PyObjectRef,
        path: PyObjectRef,
        inode: u64,
        kind: String,
        stat: RefCell<Option<PyObjectRef>>,
        lstat: RefCell<Option<PyObjectRef>>,
    }

    impl DirEntry {
        fn metadata(&self, follow: bool, vm: &VirtualMachine) -> PyResult {
            let follows = follow && self.kind == "symlink";
            let cache = if follows { &self.stat } else { &self.lstat };
            if let Some(value) = cache.borrow().as_ref() {
                return Ok(value.clone());
            }
            let input = FsPath::try_from_path_like(self.path.clone(), false, vm)?;
            let value = exchange(
                vm,
                &json!({"op":"filesystem.stat","path":path(&input,vm)?,"follow":follows}),
            )?;
            let result = stat_result(&value, vm)?;
            cache.replace(Some(result.clone()));
            Ok(result)
        }
        fn matches(&self, kind: &str, follow: bool, vm: &VirtualMachine) -> PyResult<bool> {
            if !follow || self.kind != "symlink" {
                return Ok(self.kind == kind);
            }
            match self.metadata(true, vm) {
                Ok(value) => {
                    let mode: u64 = value.get_attr("st_mode", vm)?.try_into_value(vm)?;
                    let expected = match kind {
                        "directory" => 0o040000,
                        "file" => 0o100000,
                        _ => return Err(vm.new_runtime_error("Invalid directory entry type")),
                    };
                    Ok(mode & 0o170000 == expected)
                }
                Err(error) if error.fast_isinstance(vm.ctx.exceptions.file_not_found_error) => {
                    Ok(false)
                }
                Err(error) => Err(error),
            }
        }
    }

    #[pyclass(flags(DISALLOW_INSTANTIATION))]
    impl DirEntry {
        #[pygetset]
        fn name(zelf: &Py<Self>) -> PyObjectRef {
            zelf.name.clone()
        }
        #[pygetset]
        fn path(zelf: &Py<Self>) -> PyObjectRef {
            zelf.path.clone()
        }
        #[pymethod]
        fn __fspath__(zelf: &Py<Self>) -> PyObjectRef {
            zelf.path.clone()
        }
        #[pymethod]
        fn inode(zelf: &Py<Self>) -> u64 {
            zelf.inode
        }
        #[pymethod]
        fn is_symlink(zelf: &Py<Self>) -> bool {
            zelf.kind == "symlink"
        }
        #[pymethod]
        fn is_junction(_zelf: &Py<Self>) -> bool {
            false
        }
        #[pymethod]
        fn is_dir(zelf: &Py<Self>, args: FollowArgs, vm: &VirtualMachine) -> PyResult<bool> {
            zelf.matches("directory", args.follow_symlinks, vm)
        }
        #[pymethod]
        fn is_file(zelf: &Py<Self>, args: FollowArgs, vm: &VirtualMachine) -> PyResult<bool> {
            zelf.matches("file", args.follow_symlinks, vm)
        }
        #[pymethod]
        fn stat(zelf: &Py<Self>, args: FollowArgs, vm: &VirtualMachine) -> PyResult {
            zelf.metadata(args.follow_symlinks, vm)
        }
        #[pymethod]
        fn __reduce__(_zelf: &Py<Self>, vm: &VirtualMachine) -> PyResult {
            Err(vm.new_type_error("cannot pickle 'os.DirEntry' object"))
        }
    }

    #[pyattr]
    #[pyclass(module = "os", name = "ScandirIterator")]
    #[derive(Debug, PyPayload)]
    struct ScandirIterator {
        entries: RefCell<VecDeque<PyObjectRef>>,
    }
    #[pyclass(flags(DISALLOW_INSTANTIATION), with(IterNext, Iterable))]
    impl ScandirIterator {
        #[pymethod]
        fn close(zelf: &Py<Self>) {
            zelf.entries.take();
        }
        #[pymethod]
        fn __enter__(zelf: PyRef<Self>) -> PyRef<Self> {
            zelf
        }
        #[pymethod]
        fn __exit__(zelf: &Py<Self>, _args: FuncArgs) {
            Self::close(zelf);
        }
        #[pymethod]
        fn __reduce__(_zelf: &Py<Self>, vm: &VirtualMachine) -> PyResult {
            Err(vm.new_type_error("cannot pickle 'ScandirIterator' object"))
        }
    }
    impl SelfIter for ScandirIterator {}
    impl IterNext for ScandirIterator {
        fn next(zelf: &Py<Self>, _vm: &VirtualMachine) -> PyResult<PyIterReturn> {
            let next = zelf.entries.borrow_mut().pop_front();
            match next {
                Some(value) => Ok(PyIterReturn::Return(value)),
                None => {
                    ScandirIterator::close(zelf);
                    Ok(PyIterReturn::StopIteration(None))
                }
            }
        }
    }
    #[derive(FromArgs)]
    struct ScandirArgs {
        #[pyarg(any, default)]
        path: Option<Either<i32, FsPath>>,
    }
    #[pyfunction]
    fn scandir(args: ScandirArgs, vm: &VirtualMachine) -> PyResult<PyRef<ScandirIterator>> {
        let input = match args.path {
            None => FsPath::Str(vm.ctx.new_str(".")),
            Some(Either::B(path)) => path,
            Some(Either::A(fd)) if fd < 0 => {
                return Err(fault(vm, "EBADF", "Bad file descriptor")?);
            }
            Some(Either::A(_)) => {
                return Err(fault(
                    vm,
                    "ENOTSUP",
                    "Directory descriptors are not supported",
                )?);
            }
        };
        let value = exchange(
            vm,
            &json!({"op":"filesystem.readdir","path":path(&input,vm)?}),
        )?;
        let entries = value
            .as_array()
            .ok_or_else(|| vm.new_runtime_error("Directory response is not an array"))?;
        let directory = std::str::from_utf8(input.as_bytes())
            .map_err(|_| vm.new_value_error("Sandbox paths must be UTF-8"))?;
        let separator = if directory.ends_with('/') { "" } else { "/" };
        let entries = entries
            .iter()
            .map(|entry| {
                let name = text(entry, "name", vm)?;
                let joined = format!("{directory}{separator}{name}");
                let (name, path): (PyObjectRef, PyObjectRef) = match &input {
                    FsPath::Str(_) => (vm.ctx.new_str(name).into(), vm.ctx.new_str(joined).into()),
                    FsPath::Bytes(_) => (
                        vm.ctx.new_bytes(name.as_bytes().to_vec()).into(),
                        vm.ctx.new_bytes(joined.into_bytes()).into(),
                    ),
                };
                Ok(DirEntry {
                    name,
                    path,
                    inode: integer(entry, "inode", vm)?,
                    kind: text(entry, "kind", vm)?.into(),
                    stat: RefCell::new(None),
                    lstat: RefCell::new(None),
                }
                .into_ref(&vm.ctx)
                .into())
            })
            .collect::<PyResult<VecDeque<_>>>()?;
        Ok(ScandirIterator {
            entries: RefCell::new(entries),
        }
        .into_ref(&vm.ctx))
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
    struct FsEncodingArgs {
        #[pyarg(any)]
        filename: PyObjectRef,
    }

    #[pyfunction]
    fn fsencode(args: FsEncodingArgs, vm: &VirtualMachine) -> PyResult {
        match FsPath::try_from_path_like(args.filename, false, vm)? {
            FsPath::Bytes(value) => Ok(value.into()),
            FsPath::Str(value) => {
                vm.call_method(value.as_object(), "encode", ("utf-8", "surrogateescape"))
            }
        }
    }

    #[pyfunction]
    fn fsdecode(args: FsEncodingArgs, vm: &VirtualMachine) -> PyResult {
        match FsPath::try_from_path_like(args.filename, false, vm)? {
            FsPath::Str(value) => Ok(value.into()),
            FsPath::Bytes(value) => {
                vm.call_method(value.as_object(), "decode", ("utf-8", "surrogateescape"))
            }
        }
    }

    #[pyfunction]
    fn strerror(code: i32) -> String {
        crate::filesystem::strerror(code)
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
        let path = path(&args.path, vm)?;
        let table = table(vm);
        let fd = available(&table, vm)?;
        let mode = args.mode & !table.mask.get();
        let snapshot = exchange(
            vm,
            &json!({"op":"python.file.open","path":path,"access":access,"creation":creation,"mode":mode}),
        )?;
        let inode = integer(&snapshot, "inode", vm)?;
        table
            .inodes
            .borrow_mut()
            .retain(|_, inode| inode.strong_count() > 0);
        let existing = table.inodes.borrow().get(&inode).and_then(Weak::upgrade);
        let inode = match existing {
            Some(inode) => inode,
            None => {
                let reference = Rc::new(inode);
                table
                    .inodes
                    .borrow_mut()
                    .insert(inode, Rc::downgrade(&reference));
                reference
            }
        };
        table.entries.borrow_mut().insert(
            fd,
            Descriptor {
                description: Rc::new(RefCell::new(Description {
                    inode,
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
        let table = table(vm);
        let Some(entry) = table.entries.borrow_mut().remove(&fd) else {
            return Err(fault(vm, "EBADF", "Bad file descriptor")?);
        };
        let last = Rc::strong_count(&entry.description) == 1
            && Rc::strong_count(&entry.description.borrow().inode) == 1;
        if last {
            let inode = *entry.description.borrow().inode;
            if let Err(error) = exchange(vm, &json!({"op":"python.file.close","inode":inode})) {
                table.entries.borrow_mut().insert(fd, entry);
                return Err(error);
            }
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
        let (inode, offset) = {
            let state = description.borrow();
            if !state.readable {
                return Err(fault(vm, "EBADF", "Descriptor is not readable")?);
            }
            (*state.inode, state.offset)
        };
        let length = length.min(262_144) as u64;
        let value = exchange(
            vm,
            &json!({"op":"python.file.read", "inode":inode, "offset":offset, "length":length}),
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
        let mut state = description.borrow_mut();
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
        let (inode, offset) = {
            let state = description.borrow();
            if !state.writable {
                return Err(fault(vm, "EBADF", "Descriptor is not writable")?);
            }
            let offset = if state.append {
                None
            } else {
                Some(state.offset)
            };
            (*state.inode, offset)
        };
        if data.is_empty() {
            return Ok(0);
        }
        let length = data.len().min(262144);
        let encoded = data
            .with_ref(|bytes| base64::engine::general_purpose::STANDARD.encode(&bytes[..length]));
        let result = exchange(
            vm,
            &json!({"op":"python.file.write","inode":inode,"offset":offset,"content":encoded}),
        )?;
        let count = integer(&result, "count", vm)?;
        if count > length as u64 {
            return Err(vm.new_runtime_error("Write acknowledgement exceeds submitted bytes"));
        }
        let offset = integer(&result, "offset", vm)?;
        description.borrow_mut().offset = offset;
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
        let inode = {
            let state = description.borrow();
            if !state.writable {
                return Err(fault(vm, "EBADF", "Descriptor is not writable")?);
            }
            *state.inode
        };
        exchange(
            vm,
            &json!({"op":"python.file.resize","inode":inode,"size":size}),
        )?;
        Ok(())
    }
    #[pyfunction]
    fn lseek(fd: i32, offset: i64, whence: i32, vm: &VirtualMachine) -> PyResult<u64> {
        let description = description(fd, vm)?;
        let base = match whence {
            SEEK_SET => 0,
            SEEK_CUR => description.borrow().offset,
            SEEK_END => integer(&refresh(&description, vm)?, "size", vm)?,
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
        stat_result(&snapshot, vm)
    }
    fn stat_result(stat: &Value, vm: &VirtualMachine) -> PyResult {
        let size = integer(stat, "size", vm)?;
        let atime = timestamp(stat, "atimeNs", vm)?;
        let mtime = timestamp(stat, "mtimeNs", vm)?;
        let ctime = timestamp(stat, "ctimeNs", vm)?;
        let kind = match text(stat, "kind", vm)? {
            "file" => 0o100000,
            "directory" => 0o040000,
            "symlink" => 0o120000,
            _ => return Err(vm.new_runtime_error("Filesystem metadata has invalid kind")),
        };
        Ok(StatResultData {
            st_mode: kind | integer(stat, "mode", vm)?,
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
