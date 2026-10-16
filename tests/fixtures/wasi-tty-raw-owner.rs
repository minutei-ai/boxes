#[link(wasm_import_module = "host_tty")]
unsafe extern "C" {
    fn set_raw_mode(enabled: u32) -> u32;
    fn read(pointer: *mut u8, length: u32, timeout: u32) -> u32;
    fn set_foreground(fd: u32, group: u32) -> u32;
}
#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn pty_open(master: *mut u32, slave: *mut u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
    fn proc_getpid(pid: *mut u32) -> u32;
    fn proc_kill(pid: u32, signal: u32) -> u32;
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
    fn proc_waitpid_v3(pid: u32, options: u32, status: *mut u32, waited: *mut u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_read(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
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

#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        if cfg!(case = "recovery-child") {
            if set_raw_mode(1) != 0 {
                proc_exit(92);
            }
            let mut data = [0; 3];
            if read(data.as_mut_ptr(), 3, u32::MAX) != 3 || data != *b"hel" {
                proc_exit(93);
            }
            send(1, b"raw-ready\n");
            if read(data.as_mut_ptr(), 3, u32::MAX) != 3 || data != *b"lo\r" {
                proc_exit(94);
            }
            if fd_close(0) != 0 {
                proc_exit(95);
            }
            proc_exit(0);
        }
        if cfg!(case = "recovery") {
            let path = b"/tmp/raw-recovery-child.wasm";
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
                proc_exit(96);
            }
            let mut status = 0;
            let mut waited = 0;
            if proc_waitpid_v3(pid, 0, &mut status, &mut waited) != 0
                || status != 0
                || waited != pid
            {
                proc_exit(97);
            }
            send(1, b"restored\n");
            proc_exit(0);
        }
        if cfg!(case = "replacement") {
            send(0, b"\n");
            proc_exit(0);
        }
        if !cfg!(case = "parent") {
            if set_raw_mode(1) != 0 || set_raw_mode(1) != 0 {
                proc_exit(81);
            }
            send(0, b"\n");
            if cfg!(case = "closed") && fd_close(0) != 0 {
                proc_exit(82);
            }
            if cfg!(case = "trap") {
                core::arch::wasm32::unreachable();
            }
            if cfg!(case = "signal") {
                let mut pid = 0;
                if proc_getpid(&mut pid) != 0 || proc_kill(pid, 15) != 0 {
                    proc_exit(83);
                }
                proc_exit(84);
            }
            if cfg!(case = "exec") || cfg!(case = "failed") {
                let path = if cfg!(case = "exec") {
                    b"/tmp/raw-replacement.wasm".as_slice()
                } else {
                    b"/tmp/absent.wasm".as_slice()
                };
                let error = proc_exec(
                    path.as_ptr(),
                    path.len() as u32,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    0,
                );
                if cfg!(case = "exec") || error != 44 {
                    proc_exit(85);
                }
                send(0, b"\n");
            }
            proc_exit(0);
        }
        for nested in [false, true] {
            for (name, status, written) in [
                ("normal", 0, 1),
                ("closed", 0, 1),
                ("trap", 256, 1),
                ("signal", 15, 1),
                ("exec", 0, 2),
                ("failed", 0, 2),
                ("background", 0, 1),
            ] {
                if nested && name == "background" {
                    continue;
                }
                let mut master = 0;
                let mut slave = 0;
                if pty_open(&mut master, &mut slave) != 0 || fd_dup2(slave, 0) != 0 {
                    proc_exit(86);
                }
                if nested && set_raw_mode(1) != 0 {
                    proc_exit(87);
                }
                if name == "background" && set_foreground(slave, 1) != 0 {
                    proc_exit(98);
                }
                let path = format!("/tmp/raw-{name}.wasm");
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
                    u32::from(name == "background") * 2,
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
                let mut observed = 0;
                let mut waited = 0;
                if proc_waitpid_v3(pid, 0, &mut observed, &mut waited) != 0
                    || observed != status
                    || waited != pid
                {
                    send(
                        1,
                        format!("wait {name} nested={nested}: status={observed}, pid={waited}\n")
                            .as_bytes(),
                    );
                    proc_exit(89);
                }
                send(slave, b"\n");
                let retained = nested || name == "background";
                if retained && set_raw_mode(0) != 0 {
                    proc_exit(90);
                }
                if retained {
                    send(slave, b"\n");
                }
                let mut data = [0; 16];
                let io = Io {
                    pointer: data.as_mut_ptr(),
                    length: 16,
                };
                let mut count = 0;
                let raw_count = written + u32::from(retained);
                if fd_read(master, &io, 1, &mut count) != 0
                    || count != raw_count + 2
                    || data[..raw_count as usize].iter().any(|byte| *byte != b'\n')
                    || data[raw_count as usize..count as usize] != *b"\r\n"
                    || fd_close(master) != 0
                    || fd_close(slave) != 0
                {
                    proc_exit(91);
                }
            }
        }
        send(1, b"raw-owners-restored\n");
        proc_exit(0);
    }
}
