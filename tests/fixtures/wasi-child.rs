use std::convert::TryInto;
#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_getpid(output: *mut u32) -> u32;
    fn proc_getppid(output: *mut u32) -> u32;
    fn proc_signal_mask_v2(how: u32, lo: u32, hi: u32, old_lo: *mut u32, old_hi: *mut u32) -> u32;
    fn proc_spawn_v3(
        path: *const u8,
        path_len: u32,
        argv: *const u8,
        argv_len: u32,
        env: *const u8,
        env_len: u32,
        actions: *const u8,
        actions_len: u32,
        cwd: *const u8,
        cwd_len: u32,
        flags: u32,
        default_lo: u32,
        default_hi: u32,
        mask_lo: u32,
        mask_hi: u32,
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
    fn fd_dup2(fd: u32, to: u32) -> u32;
    fn fd_setfd(fd: u32, flags: u32) -> u32;
    fn fd_getfd(fd: u32, flags: *mut u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn args_sizes_get(count: *mut u32, size: *mut u32) -> u32;
    fn args_get(pointers: *mut u32, data: *mut u8) -> u32;
    fn environ_sizes_get(count: *mut u32, size: *mut u32) -> u32;
    fn environ_get(pointers: *mut u32, data: *mut u8) -> u32;
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        length: u32,
        flags: u32,
        rights: u64,
        inherit: u64,
        fdflags: u32,
        output: *mut u32,
    ) -> u32;
    fn fd_read(fd: u32, vectors: *const Io, count: u32, output: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, count: u32, output: *mut u32) -> u32;
    fn fd_seek(fd: u32, offset: i64, whence: u32, output: *mut u64) -> u32;
    fn fd_tell(fd: u32, output: *mut u64) -> u32;
    fn fd_filestat_get(fd: u32, output: *mut u8) -> u32;
    fn path_rename(
        from_fd: u32,
        from: *const u8,
        from_len: u32,
        to_fd: u32,
        to: *const u8,
        to_len: u32,
    ) -> u32;
    fn proc_exit(code: u32) -> !;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}

#[cfg(any(case = "child", case = "child-rename"))]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let mut pid = 0;
        let mut parent = 0;
        if proc_getpid(&mut pid) != 0 || proc_getppid(&mut parent) != 0 || pid != 2 || parent != 1 {
            proc_exit(40);
        }
        let mut lo = 0;
        let mut hi = 0;
        if proc_signal_mask_v2(3, 0, 0, &mut lo, &mut hi) != 0 || lo != 2 || hi != 0 {
            proc_exit(41);
        }
        let mut count = 0;
        let mut size = 0;
        let mut pointers = [0u32; 3];
        let mut data = [0u8; 32];
        if args_sizes_get(&mut count, &mut size) != 0
            || count != 3
            || size != 16
            || args_get(pointers.as_mut_ptr(), data.as_mut_ptr()) != 0
            || data[..16] != *b"kept argv0\0\0two\0"
        {
            proc_exit(42);
        }
        if environ_sizes_get(&mut count, &mut size) != 0
            || count != 2
            || size != 17
            || environ_get(pointers.as_mut_ptr(), data.as_mut_ptr()) != 0
            || data[..17] != *b"COLOR=blue\0PWD=/\0"
        {
            proc_exit(43);
        }
        let mut flags = 0;
        if fd_getfd(4, &mut flags) != 8 || fd_getfd(9, &mut flags) != 0 || flags != 0 {
            proc_exit(44);
        }
        let mut one = [0u8];
        let io = Io {
            pointer: one.as_mut_ptr(),
            length: 1,
        };
        if fd_read(9, &io, 1, &mut count) != 0 || count != 1 || one[0] != b'c' {
            proc_exit(45);
        }
        one[0] = b'X';
        if fd_write(9, &io, 1, &mut count) != 0 || count != 1 {
            proc_exit(46);
        }
        if cfg!(case = "child-rename") {
            let from = b"tmp/shared";
            let to = b"tmp/moved";
            if path_rename(
                3,
                from.as_ptr(),
                from.len() as u32,
                3,
                to.as_ptr(),
                to.len() as u32,
            ) != 0
            {
                proc_exit(48);
            }
        }
        let mut marker = *b"child\n";
        let io = Io {
            pointer: marker.as_mut_ptr(),
            length: 6,
        };
        if fd_write(1, &io, 1, &mut count) != 0 {
            proc_exit(47);
        }
        proc_exit(7);
    }
}

