#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn fd_pipe(reader: *mut u32, writer: *mut u32) -> u32;
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
    fn fd_read(fd: u32, vectors: *const Io, count: u32, output: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, count: u32, output: *mut u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn poll_oneoff(input: *const u8, output: *mut u8, count: u32, events: *mut u32) -> u32;
    fn proc_exit(code: u32) -> !;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}

#[cfg(any(case = "child-duplex", case = "child-drain"))]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let mut data = [0u8; 4096];
        let io = Io {
            pointer: data.as_mut_ptr(),
            length: if cfg!(case = "child-duplex") { 5 } else { 4096 },
        };
        let mut count = 0;
        if cfg!(case = "child-duplex") {
            if fd_read(0, &io, 1, &mut count) != 0 || count != 5 || data[..5] != *b"hello" {
                proc_exit(40);
            }
            if fd_write(1, &io, 1, &mut count) != 0 || count != 5 {
                proc_exit(41);
            }
            proc_exit(7);
        }
        let mut total = 0;
        while total < 131072 {
            if fd_read(0, &io, 1, &mut count) != 0
                || count == 0
                || data[..count as usize].iter().any(|byte| *byte != 7)
            {
                proc_exit(42);
            }
            total += count;
        }
        if total != 131072 {
            proc_exit(43);
        }
        let mut marker = *b"drained\n";
        let io = Io {
            pointer: marker.as_mut_ptr(),
            length: 8,
        };
        if fd_write(1, &io, 1, &mut count) != 0 {
            proc_exit(44);
        }
        proc_exit(0);
    }
}

#[cfg(any(case = "parent-duplex", case = "parent-drain", case = "parent-blocked"))]
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut reader = 0;
        let mut writer = 0;
        let mut reply_reader = 0;
        let mut reply_writer = 0;
        if fd_pipe(&mut reader, &mut writer) != 0 {
            return 1;
        }
        if !cfg!(case = "parent-drain") && fd_pipe(&mut reply_reader, &mut reply_writer) != 0 {
            return 2;
        }
        let mut actions = [0u8; 144];
        let mut used = 0usize;
        for (index, (command, fd, source)) in [
            (2u32, 0, reader),
            (2, 1, reply_writer),
            (1, reader, 0),
            (1, writer, 0),
            (1, reply_reader, 0),
            (1, reply_writer, 0),
        ]
        .iter()
        .copied()
        .enumerate()
        {
            if cfg!(case = "parent-drain") && [1, 4, 5].contains(&index) {
                continue;
            }
            actions[used..used + 4].copy_from_slice(&command.to_le_bytes());
            actions[used + 4..used + 8].copy_from_slice(&fd.to_le_bytes());
            actions[used + 8..used + 12].copy_from_slice(&source.to_le_bytes());
            used += 24;
        }
        let path = b"/tmp/pipe-child.wasm";
        let mut pid = 91;
        let status = proc_spawn_v3(
            path.as_ptr(),
            path.len() as u32,
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            actions.as_ptr(),
            used as u32,
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut pid,
        );
        if status != 0 {
            return 500 + status as i32;
        }
        if fd_close(reader) != 0 {
            return 3;
        }
        let mut count = 0;
        if !cfg!(case = "parent-drain") {
            if fd_close(reply_writer) != 0 {
                return 4;
            }
            if cfg!(case = "parent-blocked") {
                let mut marker = *b"blocked family\n";
                let io = Io {
                    pointer: marker.as_mut_ptr(),
                    length: 15,
                };
                if fd_write(1, &io, 1, &mut count) != 0 {
                    return 15;
                }
                let mut reply = [0u8; 5];
                let io = Io {
                    pointer: reply.as_mut_ptr(),
                    length: 5,
                };
                if fd_read(reply_reader, &io, 1, &mut count) == 0 {
                    return 16;
                }
                return 17;
            }
            let mut data = *b"hello";
            let io = Io {
                pointer: data.as_mut_ptr(),
                length: 5,
            };
            if fd_write(writer, &io, 1, &mut count) != 0 || count != 5 {
                return 5;
            }
            let mut subscription = [0u8; 48];
            subscription[..8].copy_from_slice(&777u64.to_le_bytes());
            subscription[8] = 1;
            subscription[16..20].copy_from_slice(&reply_reader.to_le_bytes());
            let mut event = [0u8; 32];
            let mut events = 0;
            if poll_oneoff(subscription.as_ptr(), event.as_mut_ptr(), 1, &mut events) != 0
                || events != 1
                || event[10] != 1
            {
                return 6;
            }
            data.fill(0);
            if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 5 || data != *b"hello" {
                return 7;
            }
            let mut code = 0;
            let mut signal = 0;
            let mut waited = 0;
            let mut core = 0;
            if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
                || code != 7
            {
                return 8;
            }
            if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 0 {
                return 9;
            }
            if fd_write(writer, &io, 1, &mut count) != 64 {
                return 10;
            }
            let mut marker = *b"pipe handshake\n";
            let io = Io {
                pointer: marker.as_mut_ptr(),
                length: 15,
            };
            if fd_write(1, &io, 1, &mut count) != 0 {
                return 11;
            }
            return 0;
        }
        let mut data = [7u8; 131072];
        let mut offset = 0usize;
        while offset < data.len() {
            let io = Io {
                pointer: data.as_mut_ptr().add(offset),
                length: (data.len() - offset) as u32,
            };
            if fd_write(writer, &io, 1, &mut count) != 0 || count == 0 {
                return 12;
            }
            offset += count as usize;
        }
        if fd_close(writer) != 0 {
            return 13;
        }
        let mut code = 91;
        let mut signal = 0;
        let mut waited = 0;
        let mut core = 0;
        if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0 || code != 0
        {
            return 14;
        }
        0
    }
}
