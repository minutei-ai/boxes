#[repr(C)]
struct Io {
    pointer: *const u8,
    length: u32,
}

#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_exec_v2(
        path: *const u8,
        length: u32,
        argv: *const u8,
        argv_length: u32,
        env: *const u8,
        env_length: u32,
        closed: *const u32,
        closed_length: u32,
        cwd: *const u8,
        cwd_length: u32,
    ) -> u32;
    fn proc_fexec_v2(
        fd: u32,
        argv: *const u8,
        argv_length: u32,
        env: *const u8,
        env_length: u32,
        closed: *const u32,
        closed_length: u32,
        cwd: *const u8,
        cwd_length: u32,
    ) -> u32;
    fn proc_exec(
        path: *const u8,
        length: u32,
        argv: *const u8,
        argv_length: u32,
        env: *const u8,
        env_length: u32,
        closed: *const u32,
        closed_length: u32,
    ) -> u32;
    fn proc_getpid(pid: *mut u32) -> u32;
}

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn args_sizes_get(count: *mut u32, size: *mut u32) -> u32;
    fn args_get(arguments: *mut *const u8, data: *mut u8) -> u32;
    fn environ_sizes_get(count: *mut u32, size: *mut u32) -> u32;
    fn environ_get(entries: *mut *const u8, data: *mut u8) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, count: u32, written: *mut u32) -> u32;
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        length: u32,
        flags: u32,
        rights: u64,
        inheriting: u64,
        fdflags: u32,
        output: *mut u32,
    ) -> u32;
}

fn output(text: &str) -> bool {
    let mut written = 0;
    let io = Io {
        pointer: text.as_ptr(),
        length: text.len() as u32,
    };
    unsafe { fd_write(1, &io, 1, &mut written) == 0 && written == io.length }
}

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut count = 0;
        let mut size = 0;
        if args_sizes_get(&mut count, &mut size) != 0 || count > 4 || size > 4096 {
            return 90;
        }
        let mut args = [std::ptr::null(); 4];
        let mut data = vec![0u8; size as usize];
        if args_get(args.as_mut_ptr(), data.as_mut_ptr()) != 0 || count < 2 {
            return 91;
        }
        let mode = std::ffi::CStr::from_ptr(args[1].cast()).to_bytes();
        let env = b"PWD=/tmp/spoof\0";
        let argv = b"script\0hello\0";
        if mode.starts_with(b"/") {
            let mut pid = 0;
            if proc_getpid(&mut pid) != 0 || pid != 1 {
                return 92;
            }
            if environ_sizes_get(&mut count, &mut size) != 0 || count > 128 || size > 65536 {
                return 93;
            }
            let mut entries = vec![std::ptr::null(); count as usize];
            let mut data = vec![0u8; size as usize];
            if environ_get(entries.as_mut_ptr(), data.as_mut_ptr()) != 0 {
                return 94;
            }
            let pwd = entries.iter().find_map(|entry| {
                std::ffi::CStr::from_ptr(entry.cast())
                    .to_bytes()
                    .strip_prefix(b"PWD=")
            });
            return match pwd.and_then(|pwd| std::str::from_utf8(pwd).ok()) {
                Some(pwd) if output(&format!("{}|{}\n", pwd, pid)) => 0,
                _ => 95,
            };
        }
        if mode == b"chain-target" {
            let path = b"./script";
            return proc_exec(
                path.as_ptr(),
                path.len() as u32,
                argv.as_ptr(),
                argv.len() as u32,
                env.as_ptr(),
                env.len() as u32,
                std::ptr::null(),
                0,
            ) as i32;
        }
        let cwd: &[u8] = match mode {
            b"symlink" => b"/tmp/link",
            b"missing" | b"fexec-missing" => b"/tmp/missing",
            b"file" => b"/root-script",
            b"denied" => b"/tmp/denied",
            b"relative" | b"fexec-relative" => b"tmp/context",
            b"empty" => b"",
            b"nul" => b"/tmp/context\0",
            b"utf8" => b"/tmp/\xff",
            _ => b"/tmp/context",
        };
        let long = vec![b'/'; 4097];
        let (cwd, length) = match mode {
            b"long" => (long.as_ptr(), long.len() as u32),
            b"badptr" => (u32::MAX as *const u8, 2),
            _ => (cwd.as_ptr(), cwd.len() as u32),
        };
        let path: &[u8] = match mode {
            b"chain" => b"./probe.wasm",
            b"badimage" => b"./broken",
            b"invalidmodule" => b"./invalid.wasm",
            _ => b"./script",
        };
        let argv: &[u8] = match mode {
            b"chain" => b"probe\0chain-target\0",
            _ => argv,
        };
        let errno = if mode.starts_with(b"fexec") {
            let mut fd = 0;
            let path = b"tmp/context/script";
            let errno = path_open(
                3,
                1,
                path.as_ptr(),
                path.len() as u32,
                0,
                (1 << 1) | (1 << 2) | (1 << 5) | (1 << 21),
                0,
                0,
                &mut fd,
            );
            if errno != 0 {
                return errno as i32;
            }
            let fd = if mode == b"fexec-badfd" { 999 } else { fd };
            proc_fexec_v2(
                fd,
                argv.as_ptr(),
                argv.len() as u32,
                env.as_ptr(),
                env.len() as u32,
                std::ptr::null(),
                0,
                cwd,
                length,
            )
        } else {
            proc_exec_v2(
                path.as_ptr(),
                path.len() as u32,
                argv.as_ptr(),
                argv.len() as u32,
                env.as_ptr(),
                env.len() as u32,
                std::ptr::null(),
                0,
                cwd,
                length,
            )
        };
        if !output(&format!("errno={}\n", errno)) {
            return 96;
        }
        let path = b"./root-script";
        proc_exec(
            path.as_ptr(),
            path.len() as u32,
            argv.as_ptr(),
            argv.len() as u32,
            env.as_ptr(),
            env.len() as u32,
            std::ptr::null(),
            0,
        ) as i32
    }
}