#[cfg(not(any(case = "child", case = "child-rename")))]
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut pid = 0;
        let mut parent = 9;
        if proc_getpid(&mut pid) != 0 || proc_getppid(&mut parent) != 0 || pid != 1 || parent != 0 {
            return 1;
        }
        if cfg!(case = "denied") {
            let path = b"/tmp/child.wasm";
            let mut child = 91;
            let status = proc_spawn_v3(
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
                &mut child,
            );
            if child != 91 {
                return 99;
            }
            return status as i32;
        }
        let path = b"tmp/shared";
        let mut fd = 0;
        if path_open(
            3,
            1,
            path.as_ptr(),
            path.len() as u32,
            0,
            2 | 4 | 32 | 64 | (1 << 21),
            0,
            0,
            &mut fd,
        ) != 0
            || fd != 4
        {
            return 2;
        }
        let mut offset = 0;
        if fd_seek(fd, 2, 0, &mut offset) != 0 || fd_dup2(fd, 9) != 0 || fd_setfd(fd, 1) != 0 {
            return 3;
        }
        let mut marker = *b"parent\n";
        let io = Io {
            pointer: marker.as_mut_ptr(),
            length: 7,
        };
        let mut count = 0;
        if fd_write(1, &io, 1, &mut count) != 0 {
            return 4;
        }
        let path = b"/tmp/child.wasm";
        let argv = b"kept argv0\0\0two\0";
        let env = b"COLOR=blue\0";
        let mut actions = [0u8; 48];
        actions[..4].copy_from_slice(&2u32.to_le_bytes());
        actions[4..8].copy_from_slice(&10u32.to_le_bytes());
        actions[8..12].copy_from_slice(&9u32.to_le_bytes());
        actions[24..28].copy_from_slice(&1u32.to_le_bytes());
        actions[28..32].copy_from_slice(&10u32.to_le_bytes());
        let mut child = 91;
        let status = proc_spawn_v3(
            path.as_ptr(),
            path.len() as u32,
            argv.as_ptr(),
            argv.len() as u32,
            env.as_ptr(),
            env.len() as u32,
            actions.as_ptr(),
            actions.len() as u32,
            std::ptr::null(),
            0,
            8,
            0,
            0,
            2,
            0,
            0,
            &mut child,
        );
        if status != 0 {
            return 500 + status as i32;
        }
        if child != 2 {
            return 600 + child as i32;
        }
        let mut code = 91;
        let mut signal = 91;
        let mut waited = 91;
        let mut core = 91;
        if proc_waitpid_v2(child, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
            || code != 7
            || signal != 0
            || waited != child
            || core != 0
        {
            return 6;
        }
        if proc_waitpid_v2(child, 0, &mut code, &mut signal, &mut waited, &mut core) != 12 {
            return 7;
        }
        let mut flags = 0;
        if fd_tell(fd, &mut offset) != 0
            || offset != 4
            || fd_getfd(fd, &mut flags) != 0
            || flags != 1
        {
            return 8;
        }
        let mut stat = [0u8; 64];
        if fd_filestat_get(fd, stat.as_mut_ptr()) != 0
            || u64::from_le_bytes(stat[32..40].try_into().unwrap()) != 4
        {
            return 10;
        }
        let mut marker = *b"waited\n";
        let io = Io {
            pointer: marker.as_mut_ptr(),
            length: 7,
        };
        if fd_write(1, &io, 1, &mut count) != 0 {
            return 9;
        }
        0
    }
}
