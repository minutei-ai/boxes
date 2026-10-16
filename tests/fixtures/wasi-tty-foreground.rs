#[link(wasm_import_module = "host_tty")]
unsafe extern "C" {
    fn get_foreground(fd: u32, group: *mut u32) -> u32;
    fn set_foreground(fd: u32, group: u32) -> u32;
    fn get_size(fd: u32, cols: *mut u16, rows: *mut u16) -> u32;
    fn read(pointer: *mut u8, length: u32, timeout: u32) -> u32;
}
#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn pty_open(master: *mut u32, slave: *mut u32) -> u32;
    fn fd_dup(fd: u32, output: *mut u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
    fn proc_sigaction(signal: u32, action: u32, lo: u32, hi: u32, flags: u32) -> u32;
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
        defaults_lo: u32,
        defaults_hi: u32,
        mask_lo: u32,
        mask_hi: u32,
        group: u32,
        pid: *mut u32,
    ) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_write(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn proc_exit(code: u32) -> !;
}
#[repr(C)]
struct Io {
    pointer: *const u8,
    length: u32,
}

fn send(fd: u32, data: &[u8]) {
    let io = Io {
        pointer: data.as_ptr(),
        length: data.len() as u32,
    };
    let mut count = 0;
    unsafe {
        if fd_write(fd, &io, 1, &mut count) != 0 || count != data.len() as u32 {
            proc_exit(80);
        }
    }
}
static mut INTERRUPTS: u32 = 0;
#[unsafe(no_mangle)]
pub extern "C" fn __wasi_signal_trampoline(signal: u32) {
    unsafe {
        if signal == 2 {
            INTERRUPTS += 1;
            send(1, b"interrupt\n");
        } else if cfg!(case = "child") && signal == 28 {
            let mut cols = 0;
            let mut rows = 0;
            if get_size(0, &mut cols, &mut rows) != 0 || cols != 120 || rows != 40 {
                proc_exit(81);
            }
            send(1, b"winch\n");
        } else {
            proc_exit(82);
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let mut group = 91;
        if cfg!(case = "pair") {
            let mut master = 0;
            let mut slave = 0;
            if pty_open(&mut master, &mut slave) != 0
                || get_foreground(master, &mut group) != 0
                || group != 0
                || set_foreground(slave, 1) != 0
                || get_foreground(master, &mut group) != 0
                || group != 1
                || fd_dup2(slave, 0) != 0
                || proc_sigaction(2, 2, 0, 0, 0) != 0
            {
                proc_exit(83);
            }
            send(master, &[3]);
            let mut byte = 0;
            if read(&mut byte, 1, u32::MAX) != 0 || INTERRUPTS != 1 {
                proc_exit(84);
            }
            send(1, b"pair-done\n");
            proc_exit(0);
        }
        if cfg!(case = "child") || cfg!(case = "foreign") {
            if cfg!(case = "child") && proc_sigaction(28, 2, 0, 0, 0x10000000) != 0 {
                proc_exit(85);
            }
            if cfg!(case = "child") {
                send(1, b"child-ready\n");
            }
            let mut byte = 0;
            read(&mut byte, 1, u32::MAX);
            proc_exit(86);
        }
        if get_foreground(0, &mut group) != 0
            || group != 1
            || get_foreground(0, u32::MAX as *mut u32) != 21
            || set_foreground(0, 0) != 28
            || set_foreground(0, u32::MAX) != 28
            || set_foreground(0, 999) != 71
            || set_foreground(99, 1) != 8
            || set_foreground(3, 1) != 59
            || get_foreground(99, &mut group) != 8
            || group != 1
            || get_foreground(3, &mut group) != 59
            || group != 1
            || proc_sigaction(2, 2, 0, 0, 0) != 0
            || proc_sigaction(28, 2, 0, 0, 0) != 0
        {
            proc_exit(87);
        }
        let mut alias = 0;
        if fd_dup(0, &mut alias) != 0 {
            proc_exit(88);
        }
        let mut children = [0; 2];
        for (index, (path, flags)) in [
            (b"/tmp/tty-owned.wasm".as_slice(), 2),
            (b"/tmp/tty-foreign.wasm".as_slice(), 128),
        ]
        .iter()
        .enumerate()
        {
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
                0,
                0,
                0,
                0,
                0,
                &mut children[index],
            ) != 0
            {
                proc_exit(89);
            }
        }
        if set_foreground(alias, children[1]) != 63
            || get_foreground(0, &mut group) != 0
            || group != 1
            || set_foreground(alias, children[0]) != 0
            || get_foreground(1, &mut group) != 0
            || group != children[0]
            || fd_close(alias) != 0
            || get_foreground(alias, &mut group) != 8
            || group != children[0]
        {
            proc_exit(90);
        }
        let mut status = 0;
        let mut waited = 0;
        if proc_kill(children[1], 15) != 0
            || proc_waitpid_v3(children[1], 0, &mut status, &mut waited) != 0
            || status != 15
            || waited != children[1]
        {
            proc_exit(91);
        }
        send(1, b"owned\n");
        if !cfg!(case = "recovery") {
            if proc_waitpid_v3(children[0], 2, &mut status, &mut waited) != 0
                || status != (20 << 8) | 0x7f
                || waited != children[0]
            {
                proc_exit(92);
            }
            send(1, b"stopped\n");
            if set_foreground(0, 1) != 0
                || set_foreground(0, children[0]) != 0
                || proc_kill(children[0], 18) != 0
                || proc_waitpid_v3(children[0], 8, &mut status, &mut waited) != 0
                || status != 0xffff
                || waited != children[0]
            {
                proc_exit(93);
            }
            send(1, b"continued\n");
        }
        if proc_waitpid_v3(children[0], 0, &mut status, &mut waited) != 0
            || status != 2
            || waited != children[0]
            || get_foreground(0, &mut group) != 0
            || group != children[0]
            || set_foreground(0, children[0]) != 71
            || set_foreground(0, 1) != 0
            || get_foreground(2, &mut group) != 0
            || group != 1
            || INTERRUPTS != 0
        {
            proc_exit(94);
        }
        send(1, b"reclaimed\n");
        if !cfg!(case = "recovery") {
            let mut byte = 0;
            if read(&mut byte, 1, u32::MAX) != 0 || INTERRUPTS != 1 {
                proc_exit(95);
            }
        }
        send(1, b"done\n");
        proc_exit(0);
    }
}
