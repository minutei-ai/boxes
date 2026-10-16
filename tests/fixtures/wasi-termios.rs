#[link(wasm_import_module = "host_tty")]
unsafe extern "C" {
    fn tcgetattr(fd: u32, output: *mut u8) -> u32;
    fn tcsetattr(fd: u32, input: *const u8) -> u32;
    fn set_raw_mode(enabled: u32) -> u32;
    fn set_foreground(fd: u32, group: u32) -> u32;
    fn read(pointer: *mut u8, length: u32, timeout: u32) -> u32;
}
#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn pty_open(master: *mut u32, slave: *mut u32) -> u32;
    fn fd_dup(fd: u32, output: *mut u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
    fn proc_sigaction(signal: u32, action: u32, lo: u32, hi: u32, flags: u32) -> u32;
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
    fn fd_read(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn fd_fdstat_set_flags(fd: u32, flags: u32) -> u32;
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
fn receive(fd: u32, expected: &[u8]) {
    let mut bytes = [0; 128];
    let io = Io {
        pointer: bytes.as_mut_ptr(),
        length: 128,
    };
    let mut count = 0;
    unsafe {
        if fd_read(fd, &io, 1, &mut count) != 0 || &bytes[..count as usize] != expected {
            proc_exit(81);
        }
    }
}
fn empty(fd: u32) {
    let mut bytes = [0; 1];
    let io = Io {
        pointer: bytes.as_mut_ptr(),
        length: 1,
    };
    let mut count = 99;
    unsafe {
        if fd_read(fd, &io, 1, &mut count) != 6 {
            proc_exit(82);
        }
    }
}
fn attributes(fd: u32, flags: u8, chars: &[u8; 7]) -> [u8; 12] {
    let mut attrs = [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    attrs[4..11].copy_from_slice(chars);
    let mut actual = [0; 12];
    unsafe {
        if tcsetattr(fd, attrs.as_ptr()) != 0
            || tcgetattr(fd, actual.as_mut_ptr()) != 0
            || actual != attrs
        {
            proc_exit(83);
        }
    }
    attrs
}
static mut INTERRUPTS: u32 = 0;
#[unsafe(no_mangle)]
pub extern "C" fn __wasi_signal_trampoline(signal: u32) {
    unsafe {
        if signal != 2 {
            proc_exit(84);
        }
        INTERRUPTS += 1;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let custom = *b"!?~@#%&";
        if cfg!(case = "child") {
            let mut attrs = [0; 12];
            if set_raw_mode(1) != 0
                || tcgetattr(0, attrs.as_mut_ptr()) != 0
                || attrs[0] != 0
                || attrs[4..11] != custom
            {
                proc_exit(85);
            }
            let mut bytes = [0; 3];
            if read(bytes.as_mut_ptr(), 3, u32::MAX) != 3 || bytes != *b"hel" {
                proc_exit(86);
            }
            send(1, b"raw-ready\n");
            if read(bytes.as_mut_ptr(), 3, u32::MAX) != 3
                || bytes != *b"lo\r"
                || tcgetattr(0, attrs.as_mut_ptr()) != 0
                || attrs[0] != 0
                || attrs[4..11] != custom
                || fd_close(0) != 0
            {
                proc_exit(87);
            }
            proc_exit(0);
        }
        if cfg!(case = "recovery") {
            let configured = attributes(0, 43, &custom);
            let path = b"/tmp/termios-child.wasm";
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
            {
                proc_exit(88);
            }
            let mut status = 0;
            let mut waited = 0;
            let mut restored = [0; 12];
            if proc_waitpid_v3(pid, 0, &mut status, &mut waited) != 0
                || status != 0
                || waited != pid
                || tcgetattr(0, restored.as_mut_ptr()) != 0
                || restored != configured
            {
                proc_exit(89);
            }
            send(1, b"attrs-restored\n");
            attributes(0, 47, &custom);
            send(1, b"translated\n");
            proc_exit(0);
        }
        let mut master = 0;
        let mut slave = 0;
        let defaults = [3, 28, 26, 4, 127, 21, 23];
        if pty_open(&mut master, &mut slave) != 0
            || fd_dup2(slave, 0) != 0
            || fd_fdstat_set_flags(slave, 4) != 0
            || fd_fdstat_set_flags(master, 4) != 0
        {
            proc_exit(90);
        }
        for flags in [0, 1, 2, 4, 8, 16, 32, 63] {
            attributes(slave, flags, &defaults);
        }
        send(master, b"a\x01\x08b\t\x17\n");
        receive(slave, b"\n");
        receive(
            master,
            b"a^A\x08 \x08\x08 \x08b^I\x08 \x08\x08 \x08\x08 \x08\x08 \x08\r\n",
        );
        let mut actual = [0; 12];
        let current = attributes(slave, 63, &defaults);
        let mut malformed = current;
        malformed[0] = 64;
        if tcgetattr(99, actual.as_mut_ptr()) != 8
            || tcsetattr(99, current.as_ptr()) != 8
            || tcgetattr(3, actual.as_mut_ptr()) != 59
            || tcsetattr(3, current.as_ptr()) != 59
            || tcgetattr(slave, u32::MAX as *mut u8) != 21
            || tcsetattr(slave, u32::MAX as *const u8) != 21
            || tcsetattr(slave, malformed.as_ptr()) != 28
        {
            proc_exit(91);
        }
        malformed = current;
        malformed[11] = 1;
        if tcsetattr(slave, malformed.as_ptr()) != 28
            || tcgetattr(master, actual.as_mut_ptr()) != 0
            || actual != current
        {
            proc_exit(92);
        }
        let mut alias = 0;
        if fd_dup(slave, &mut alias) != 0
            || fd_close(alias) != 0
            || tcgetattr(alias, actual.as_mut_ptr()) != 8
        {
            proc_exit(93);
        }
        attributes(master, 47, &defaults);
        send(master, b"hel");
        empty(slave);
        empty(master);
        send(master, b"lo\r");
        receive(slave, b"hello\n");
        empty(master);
        send(slave, b"out\r\nmore\n");
        receive(master, b"out\r\nmore\r\n");
        attributes(slave, 46, &custom);
        send(master, b"abX#c@");
        receive(slave, b"abc");
        send(master, b"\r");
        empty(slave);
        send(master, b"\n");
        receive(slave, b"\r\n");
        if set_foreground(master, 1) != 0 || proc_sigaction(2, 2, 0, 0, 0) != 0 {
            proc_exit(94);
        }
        send(master, b"!");
        let mut interrupted = 0;
        if read(&mut interrupted, 1, u32::MAX) != 0 || INTERRUPTS != 1 {
            proc_exit(95);
        }
        empty(slave);
        for (flags, input, expected) in [
            (
                0,
                b"\0\x03\x04\r\n\x7f\xff".as_slice(),
                b"\0\x03\x04\r\n\x7f\xff".as_slice(),
            ),
            (16, b"\x03\r\0".as_slice(), b"\x03\r\0".as_slice()),
            (17, b"\r".as_slice(), b"\n".as_slice()),
        ] {
            attributes(slave, flags, &custom);
            send(master, input);
            receive(slave, expected);
            if flags & 16 != 0 {
                receive(master, expected);
            } else {
                empty(master);
            }
        }
        for flags in [0, 2, 4, 6] {
            attributes(slave, flags, &custom);
            send(slave, b"x\n");
            if flags == 6 {
                receive(master, b"x\r\n");
            } else {
                receive(master, b"x\n");
            }
        }
        if INTERRUPTS != 1 || fd_close(master) != 0 || fd_close(slave) != 0 {
            proc_exit(96);
        }
        send(1, b"termios-verified\n");
        proc_exit(0);
    }
}
