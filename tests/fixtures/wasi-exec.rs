#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}
#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_spawn_v3(
        path: *const u8,
        len: u32,
        argv: *const u8,
        argc: u32,
        env: *const u8,
        envlen: u32,
        actions: *const u8,
        actionlen: u32,
        cwd: *const u8,
        cwdlen: u32,
        flags: u32,
        defaultlo: u32,
        defaulthi: u32,
        masklo: u32,
        maskhi: u32,
        group: u32,
        pid: *mut u32,
    ) -> u32;
    fn proc_waitpid_v2(
        pid: u32,
        options: u32,
        code: *mut u32,
        signal: *mut u32,
        waited: *mut u32,
        core: *mut u32,
    ) -> u32;
    fn proc_exec(
        path: *const u8,
        len: u32,
        argv: *const u8,
        argc: u32,
        env: *const u8,
        envlen: u32,
        closed: *const u32,
        count: u32,
    ) -> u32;
    fn proc_fexec(
        fd: u32,
        argv: *const u8,
        argc: u32,
        env: *const u8,
        envlen: u32,
        closed: *const u32,
        count: u32,
    ) -> u32;
    fn proc_getpid(pid: *mut u32) -> u32;
    fn proc_kill(pid: u32, signal: u32) -> u32;
    fn proc_sigaction(signal: u32, action: u32, lo: u32, hi: u32, flags: u32) -> u32;
    fn proc_signal_mask_v2(how: u32, lo: u32, hi: u32, old: *mut u32, high: *mut u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
    fn fd_setfd(fd: u32, flags: u32) -> u32;
    fn fd_getfd(fd: u32, flags: *mut u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn proc_exit(code: u32);
    fn fd_close(fd: u32) -> u32;
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        len: u32,
        flags: u32,
        rights: u64,
        inherit: u64,
        fdflags: u32,
        out: *mut u32,
    ) -> u32;
    fn fd_read(fd: u32, v: *const Io, n: u32, out: *mut u32) -> u32;
    fn fd_write(fd: u32, v: *const Io, n: u32, out: *mut u32) -> u32;
    fn args_sizes_get(n: *mut u32, size: *mut u32) -> u32;
    fn args_get(argv: *mut *mut u8, buffer: *mut u8) -> u32;
    fn environ_sizes_get(n: *mut u32, size: *mut u32) -> u32;
    fn fd_seek(fd: u32, offset: i64, whence: u32, out: *mut u64) -> u32;
}
unsafe fn read(fd: u32) -> Result<u8, u32> {
    let mut byte = [0];
    let v = Io {
        pointer: byte.as_mut_ptr(),
        length: 1,
    };
    let mut n = 0;
    let status = unsafe { fd_read(fd, &v, 1, &mut n) };
    if status != 0 {
        return Err(status);
    }
    if n != 1 {
        return Err(99);
    }
    Ok(byte[0])
}
#[unsafe(no_mangle)]
pub extern "C" fn __wasi_signal_trampoline(_: i32) {}
#[unsafe(no_mangle)]
pub extern "C" fn bootstrap() {
    unsafe {
        let path = b"tmp/data";
        let mut fd = 0;
        if path_open(3, 1, path.as_ptr(), path.len() as u32, 0, 38, 0, 0, &mut fd) != 0
            || read(fd) != Ok(b'A')
        {
            proc_exit(35);
        }
        fd_close(fd);
        let mut marker = [b'Z'];
        let v = Io {
            pointer: marker.as_mut_ptr(),
            length: 1,
        };
        let mut written = 0;
        fd_write(1, &v, 1, &mut written);
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn bootstrap_trap() {
    bootstrap();
    unsafe {
        let path = b"tmp/data";
        let mut fd = 0;
        if path_open(3, 1, path.as_ptr(), path.len() as u32, 0, 38, 0, 0, &mut fd) != 0 {
            proc_exit(36);
        }
        fd_close(fd);
    }
    std::arch::wasm32::unreachable();
}
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        if cfg!(case = "leaf") {
            proc_exit(7);
            return 0;
        }
        if cfg!(case = "child") {
            let path = b"/tmp/parent.wasm";
            let cwd = b"/tmp";
            let mut pid = 0;
            if proc_spawn_v3(
                path.as_ptr(),
                path.len() as u32,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                cwd.as_ptr(),
                cwd.len() as u32,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut pid,
            ) != 0
                || pid != 2
            {
                return 40;
            }
            let mut code = 91;
            let mut signal = 91;
            let mut waited = 91;
            let mut core = 91;
            if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
                || code != 0
                || signal != 0
                || waited != pid
            {
                return 41;
            }
            return 0;
        }
        if cfg!(case = "image") {
            let mut pid = 0;
            let mut lo = 0;
            let mut hi = 0;
            let mut n = 0;
            let mut size = 0;
            if proc_getpid(&mut pid) != 0
                || proc_signal_mask_v2(3, 0, 0, &mut lo, &mut hi) != 0
                || lo != 2
                || hi != 0
            {
                return 10;
            }
            if proc_kill(pid, 12) != 0 {
                return 11;
            }
            if args_sizes_get(&mut n, &mut size) != 0 || n != 2 {
                return 12;
            }
            let mut argv = [std::ptr::null_mut(); 2];
            let mut buffer = [0; 64];
            if args_get(argv.as_mut_ptr(), buffer.as_mut_ptr()) != 0 || &buffer[..5] != b"kept\0" {
                return 13;
            }
            if environ_sizes_get(&mut n, &mut size) != 0 || n != 2 {
                return 14;
            }
            let mut flags = 91;
            if fd_getfd(5, &mut flags) != 8 || fd_getfd(6, &mut flags) != 8 {
                return 15;
            }
            if *argv[1] == b'l' && *argv[1].add(4) < b'I' {
                let mut offset = 0;
                if fd_seek(4, 0, 1, &mut offset) != 0 || offset != 1 {
                    return 33;
                }
                let mut next = *b"kept\0loop0\0";
                next[9] = *argv[1].add(4) + 1;
                let path = b"/tmp/next.wasm";
                let env = b"COLOR=blue\0";
                proc_exec(
                    path.as_ptr(),
                    path.len() as u32,
                    next.as_ptr(),
                    next.len() as u32,
                    env.as_ptr(),
                    env.len() as u32,
                    std::ptr::null(),
                    0,
                );
                return 34;
            }
            if read(4) != Ok(b'B') {
                return 16;
            }
            let mut message = [b'0' + pid as u8, b'B'];
            let v = Io {
                pointer: message.as_mut_ptr(),
                length: 2,
            };
            let mut written = 0;
            if fd_write(1, &v, 1, &mut written) != 0 || written != 2 {
                return 17;
            }
            if *argv[1] == b'f' {
                let mut offset = 0;
                if fd_seek(12, 0, 1, &mut offset) != 0 || offset != 2 {
                    return 30;
                }
            }
            if *argv[1] == b'c' {
                let mut code = 91;
                let mut signal = 91;
                let mut waited = 91;
                let mut core = 91;
                if proc_waitpid_v2(2, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
                    || code != 7
                    || signal != 0
                    || waited != 2
                {
                    return 31;
                }
            }
            if *argv[1] == b's' {
                proc_kill(pid, 10);
                return 18;
            }
            if *argv[1] == b'p' {
                proc_signal_mask_v2(1, 2, 0, &mut lo, &mut hi);
                return 19;
            }
            7
        } else {
            let mut fd = 0;
            let path = b"tmp/data";
            if path_open(3, 1, path.as_ptr(), path.len() as u32, 0, 38, 0, 0, &mut fd) != 0
                || fd != 4
            {
                return 20;
            }
            if read(4) != Ok(b'A')
                || fd_dup2(4, 5) != 0
                || fd_dup2(4, 6) != 0
                || fd_setfd(6, 1) != 0
            {
                return 21;
            }
            let mut lo = 0;
            let mut hi = 0;
            if proc_sigaction(12, 1, 0, 0, 0) != 0
                || proc_sigaction(10, 2, 0, 0, 0) != 0
                || proc_signal_mask_v2(2, 2, 0, &mut lo, &mut hi) != 0
            {
                return 22;
            }
            if cfg!(case = "pending") && proc_kill(0, 2) != 0 {
                return 23;
            }
            if cfg!(case = "children") {
                let path = b"/tmp/leaf.wasm";
                let mut pid = 0;
                if proc_spawn_v3(
                    path.as_ptr(),
                    path.len() as u32,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    &mut pid,
                ) != 0
                    || pid != 2
                {
                    return 32;
                }
            }
            let argv = if cfg!(case = "loop") {
                b"kept\0loop0\0".as_slice()
            } else if cfg!(case = "children") {
                b"kept\0children\0".as_slice()
            } else if cfg!(case = "fexec") {
                b"kept\0fexec\0".as_slice()
            } else if cfg!(case = "signal") {
                b"kept\0signal\0".as_slice()
            } else if cfg!(case = "pending") {
                b"kept\0pending\0".as_slice()
            } else {
                b"kept\0normal\0".as_slice()
            };
            let env = b"COLOR=blue\0";
            let closed = [5u32];
            let image = if cfg!(case = "start") {
                b"/tmp/start.wasm".as_slice()
            } else if cfg!(case = "start-trap") {
                b"/tmp/start-trap.wasm".as_slice()
            } else if cfg!(case = "missing") {
                b"/tmp/absent".as_slice()
            } else if cfg!(case = "invalid") {
                b"/tmp/invalid".as_slice()
            } else if cfg!(case = "denied") {
                b"/tmp/data".as_slice()
            } else {
                b"/tmp/next.wasm".as_slice()
            };
            let status = if cfg!(case = "fexec") {
                let path = b"tmp/next.wasm";
                let mut executable = 0;
                if path_open(
                    3,
                    1,
                    path.as_ptr(),
                    path.len() as u32,
                    0,
                    38,
                    0,
                    0,
                    &mut executable,
                ) != 0
                    || fd_dup2(executable, 12) != 0
                {
                    return 24;
                }
                let mut offset = 0;
                if fd_seek(12, 2, 0, &mut offset) != 0 {
                    return 25;
                }
                proc_fexec(
                    12,
                    argv.as_ptr(),
                    argv.len() as u32,
                    env.as_ptr(),
                    env.len() as u32,
                    closed.as_ptr(),
                    1,
                )
            } else if cfg!(case = "badfd") {
                proc_fexec(
                    91,
                    argv.as_ptr(),
                    argv.len() as u32,
                    env.as_ptr(),
                    env.len() as u32,
                    closed.as_ptr(),
                    1,
                )
            } else {
                proc_exec(
                    image.as_ptr(),
                    image.len() as u32,
                    argv.as_ptr(),
                    argv.len() as u32,
                    env.as_ptr(),
                    env.len() as u32,
                    closed.as_ptr(),
                    1,
                )
            };
            if status == 0 {
                return 99;
            }
            let mut flags = 0;
            if read(5) != Ok(b'B') || fd_getfd(6, &mut flags) != 0 || flags != 1 {
                return 26;
            }
            status as i32
        }
    }
}
