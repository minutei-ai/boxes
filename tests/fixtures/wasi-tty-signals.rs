#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_sigaction(signal: u32, action: u32, lo: u32, hi: u32, flags: u32) -> u32;
    fn proc_signal_mask_v2(how: u32, lo: u32, hi: u32, old_lo: *mut u32, old_hi: *mut u32) -> u32;
    fn proc_getpgid(pid: u32, group: *mut u32) -> u32;
    fn proc_kill(pid: u32, signal: u32) -> u32;
    fn proc_waitpid_v3(pid: u32, options: u32, status: *mut u32, waited: *mut u32) -> u32;
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
}
#[link(wasm_import_module = "host_tty")]
unsafe extern "C" {
    fn read(pointer: *mut u8, length: u32, timeout: u32) -> u32;
    fn set_raw_mode(enabled: u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_write(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
    fn proc_exit(code: u32) -> !;
}
#[repr(C)]
struct Io {
    pointer: *const u8,
    length: u32,
}

fn send(data: &[u8]) {
    let io = Io {
        pointer: data.as_ptr(),
        length: data.len() as u32,
    };
    let mut count = 0;
    unsafe {
        if fd_write(1, &io, 1, &mut count) != 0 || count != data.len() as u32 {
            proc_exit(80);
        }
    }
}

static mut SIGNALS: u32 = 0;
#[unsafe(no_mangle)]
pub extern "C" fn __wasi_signal_trampoline(signal: u32) {
    unsafe {
        SIGNALS |= 1 << (signal - 1);
    }
    match signal {
        2 => send(b"interrupt\n"),
        3 => send(b"quit\n"),
        20 => send(b"suspend\n"),
        _ => unsafe {
            proc_exit(81);
        },
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        if cfg!(case = "child") {
            let mut group = 0;
            if proc_getpgid(0, &mut group) != 0 {
                proc_exit(82);
            }
            if group == 1 {
                send(b"fg-ready\n");
            } else {
                send(b"bg-ready\n");
            }
            let mut byte = 0;
            read(&mut byte, 1, u32::MAX);
            proc_exit(83);
        }
        if cfg!(case = "family") {
            for signal in [2, 20] {
                if proc_sigaction(signal, 1, 0, 0, 0) != 0 {
                    proc_exit(84);
                }
            }
            let path = b"/tmp/tty-child.wasm";
            let mut children = [0; 2];
            for (index, flags) in [4, 6].iter().enumerate() {
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
                    *flags,
                    (1 << 1) | (1 << 19),
                    0,
                    0,
                    0,
                    0,
                    &mut children[index],
                ) != 0
                {
                    proc_exit(85);
                }
            }
            let mut status = 0;
            let mut waited = 0;
            if proc_waitpid_v3(children[0], 2, &mut status, &mut waited) != 0
                || status != (20 << 8) | 0x7f
                || waited != children[0]
            {
                proc_exit(86);
            }
            if proc_waitpid_v3(children[1], 3, &mut status, &mut waited) != 0
                || waited != 0
                || status != 0
            {
                proc_exit(87);
            }
            send(b"stopped\n");
            if proc_kill(children[0], 18) != 0
                || proc_waitpid_v3(children[0], 8, &mut status, &mut waited) != 0
                || status != 0xffff
                || waited != children[0]
            {
                proc_exit(88);
            }
            send(b"continued\n");
            if proc_waitpid_v3(children[0], 0, &mut status, &mut waited) != 0
                || status != 2
                || waited != children[0]
            {
                proc_exit(89);
            }
            if proc_waitpid_v3(children[1], 1, &mut status, &mut waited) != 0
                || waited != 0
                || status != 0
            {
                proc_exit(90);
            }
            if proc_kill(children[1], 15) != 0
                || proc_waitpid_v3(children[1], 0, &mut status, &mut waited) != 0
                || status != 15
                || waited != children[1]
            {
                proc_exit(91);
            }
            send(b"family-done\n");
            proc_exit(0);
        }
        if cfg!(case = "raw") && set_raw_mode(1) != 0 {
            proc_exit(92);
        }
        if !cfg!(case = "default-int") && !cfg!(case = "default-quit") {
            let action = if cfg!(case = "ignored") { 1 } else { 2 };
            let flags = if cfg!(case = "restart") {
                0x10000000
            } else {
                0
            };
            for signal in [2, 3, 20] {
                if proc_sigaction(signal, action, 0, 0, flags) != 0 {
                    proc_exit(93);
                }
            }
        }
        if cfg!(case = "masked") {
            let mut lo = 0;
            let mut hi = 0;
            if proc_signal_mask_v2(0, (1 << 1) | (1 << 2) | (1 << 19), 0, &mut lo, &mut hi) != 0 {
                proc_exit(94);
            }
        }
        send(b"ready\n");
        let mut data = [0u8; 32];
        if cfg!(case = "recovery") {
            if read(data.as_mut_ptr(), 32, u32::MAX) != 0 || SIGNALS != 1 << 1 {
                proc_exit(95);
            }
        }
        if cfg!(case = "handled") {
            for expected in [1 << 1, (1 << 1) | (1 << 2), (1 << 1) | (1 << 2) | (1 << 19)] {
                if read(data.as_mut_ptr(), 32, u32::MAX) != 0 || SIGNALS != expected {
                    proc_exit(95);
                }
            }
        }
        let count = read(data.as_mut_ptr(), 32, u32::MAX);
        if cfg!(case = "raw") {
            if count != 4 || data[..4] != [3, 28, 26, 255] || SIGNALS != 0 {
                proc_exit(96);
            }
            send(&data[..4]);
        } else {
            if count != 5 || &data[..5] != b"kept\n" {
                proc_exit(97);
            }
            if cfg!(case = "masked") {
                if SIGNALS != 0 {
                    proc_exit(98);
                }
                let mut lo = 0;
                let mut hi = 0;
                if proc_signal_mask_v2(1, (1 << 1) | (1 << 2) | (1 << 19), 0, &mut lo, &mut hi) != 0
                {
                    proc_exit(99);
                }
                send(b"unmasked\n");
            }
            let expected = if cfg!(case = "ignored") {
                0
            } else if cfg!(case = "recovery") {
                1 << 1
            } else {
                (1 << 1) | (1 << 2) | (1 << 19)
            };
            if SIGNALS != expected {
                proc_exit(100);
            }
        }
        send(b"done\n");
        proc_exit(0);
    }
}
