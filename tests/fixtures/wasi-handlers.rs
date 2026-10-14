#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_sigaction(signal: u32, action: u32, lo: u32, hi: u32, flags: u32) -> u32;
    fn proc_kill(pid: u32, signal: u32) -> u32;
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
    fn proc_waitpid_v3(pid: u32, options: u32, status: *mut u32, waited: *mut u32) -> u32;
    fn proc_waitpid_v2(
        pid: u32,
        options: u32,
        code: *mut u32,
        signal: *mut u32,
        waited: *mut u32,
        core: *mut u32,
    ) -> u32;
    fn proc_signal_mask_v2(how: u32, lo: u32, hi: u32, old_lo: *mut u32, old_hi: *mut u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_write(fd: u32, vectors: *const Io, count: u32, written: *mut u32) -> u32;
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
    fn fd_read(fd: u32, vectors: *const Io, count: u32, read: *mut u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn poll_oneoff(input: *const u8, events: *mut u8, count: u32, ready: *mut u32) -> u32;
    fn proc_exit(code: u32) -> !;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}
const AUTO_REAP: bool = cfg!(case = "autoreap-ignore")
    || cfg!(case = "autoreap-default")
    || cfg!(case = "autoreap-user")
    || cfg!(case = "autoreap-late");
static mut CALLS: u32 = 0;
static mut OTHER: u32 = 0;
fn output(bytes: &mut [u8]) {
    unsafe {
        let io = Io {
            pointer: bytes.as_mut_ptr(),
            length: bytes.len() as u32,
        };
        let mut written = 0;
        if fd_write(1, &io, 1, &mut written) != 0 || written != bytes.len() as u32 {
            proc_exit(90);
        }
    }
}
#[cfg(not(case = "bad-signature"))]
#[cfg_attr(not(case = "missing"), unsafe(no_mangle))]
pub extern "C" fn __wasi_signal_trampoline(signal: u32) {
    unsafe {
        let mut lo = 0;
        let mut hi = 0;
        if proc_signal_mask_v2(3, 0, 0, &mut lo, &mut hi) != 0 {
            proc_exit(91);
        }
        if signal == 11 || signal == 17 {
            OTHER += 1;
            if cfg!(case = "autoreap-multi") && OTHER == 1 {
                let mut byte = [b'X'];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                let mut count = 0;
                if fd_write(5, &io, 1, &mut count) != 0 || count != 1 {
                    proc_exit(102);
                }
            }
            output(&mut [b'C']);
            return;
        }
        if signal != 10 && signal != 64 && signal != 18 {
            proc_exit(92);
        }
        CALLS += 1;
        let call = CALLS;
        let own = 1u64 << (signal - 1);
        let mask = u64::from(lo) | (u64::from(hi) << 32);
        if mask & 2 == 0 {
            proc_exit(93);
        }
        if (cfg!(case = "nodefer") || cfg!(case = "nest-limit")) {
            if mask & own != 0 {
                proc_exit(94);
            }
        } else if mask & own == 0 {
            proc_exit(95);
        }
        if cfg!(case = "sa-mask") && mask & (1 << 10) == 0 {
            proc_exit(96);
        }
        if cfg!(case = "sliced") {
            let mut checksum = 0u32;
            for index in 0..20000u32 {
                checksum = checksum
                    .wrapping_add(std::ptr::read_volatile(std::ptr::addr_of!(CALLS)) + index);
            }
            if checksum != 200010000 {
                proc_exit(101);
            }
        }
        if cfg!(case = "infinite") {
            loop {
                std::ptr::read_volatile(std::ptr::addr_of!(CALLS));
            }
        }
        output(&mut [if call == 1 { b'A' } else { b'B' }]);
        if cfg!(case = "nest-limit")
            || (call == 1
                && (cfg!(case = "defer") || (cfg!(case = "nodefer") || cfg!(case = "nest-limit"))))
        {
            if proc_kill(0, 10) != 0 {
                proc_exit(97);
            }
        }
        if cfg!(case = "sa-mask") {
            if proc_kill(0, 11) != 0 || OTHER != 0 {
                proc_exit(98);
            }
        }
        if cfg!(case = "io") || cfg!(case = "child-io") {
            let path = b"tmp/value";
            let mut fd = 0;
            if path_open(3, 1, path.as_ptr(), path.len() as u32, 0, 2, 0, 0, &mut fd) != 0 {
                proc_exit(99);
            }
            let mut bytes = [0u8; 3];
            let io = Io {
                pointer: bytes.as_mut_ptr(),
                length: 3,
            };
            let mut count = 0;
            if fd_read(fd, &io, 1, &mut count) != 0
                || count != 3
                || bytes != *b"abc"
                || fd_close(fd) != 0
            {
                proc_exit(100);
            }
        }
        output(&mut [if call == 1 { b'a' } else { b'b' }]);
    }
}
#[cfg(case = "bad-signature")]
#[unsafe(no_mangle)]
pub extern "C" fn __wasi_signal_trampoline(signal: u32) -> u32 {
    signal
}
#[cfg(any(
    case = "child-handler",
    case = "child-restart",
    case = "child-io",
    case = "child-inherit",
    case = "child-exit",
    case = "child-ignorecont",
    case = "child-poll"
))]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let mut lo = 0;
        let mut hi = 0;
        if proc_signal_mask_v2(3, 0, 0, &mut lo, &mut hi) != 0 || lo != 2 {
            proc_exit(80);
        }
        if !cfg!(case = "child-inherit")
            && !(cfg!(case = "child-exit") || cfg!(case = "child-ignorecont"))
        {
            let flags = if (cfg!(case = "child-restart") || cfg!(case = "child-poll")) {
                0x10000000
            } else {
                0
            };
            if proc_sigaction(10, 2, 0, 0, flags) != 0 {
                proc_exit(81);
            }
        }
        if cfg!(case = "child-ignorecont") && proc_sigaction(18, 1, 0, 0, 0) != 0 {
            proc_exit(87);
        }
        let mut marker = *b"ready";
        output(&mut marker);
        if cfg!(case = "child-inherit") {
            if proc_kill(0, 12) != 0 {
                proc_exit(82);
            }
            proc_kill(0, 10);
            proc_exit(83);
        }
        let mut byte = [0u8];
        let io = Io {
            pointer: byte.as_mut_ptr(),
            length: 1,
        };
        let mut count = 91;
        if cfg!(case = "child-poll") {
            let mut subscription = [0u8; 48];
            subscription[24..32].copy_from_slice(&1_000_000_000u64.to_le_bytes());
            let mut events = [0u8; 32];
            let mut ready = 91;
            if poll_oneoff(subscription.as_ptr(), events.as_mut_ptr(), 1, &mut ready) != 27
                || ready != 91
                || CALLS != 1
            {
                proc_exit(88);
            }
            output(&mut [b'D']);
            proc_exit(7);
        }
        let errno = fd_read(0, &io, 1, &mut count);
        if (cfg!(case = "child-exit") || cfg!(case = "child-ignorecont")) {
            if errno != 0 || count != 1 || byte[0] != b'X' {
                proc_exit(84);
            }
            proc_exit(7);
        }
        if cfg!(case = "child-restart") {
            if errno != 0 || count != 1 || byte[0] != b'X' || CALLS != 1 {
                proc_exit(85);
            }
        } else if errno != 27 || count != 91 || CALLS != 1 {
            proc_exit(86);
        }
        output(&mut [b'D']);
        proc_exit(7);
    }
}
#[cfg(not(any(
    case = "child-handler",
    case = "child-restart",
    case = "child-io",
    case = "child-inherit",
    case = "child-exit",
    case = "child-ignorecont",
    case = "child-poll"
)))]
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        if proc_sigaction(0, 2, 0, 0, 0) != 28
            || proc_sigaction(65, 2, 0, 0, 0) != 28
            || proc_sigaction(9, 1, 0, 0, 0) != 28
            || proc_sigaction(19, 1, 0, 0, 0) != 28
            || proc_sigaction(10, 3, 0, 0, 0) != 28
            || proc_sigaction(10, 2, 0, 0, 8) != 58
        {
            return 1;
        }
        if cfg!(case = "missing") || cfg!(case = "bad-signature") {
            let expected = if cfg!(case = "missing") { 58 } else { 28 };
            if proc_sigaction(10, 1, 0, 0, 0) != 0
                || proc_sigaction(10, 2, 0, 0, 0) != expected
                || proc_kill(0, 10) != 0
            {
                return 34;
            }
            let mut marker = *b"unavailable\n";
            output(&mut marker);
            return 7;
        }
        let mut lo = 0;
        let mut hi = 0;
        if proc_signal_mask_v2(0, 2, 0, &mut lo, &mut hi) != 0 {
            return 2;
        }
        if proc_sigaction(12, 1, 0, 0, 0) != 0 || proc_kill(0, 12) != 0 {
            return 3;
        }
        if cfg!(case = "autoreap-many") || cfg!(case = "autoreap-multi") {
            let action = if cfg!(case = "autoreap-multi") { 2 } else { 1 };
            let flags = if cfg!(case = "autoreap-multi") {
                0x10000002
            } else {
                0
            };
            if proc_sigaction(17, action, 0, 0, flags) != 0 {
                return 44;
            }
            let iterations = if cfg!(case = "autoreap-many") { 24 } else { 1 };
            for iteration in 0..iterations {
                let mut reader = 0;
                let mut writer = 0;
                let mut reply_reader = 0;
                let mut reply_writer = 0;
                if fd_pipe(&mut reader, &mut writer) != 0
                    || fd_pipe(&mut reply_reader, &mut reply_writer) != 0
                {
                    return 45;
                }
                if cfg!(case = "autoreap-multi") && writer != 5 {
                    return 46;
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
                let path = b"/tmp/handler-child.wasm";
                let children = if cfg!(case = "autoreap-multi") { 2 } else { 1 };
                for index in 0..children {
                    let mut pid = 0;
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
                        || pid != 2 + iteration + index
                    {
                        return 47;
                    }
                }
                if fd_close(reader) != 0 || fd_close(reply_writer) != 0 {
                    return 48;
                }
                let mut ready = [0u8; 10];
                let total = children * 5;
                let mut read = 0;
                while read < total {
                    let io = Io {
                        pointer: ready.as_mut_ptr().add(read as usize),
                        length: total - read,
                    };
                    let mut count = 0;
                    if fd_read(reply_reader, &io, 1, &mut count) != 0 || count == 0 {
                        return 49;
                    }
                    read += count;
                }
                if ready[..5] != *b"ready" {
                    return 50;
                }
                let mut byte = [b'X'];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                let mut count = 0;
                if fd_write(writer, &io, 1, &mut count) != 0 || count != 1 {
                    return 51;
                }
                let mut status = 91;
                let mut waited = 91;
                if proc_waitpid_v3(u32::MAX, 0, &mut status, &mut waited) != 12
                    || status != 91
                    || waited != 91
                {
                    return 52;
                }
                for index in 0..children {
                    if proc_kill(2 + iteration + index, 0) != 71 {
                        return 53;
                    }
                }
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                if fd_read(reply_reader, &io, 1, &mut count) != 0
                    || count != 0
                    || fd_close(reply_reader) != 0
                    || fd_close(writer) != 0
                {
                    return 54;
                }
            }
            if cfg!(case = "autoreap-multi") {
                if OTHER != 2 {
                    return 55;
                }
                let mut marker = *b" multi\n";
                output(&mut marker);
            } else {
                let mut marker = *b" many\n";
                output(&mut marker);
            }
            return 7;
        }
        if cfg!(case = "external")
            || cfg!(case = "restart")
            || cfg!(case = "external-io")
            || cfg!(case = "inherit")
            || AUTO_REAP
            || cfg!(case = "restart-poll")
            || (cfg!(case = "chld")
                || cfg!(case = "chld-stop")
                || cfg!(case = "nocldstop")
                || cfg!(case = "ignore-cont"))
        {
            if cfg!(case = "inherit") && proc_sigaction(10, 2, 0, 0, 0) != 0 {
                return 13;
            }
            let mut reader = 0;
            let mut writer = 0;
            let mut reply_reader = 0;
            let mut reply_writer = 0;
            if fd_pipe(&mut reader, &mut writer) != 0
                || fd_pipe(&mut reply_reader, &mut reply_writer) != 0
            {
                return 14;
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
            let path = b"/tmp/handler-child.wasm";
            let mut pid = 0;
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
                return 15;
            }
            if fd_close(reader) != 0 || fd_close(reply_writer) != 0 {
                return 16;
            }
            let mut ready = [0u8; 5];
            let io = Io {
                pointer: ready.as_mut_ptr(),
                length: 5,
            };
            let mut count = 0;
            if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 5 || ready != *b"ready" {
                return 17;
            }
            if AUTO_REAP {
                let action = if cfg!(case = "autoreap-ignore") {
                    1
                } else if cfg!(case = "autoreap-default") {
                    0
                } else {
                    2
                };
                let flags = if cfg!(case = "autoreap-ignore") || cfg!(case = "autoreap-late") {
                    0
                } else {
                    2
                };
                if proc_sigaction(17, action, 0, 0, flags) != 0 {
                    return 35;
                }
                let mut code = 91;
                let mut signal = 91;
                let mut waited = 91;
                let mut core = 91;
                if proc_waitpid_v2(pid, 1, &mut code, &mut signal, &mut waited, &mut core) != 0
                    || waited != 0
                {
                    return 36;
                }
                if cfg!(case = "autoreap-late") && proc_sigaction(17, 1, 0, 0, 0) != 0 {
                    return 37;
                }
                let mut byte = [b'X'];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                if fd_write(writer, &io, 1, &mut count) != 0 || count != 1 {
                    return 38;
                }
                code = 91;
                signal = 91;
                waited = 91;
                core = 91;
                if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 12
                    || code != 91
                    || signal != 91
                    || waited != 91
                    || core != 91
                {
                    return 39;
                }
                if proc_waitpid_v3(pid, 1, &mut code, &mut waited) != 12 || proc_kill(pid, 0) != 71
                {
                    return 40;
                }
                let expected = if cfg!(case = "autoreap-user") { 1 } else { 0 };
                if OTHER != expected {
                    return 41;
                }
                let mut byte = [0u8];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 0 {
                    return 42;
                }
                let mut byte = [b'X'];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                if fd_write(writer, &io, 1, &mut count) != 64 {
                    return 43;
                }
                let mut marker = *b" auto\n";
                output(&mut marker);
                return 7;
            }
            if (cfg!(case = "chld") || cfg!(case = "chld-stop") || cfg!(case = "nocldstop")) {
                if proc_sigaction(17, 2, 0, 0, if cfg!(case = "nocldstop") { 1 } else { 0 }) != 0 {
                    return 18;
                }
            } else if !cfg!(case = "inherit")
                && !cfg!(case = "ignore-cont")
                && proc_kill(pid, 10) != 0
            {
                return 19;
            }
            if cfg!(case = "chld-stop") || cfg!(case = "nocldstop") || cfg!(case = "ignore-cont") {
                let mut status = 0;
                let mut waited = 0;
                if proc_kill(pid, 19) != 0
                    || proc_waitpid_v3(pid, 2, &mut status, &mut waited) != 0
                    || status != 0x137f
                    || waited != pid
                {
                    return 30;
                }
                let expected = if cfg!(case = "nocldstop") || cfg!(case = "ignore-cont") {
                    0
                } else {
                    1
                };
                if OTHER != expected {
                    return 31;
                }
                if proc_kill(pid, 18) != 0
                    || proc_waitpid_v3(pid, 8, &mut status, &mut waited) != 0
                    || status != 0xffff
                    || waited != pid
                {
                    return 32;
                }
                let expected = if cfg!(case = "nocldstop") || cfg!(case = "ignore-cont") {
                    0
                } else {
                    2
                };
                if OTHER != expected {
                    return 33;
                }
            }
            if cfg!(case = "restart") {
                let mut log = [0u8; 2];
                let io = Io {
                    pointer: log.as_mut_ptr(),
                    length: 2,
                };
                if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 2 || log != *b"Aa" {
                    return 20;
                }
            }
            if cfg!(case = "restart")
                || cfg!(case = "ignore-cont")
                || (cfg!(case = "chld") || cfg!(case = "chld-stop") || cfg!(case = "nocldstop"))
            {
                let mut byte = [b'X'];
                let io = Io {
                    pointer: byte.as_mut_ptr(),
                    length: 1,
                };
                if fd_write(writer, &io, 1, &mut count) != 0 || count != 1 {
                    return 21;
                }
            }
            let mut code = 91;
            let mut signal = 91;
            let mut waited = 91;
            let mut core = 91;
            if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
                || waited != pid
                || core != 0
            {
                return 22;
            }
            if cfg!(case = "inherit") {
                if code != 0 || signal != 10 {
                    return 23;
                }
            } else if code != 7 || signal != 0 {
                return 24;
            }
            if (cfg!(case = "chld") || cfg!(case = "chld-stop") || cfg!(case = "nocldstop")) {
                if OTHER != if cfg!(case = "chld-stop") { 3 } else { 1 } {
                    return 25;
                }
            } else if !cfg!(case = "inherit") && !cfg!(case = "ignore-cont") {
                let mut log = [0u8; 3];
                let length = if cfg!(case = "restart") { 1 } else { 3 };
                let io = Io {
                    pointer: log.as_mut_ptr(),
                    length,
                };
                if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != length {
                    return 26;
                }
                if cfg!(case = "restart") {
                    if log[0] != b'D' {
                        return 27;
                    }
                } else if log != *b"AaD" {
                    return 28;
                }
            }
            let mut byte = [0u8];
            let io = Io {
                pointer: byte.as_mut_ptr(),
                length: 1,
            };
            if fd_read(reply_reader, &io, 1, &mut count) != 0 || count != 0 {
                return 29;
            }
            let mut marker = *b" main\n";
            output(&mut marker);
            return 7;
        }
        let signal = if cfg!(case = "upper") {
            64
        } else if cfg!(case = "cont-handler") {
            18
        } else {
            10
        };
        let mask = if cfg!(case = "sa-mask") { 1 << 10 } else { 0 };
        let flags = if (cfg!(case = "nodefer") || cfg!(case = "nest-limit")) {
            0x40000000
        } else if cfg!(case = "reset") {
            0x80000000
        } else {
            0
        };
        if cfg!(case = "sa-mask") && proc_sigaction(11, 2, 0, 0, 0) != 0 {
            return 4;
        }
        if proc_sigaction(signal, 2, mask, 0, flags) != 0 {
            return 5;
        }
        if cfg!(case = "coalesce") {
            if proc_signal_mask_v2(0, 1 << 9, 0, &mut lo, &mut hi) != 0
                || proc_kill(0, 10) != 0
                || proc_kill(0, 10) != 0
                || CALLS != 0
            {
                return 6;
            }
            if proc_signal_mask_v2(1, 1 << 9, 0, &mut lo, &mut hi) != 0 {
                return 7;
            }
        } else if proc_kill(0, signal) != 0 {
            return 8;
        }
        let expected =
            if cfg!(case = "defer") || (cfg!(case = "nodefer") || cfg!(case = "nest-limit")) {
                2
            } else {
                1
            };
        if CALLS != expected {
            return 9;
        }
        if cfg!(case = "sa-mask") && OTHER != 1 {
            return 10;
        }
        if proc_signal_mask_v2(3, 0, 0, &mut lo, &mut hi) != 0 || lo != 2 || hi != 0 {
            return 11;
        }
        if cfg!(case = "reset") {
            proc_kill(0, 10);
            return 12;
        }
        let mut marker = *b" main\n";
        output(&mut marker);
        7
    }
}
