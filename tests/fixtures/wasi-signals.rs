#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_kill(pid: u32, signal: u32) -> u32;
    fn proc_waitpid_v3(pid: u32, options: u32, status: *mut u32, waited: *mut u32) -> u32;
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
    fn poll_oneoff(input: *const u8, output: *mut u8, count: u32, ready: *mut u32) -> u32;
    fn clock_time_get(clock: u32, precision: u64, output: *mut u64) -> u32;
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
    case = "child-inherited",
    case = "child-stopself",
    case = "child-maskstop",
    case = "child-clock"
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
        if cfg!(case = "child-maskstop") {
            let mut lo = 0;
            let mut hi = 0;
            if proc_signal_mask_v2(0, (1 << 19) | (1 << 18), 0, &mut lo, &mut hi) != 0 {
                proc_exit(47);
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
        if cfg!(case = "child-stopself") {
            if proc_kill(0, 19) != 0 {
                proc_exit(48);
            }
        }
        if cfg!(case = "child-clock") {
            let mut subscription = [0u8; 48];
            subscription[24..32].copy_from_slice(&250_000_000u64.to_le_bytes());
            let mut events = [0u8; 32];
            let mut ready = 0;
            if poll_oneoff(subscription.as_ptr(), events.as_mut_ptr(), 1, &mut ready) != 0
                || ready != 1
            {
                proc_exit(49);
            }
            proc_exit(45);
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
    case = "child-inherited",
    case = "child-stopself",
    case = "child-maskstop",
    case = "child-clock"
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
        if cfg!(case = "self-pause") {
            let mut marker = *b"paused\n";
            let io = Io {
                pointer: marker.as_mut_ptr(),
                length: 7,
            };
            let mut count = 0;
            if fd_write(1, &io, 1, &mut count) != 0 {
                return 38;
            }
            proc_kill(0, 19);
            return 99;
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
            if cfg!(case = "stop-zero") { 0 } else { 2 },
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
        if cfg!(case = "stop")
            || cfg!(case = "tstp")
            || cfg!(case = "stop-kill")
            || cfg!(case = "stop-term")
            || cfg!(case = "self-stop")
            || cfg!(case = "stop-masked")
            || cfg!(case = "stop-group")
            || cfg!(case = "stop-zero")
            || cfg!(case = "stop-clock")
        {
            let selector = if cfg!(case = "stop-group") {
                (-2i32) as u32
            } else if cfg!(case = "stop-zero") {
                0
            } else {
                pid
            };
            let mut status = 91;
            let mut waited = 91;
            if cfg!(case = "stop-masked") {
                if proc_kill(pid, 20) != 0
                    || proc_waitpid_v3(selector, 3, &mut status, &mut waited) != 0
                    || status != 0
                    || waited != 0
                {
                    return 20;
                }
            }
            let stopped_signal = if cfg!(case = "tstp") { 20 } else { 19 };
            if !cfg!(case = "self-stop") && proc_kill(pid, stopped_signal) != 0 {
                return 21;
            }
            if proc_waitpid_v3(selector, 16, &mut status, &mut waited) != 28
                || proc_waitpid_v3(selector, 2, u32::MAX as *mut u32, &mut waited) != 21
            {
                return 22;
            }
            if proc_waitpid_v3(selector, 2, &mut status, &mut waited) != 0
                || status != (stopped_signal << 8) | 0x7f
                || waited != pid
                || proc_kill(pid, 0) != 0
            {
                return 23;
            }
            if proc_waitpid_v3(selector, 3, &mut status, &mut waited) != 0
                || status != 0
                || waited != 0
            {
                return 24;
            }
            if cfg!(case = "stop-term") && proc_kill(pid, 15) != 0 {
                return 25;
            }
            let mut byte = [b'X'];
            let io = Io {
                pointer: byte.as_mut_ptr(),
                length: 1,
            };
            if fd_write(writer, &io, 1, &mut count) != 0 || count != 1 {
                return 26;
            }
            if proc_waitpid_v3(selector, 1, &mut status, &mut waited) != 0
                || status != 0
                || waited != 0
            {
                return 27;
            }
            if cfg!(case = "stop-clock") {
                let mut subscription = [0u8; 48];
                subscription[24..32].copy_from_slice(&500_000_000u64.to_le_bytes());
                let mut events = [0u8; 32];
                let mut ready = 0;
                if poll_oneoff(subscription.as_ptr(), events.as_mut_ptr(), 1, &mut ready) != 0
                    || ready != 1
                {
                    return 35;
                }
            }
            let mut resumed_at = 0;
            if clock_time_get(0, 0, &mut resumed_at) != 0 {
                return 36;
            }
            if cfg!(case = "stop-kill") {
                if proc_kill(pid, 9) != 0 {
                    return 28;
                }
            } else {
                if proc_kill(pid, 18) != 0
                    || proc_waitpid_v3(selector, 8, &mut status, &mut waited) != 0
                    || status != 0xffff
                    || waited != pid
                {
                    return 29;
                }
            }
            if proc_waitpid_v3(selector, 0, &mut status, &mut waited) != 0 || waited != pid {
                return 30;
            }
            if cfg!(case = "stop-clock") {
                let mut finished_at = 0;
                if clock_time_get(0, 0, &mut finished_at) != 0
                    || finished_at.saturating_sub(resumed_at) > 100_000_000
                {
                    return 37;
                }
            }
            let expected = if cfg!(case = "stop-kill") {
                9
            } else if cfg!(case = "stop-term") {
                15
            } else {
                45 << 8
            };
            if status != expected || proc_waitpid_v3(selector, 1, &mut status, &mut waited) != 12 {
                return 31;
            }
            if !cfg!(case = "stop-kill") && !cfg!(case = "stop-term") && !cfg!(case = "stop-clock")
            {
                let mut data = [0u8; 7];
                let io = Io {
                    pointer: data.as_mut_ptr(),
                    length: 7,
                };
                if fd_read(reply_reader, &io, 1, &mut count) != 0
                    || count != 7
                    || data != *b"escaped"
                {
                    return 32;
                }
            }
            let mut data = [0u8];
            let io = Io {
                pointer: data.as_mut_ptr(),
                length: 1,
            };
            if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 0 {
                return 33;
            }
            let mut marker = *b"resumed\n";
            let io = Io {
                pointer: marker.as_mut_ptr(),
                length: 8,
            };
            if fd_write(1, &io, 1, &mut count) != 0 {
                return 34;
            }
            return 0;
        }
        let mut code = 91;
        let mut signal = 91;
        let mut waited = 91;
        let mut core = 91;
        if !cfg!(case = "natural") {
            if proc_kill(pid, 0) != 0 || proc_kill(pid, 28) != 0 {
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
