#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_kill(pid: u32, signal: u32) -> u32;
    fn fd_pipe(reader: *mut u32, writer: *mut u32) -> u32;
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
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_close(fd: u32) -> u32;
    fn fd_read(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn proc_exit(code: u32) -> !;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}
#[cfg(any(
    case = "child",
    case = "child-masked",
    case = "child-unmask",
    case = "child-natural",
    case = "child-wait",
    case = "child-inherited"
))]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        if cfg!(case = "child-wait") {
            let path = b"/tmp/signal-grandchild.wasm";
            let mut pid = 91;
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
                || pid != 3
            {
                proc_exit(40);
            }
            let mut code = 91;
            let mut signal = 91;
            let mut waited = 91;
            let mut core = 91;
            proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core);
            proc_exit(41);
        }
        if cfg!(case = "child-inherited") {
            let mut lo = 91;
            let mut hi = 91;
            if proc_signal_mask_v2(3, 0, 0, &mut lo, &mut hi) != 0 || lo != 1 << 14 || hi != 0 {
                proc_exit(46);
            }
        }
        if cfg!(case = "child-masked") || cfg!(case = "child-unmask") {
            let mut lo = 91;
            let mut hi = 91;
            if proc_signal_mask_v2(0, (1 << 14) | (1 << 8), 0, &mut lo, &mut hi) != 0
                || lo != 0
                || hi != 0
            {
                proc_exit(42);
            }
        }
        let mut ready = *b"ready";
        let io = Io {
            pointer: ready.as_mut_ptr(),
            length: 5,
        };
        let mut count = 0;
        if fd_write(1, &io, 1, &mut count) != 0 || count != 5 {
            proc_exit(43);
        }
        if cfg!(case = "child-natural") {
            proc_exit(137);
        }
        let mut byte = [0u8];
        let io = Io {
            pointer: byte.as_mut_ptr(),
            length: 1,
        };
        if fd_read(0, &io, 1, &mut count) != 0 {
            proc_exit(44);
        }
        if cfg!(case = "child-unmask") {
            let mut lo = 0;
            let mut hi = 0;
            proc_signal_mask_v2(1, 1 << 14, 0, &mut lo, &mut hi);
        }
        let mut escaped = *b"escaped";
        let io = Io {
            pointer: escaped.as_mut_ptr(),
            length: 7,
        };
        fd_write(1, &io, 1, &mut count);
        proc_exit(45);
    }
}
#[cfg(not(any(
    case = "child",
    case = "child-masked",
    case = "child-unmask",
    case = "child-natural",
    case = "child-wait",
    case = "child-inherited"
)))]
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        if proc_kill(99, 0) != 71
            || proc_kill((-99i32) as u32, 0) != 71
            || proc_kill(1, 65) != 28
            || proc_kill(0, 0) != 0
        {
            return 1;
        }
        if cfg!(case = "self") {
            proc_kill(0, 9);
            return 99;
        }
        if cfg!(case = "inherit-mask") {
            let mut lo = 0;
            let mut hi = 0;
            if proc_signal_mask_v2(0, 1 << 14, 0, &mut lo, &mut hi) != 0 {
                return 16;
            }
        }
        let mut reader = 0;
        let mut writer = 0;
        let mut reply_reader = 0;
        let mut reply_writer = 0;
        if fd_pipe(&mut reader, &mut writer) != 0
            || fd_pipe(&mut reply_reader, &mut reply_writer) != 0
        {
            return 2;
        }
        let mut actions = [0u8; 144];
        for (index, (command, fd, source)) in [
            (2u32, 0, reader),
            (2, 1, reply_writer),
            (1, reader, 0),
            (1, writer, 0),
            (1, reply_reader, 0),
            (1, reply_writer, 0),
        ]
        .into_iter()
        .enumerate()
        {
            let offset = index * 24;
            actions[offset..offset + 4].copy_from_slice(&command.to_le_bytes());
            actions[offset + 4..offset + 8].copy_from_slice(&fd.to_le_bytes());
            actions[offset + 8..offset + 12].copy_from_slice(&source.to_le_bytes());
        }
        let path = b"/tmp/signal-child.wasm";
        let mut pid = 91;
        if proc_spawn_v3(
            path.as_ptr(),
            path.len() as u32,
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            actions.as_ptr(),
            actions.len() as u32,
            std::ptr::null(),
            0,
            2,
            0,
            0,
            0,
            0,
            0,
            &mut pid,
        ) != 0
            || pid != 2
        {
            return 3;
        }
        if fd_close(reader) != 0 || fd_close(reply_writer) != 0 {
            return 4;
        }
        let mut ready = [0u8; 5];
        let io = Io {
            pointer: ready.as_mut_ptr(),
            length: 5,
        };
        let mut count = 0;
        if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 5 || ready != *b"ready" {
            return 5;
        }
        let mut code = 91;
        let mut signal = 91;
        let mut waited = 91;
        let mut core = 91;
        if !cfg!(case = "natural") {
            if proc_kill(pid, 0) != 0 || proc_kill(pid, 28) != 0 || proc_kill(pid, 19) != 58 {
                return 6;
            }
            if cfg!(case = "masked") || cfg!(case = "unmask") || cfg!(case = "inherit-mask") {
                if proc_kill(pid, 15) != 0
                    || proc_waitpid_v2(pid, 1, &mut code, &mut signal, &mut waited, &mut core) != 0
                    || waited != 0
                    || code != 0
                    || signal != 0
                {
                    return 7;
                }
            }
            if cfg!(case = "unmask") {
                let mut byte = [b'X'];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                if fd_write(writer, &io, 1, &mut count) != 0 || count != 1 {
                    return 8;
                }
            } else {
                let target = if cfg!(case = "group") {
                    (-2i32) as u32
                } else {
                    pid
                };
                let terminating = if cfg!(case = "group") {
                    15
                } else if cfg!(case = "upper") {
                    64
                } else {
                    9
                };
                if proc_kill(target, terminating) != 0 {
                    return 9;
                }
                if cfg!(case = "wait") && proc_kill(3, 9) != 0 {
                    return 10;
                }
            }
        }
        if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
            || waited != pid
            || core != 0
        {
            return 11;
        }
        let expected_signal = if cfg!(case = "natural") {
            0
        } else if cfg!(case = "group") || cfg!(case = "unmask") {
            15
        } else if cfg!(case = "upper") {
            64
        } else {
            9
        };
        let expected_code = if cfg!(case = "natural") { 137 } else { 0 };
        if code != expected_code || signal != expected_signal || proc_kill(pid, 0) != 71 {
            return 12;
        }
        if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 0 {
            return 13;
        }
        let mut byte = [b'X'];
        let io = Io {
            pointer: byte.as_mut_ptr(),
            length: 1,
        };
        if fd_write(writer, &io, 1, &mut count) != 64 {
            return 14;
        }
        let mut marker = *b"signaled\n";
        let io = Io {
            pointer: marker.as_mut_ptr(),
            length: 9,
        };
        if fd_write(1, &io, 1, &mut count) != 0 {
            return 15;
        }
        0
    }
}
