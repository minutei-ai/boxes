use std::convert::TryInto;

#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn pty_open(master: *mut u32, slave: *mut u32) -> u32;
    #[cfg(any(case = "resize", case = "resize-recovery", case = "resize-restart"))]
    fn proc_sigaction(signal: u32, action: u32, lo: u32, hi: u32, flags: u32) -> u32;
    fn fd_dup(fd: u32, output: *mut u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
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
    fn proc_waitpid_v2(
        pid: u32,
        options: u32,
        code: *mut u32,
        signal: *mut u32,
        waited: *mut u32,
        core: *mut u32,
    ) -> u32;
}
#[link(wasm_import_module = "host_tty")]
unsafe extern "C" {
    fn isatty(fd: u32) -> u32;
    fn read(pointer: *mut u8, length: u32, timeout: u32) -> u32;
    fn get_size(fd: u32, cols: *mut u16, rows: *mut u16) -> u32;
    fn set_raw_mode(enabled: u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_read(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn fd_fdstat_set_flags(fd: u32, flags: u32) -> u32;
    fn fd_fdstat_get(fd: u32, value: *mut u8) -> u32;
    fn fd_fdstat_set_rights(fd: u32, base: u64, inheriting: u64) -> u32;
    fn poll_oneoff(input: *const u8, output: *mut u8, count: u32, ready: *mut u32) -> u32;
    fn proc_exit(code: u32) -> !;
    fn clock_time_get(clock: u32, precision: u64, output: *mut u64) -> u32;
}
#[repr(C)]
struct Io {
    pointer: *const u8,
    length: u32,
}

fn send(fd: u32, data: &[u8]) -> (u32, u32) {
    let mut count = 0;
    let io = Io {
        pointer: data.as_ptr(),
        length: data.len() as u32,
    };
    (unsafe { fd_write(fd, &io, 1, &mut count) }, count)
}

fn receive(fd: u32, data: &mut [u8]) -> (u32, u32) {
    let mut count = 0;
    let io = Io {
        pointer: data.as_mut_ptr(),
        length: data.len() as u32,
    };
    (unsafe { fd_read(fd, &io, 1, &mut count) }, count)
}

#[cfg(any(case = "resize", case = "resize-recovery", case = "resize-restart"))]
static mut RESIZES: u32 = 0;
#[cfg(any(case = "resize", case = "resize-recovery", case = "resize-restart"))]
#[unsafe(no_mangle)]
pub extern "C" fn __wasi_signal_trampoline(signal: u32) {
    unsafe {
        let mut cols = 0;
        let mut rows = 0;
        if signal != 28 || get_size(0, &mut cols, &mut rows) != 0 {
            proc_exit(100);
        }
        RESIZES += 1;
        if cfg!(case = "resize-recovery") || cfg!(case = "resize-restart") {
            if RESIZES != 1 || cols != 80 || rows != 24 {
                proc_exit(101);
            }
        } else if (RESIZES == 1 && (cols != 120 || rows != 40))
            || (RESIZES == 2 && (cols != 100 || rows != 30))
        {
            proc_exit(101);
        }
        if get_size(1, &mut cols, &mut rows) != 0 || get_size(2, &mut cols, &mut rows) != 0 {
            proc_exit(102);
        }
        send(1, b"winch\n");
    }
}

#[cfg(any(
    case = "child",
    case = "session",
    case = "sink",
    case = "tty-read",
    case = "tty-cursor",
    case = "tty-invalid",
    case = "tty-rights",
    case = "recovery-cooked",
    case = "recovery-delayed",
    case = "recovery-raw",
    case = "resize",
    case = "resize-initial",
    case = "resize-recovery",
    case = "resize-restart"
))]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        if isatty(0) != 1 || isatty(1) != 1 || isatty(2) != 1 {
            proc_exit(51);
        }
        #[cfg(any(case = "resize-recovery", case = "resize-restart"))]
        {
            let flags = if cfg!(case = "resize-restart") {
                0x10000000
            } else {
                0
            };
            if proc_sigaction(28, 2, 0, 0, flags) != 0 {
                proc_exit(108);
            }
            let mut data = [0u8; 3];
            let count = read(data.as_mut_ptr(), 3, u32::MAX);
            if cfg!(case = "resize-restart") {
                if count != 3 || &data != b"hel" {
                    proc_exit(109);
                }
            } else if count != 0 {
                proc_exit(109);
            }
            if RESIZES != 1 {
                proc_exit(110);
            }
            send(1, b"done\n");
            proc_exit(0);
        }
        if cfg!(case = "resize-initial") {
            let mut cols = 0;
            let mut rows = 0;
            if get_size(0, &mut cols, &mut rows) != 0 || cols != 132 || rows != 45 {
                proc_exit(103);
            }
            send(1, b"initial132x45\n");
            proc_exit(0);
        }
        #[cfg(case = "resize")]
        {
            if set_raw_mode(1) != 0 || proc_sigaction(28, 2, 0, 0, 0) != 0 {
                proc_exit(104);
            }
            send(1, b"ready\n");
            let mut byte = 0;
            if read(&mut byte, 1, u32::MAX) != 0 {
                proc_exit(105);
            }
            send(1, b"eof-ready\n");
            for expected in 1..=2 {
                let mut subscription = [0u8; 48];
                subscription[16..20].copy_from_slice(&1u32.to_le_bytes());
                subscription[24..32].copy_from_slice(&31_000_000_000u64.to_le_bytes());
                let mut event = [0u8; 32];
                let mut count = 0;
                if poll_oneoff(subscription.as_ptr(), event.as_mut_ptr(), 1, &mut count) != 27
                    || RESIZES != expected
                {
                    proc_exit(106);
                }
                if expected == 1 {
                    send(1, b"after-one\n");
                }
            }
            send(1, b"done\n");
            proc_exit(0);
        }
        if cfg!(case = "recovery-delayed") {
            send(1, b"delayed\n");
            let mut subscription = [0u8; 48];
            subscription[16..20].copy_from_slice(&1u32.to_le_bytes());
            subscription[24..32].copy_from_slice(&20_000_000u64.to_le_bytes());
            let mut event = [0u8; 32];
            let mut count = 0;
            if poll_oneoff(subscription.as_ptr(), event.as_mut_ptr(), 1, &mut count) != 0
                || count != 1
            {
                proc_exit(111);
            }
        }
        if cfg!(case = "recovery-cooked") || cfg!(case = "recovery-delayed") {
            let mut data = [0u8; 32];
            if read(data.as_mut_ptr(), 32, u32::MAX) != 6 || &data[..6] != b"hello\n" {
                proc_exit(80);
            }
            send(1, b"read:hello\n");
            if read(data.as_mut_ptr(), 32, u32::MAX) != 0 {
                proc_exit(81);
            }
            send(1, b"eof\n");
            proc_exit(0);
        }
        if cfg!(case = "recovery-raw") {
            let mut data = [0u8; 32];
            if set_raw_mode(1) != 0 || receive(0, &mut data[..1]) != (0, 1) || data[0] != b'r' {
                proc_exit(82);
            }
            send(1, b"buffered\n");
            let mut subscription = [0u8; 48];
            subscription[16..20].copy_from_slice(&1u32.to_le_bytes());
            subscription[24..32].copy_from_slice(&31_000_000_000u64.to_le_bytes());
            subscription[32..40].copy_from_slice(&1_000_000u64.to_le_bytes());
            let mut event = [0u8; 32];
            let mut count = 0;
            if poll_oneoff(subscription.as_ptr(), event.as_mut_ptr(), 1, &mut count) != 0
                || count != 1
            {
                proc_exit(83);
            }
            let mut cols = 0;
            let mut rows = 0;
            if get_size(0, &mut cols, &mut rows) != 0 || cols != 132 || rows != 45 {
                proc_exit(107);
            }
            let mut total = 0usize;
            while total < 9 {
                let (errno, count) = receive(0, &mut data[total..9]);
                if errno != 0 || count == 0 {
                    proc_exit(84);
                }
                total += count as usize;
            }
            if &data[..9] != b"aw\0\x03\x04\r\n\x7f\xff" {
                proc_exit(85);
            }
            send(1, b"read:");
            send(1, &data[..9]);
            if receive(0, &mut data) != (0, 0) {
                proc_exit(86);
            }
            send(1, b"eof\n");
            proc_exit(0);
        }
        if cfg!(case = "tty-invalid") {
            send(1, b"invalid-ready\n");
            let mut timestamp = 0;
            clock_time_get(1, 1_000_000, &mut timestamp);
            read(u32::MAX as *mut u8, 1, u32::MAX);
            proc_exit(74);
        }
        if cfg!(case = "tty-rights") {
            send(1, b"rights-ready\n");
            let mut timestamp = 0;
            clock_time_get(1, 1_000_000, &mut timestamp);
            if fd_fdstat_set_rights(0, 0, 0) != 0 {
                proc_exit(75);
            }
            let mut byte = 0u8;
            read(&mut byte, 1, u32::MAX);
            proc_exit(76);
        }
        if cfg!(case = "tty-cursor") {
            let mut data = [0u8; 16];
            if set_raw_mode(1) != 0 || read(data.as_mut_ptr(), 16, 2950) != 0 {
                proc_exit(111);
            }
            send(1, b"\x1b[6n");
            if read(data.as_mut_ptr(), 16, 2000) != 6 || &data[..6] != b"\x1b[1;1R" {
                proc_exit(112);
            }
            send(1, b"cursor-ready\n");
            proc_exit(0);
        }
        if cfg!(case = "tty-read") {
            let mut data = [0u8; 16];
            let mut before = 0u64;
            let mut after = 0u64;
            if clock_time_get(1, 1_000_000, &mut before) != 0
                || set_raw_mode(1) != 0
                || read(u32::MAX as *mut u8, 0, u32::MAX) != 0
                || read(data.as_mut_ptr(), 16, 25) != 0
                || clock_time_get(1, 1_000_000, &mut after) != 0
                || after.saturating_sub(before) < 25_000_000
            {
                proc_exit(70);
            }
            send(1, b"timeout-ready\n");
            if read(data.as_mut_ptr(), 3, u32::MAX) != 3 || &data[..3] != b"one" {
                proc_exit(71);
            }
            send(1, b"one-ready\n");
            if read(data.as_mut_ptr(), 16, 3000) != 3 || &data[..3] != b"two" {
                proc_exit(72);
            }
            send(1, b"two-ready\n");
            if read(data.as_mut_ptr(), 16, u32::MAX) != 0 {
                proc_exit(73);
            }
            send(1, b"eof-done\n");
            proc_exit(0);
        }
        if cfg!(case = "sink") {
            send(1, b"ready\n");
            let mut total = 0;
            let mut data = [0u8; 128];
            loop {
                let (errno, count) = receive(0, &mut data);
                if errno != 0 {
                    proc_exit(60);
                }
                if count == 0 {
                    break;
                }
                total += count;
            }
            if total != 10 {
                proc_exit(61);
            }
            send(1, b"done\n");
            proc_exit(0);
        }
        if cfg!(case = "session") {
            send(1, b"ready\n");
            let mut data = [0u8; 128];
            if receive(0, &mut data) != (0, 6) || &data[..6] != b"hello\n" {
                proc_exit(62);
            }
            send(1, b"out:hello\n");
            send(2, b"err\n");
            if set_raw_mode(1) != 0 {
                proc_exit(63);
            }
            send(1, b"raw\n");
            if receive(0, &mut data) != (0, 7) || &data[..7] != b"\0\x03\x04\r\n\x7f\xff" {
                proc_exit(64);
            }
            send(1, b"raw:");
            send(2, &data[..7]);
            if set_raw_mode(0) != 0 {
                proc_exit(65);
            }
            send(1, b"cooked\n");
            if receive(0, &mut data) != (0, 4)
                || &data[..4] != b"tail"
                || receive(0, &mut data) != (0, 0)
            {
                proc_exit(66);
            }
            send(1, b"done\n");
            proc_exit(0);
        }
        let mut data = [0u8; 128];
        if receive(0, &mut data) != (0, 6) || &data[..6] != b"hello\n" {
            proc_exit(52);
        }
        if send(1, b"out:hello\n") != (0, 10) || send(2, b"err\n") != (0, 4) {
            proc_exit(53);
        }
        proc_exit(7);
    }
}

#[cfg(not(any(
    case = "child",
    case = "session",
    case = "sink",
    case = "tty-read",
    case = "tty-cursor",
    case = "tty-invalid",
    case = "tty-rights",
    case = "recovery-cooked",
    case = "recovery-delayed",
    case = "recovery-raw",
    case = "resize",
    case = "resize-initial",
    case = "resize-recovery",
    case = "resize-restart"
)))]
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut master = 0;
        let mut slave = 0;
        if pty_open(&mut master, &mut master) != 28
            || pty_open(u32::MAX as *mut u32, &mut slave) != 21
        {
            return 100;
        }
        if pty_open(&mut master, &mut slave) != 0 {
            return 1;
        }
        #[cfg(case = "throughput")]
        {
            let patterns: [(&[u8], &[u8], &[u8]); 2] = [
                (
                    b"abcdefghijklmnopqrstuvwxyzABCD\r",
                    b"abcdefghijklmnopqrstuvwxyzABCD\n",
                    b"abcdefghijklmnopqrstuvwxyzABCD\r\n",
                ),
                (b"abX\x7fcz\x01\r", b"abcz\x01\n", b"abX\x08 \x08cz^A\r\n"),
            ];
            let chunks =
                patterns.map(|(input, line, echo)| (input.repeat(64), line, echo.repeat(64)));
            let mut buffer = [0u8; 4096];
            for _ in 0..16 {
                for (input, line, echo) in &chunks {
                    if send(master, input) != (0, input.len() as u32)
                        || receive(master, &mut buffer) != (0, echo.len() as u32)
                        || &buffer[..echo.len()] != echo
                    {
                        return 110;
                    }
                    for _ in 0..64 {
                        if receive(slave, &mut buffer) != (0, line.len() as u32)
                            || &buffer[..line.len()] != *line
                        {
                            return 111;
                        }
                    }
                }
            }
            if fd_close(master) != 0 || fd_close(slave) != 0 {
                return 112;
            }
            return 0;
        }
        if cfg!(case = "parent") {
            let mut actions = [0u8; 120];
            for (index, (op, fd, source)) in [
                (2u32, 0u32, slave),
                (2, 1, slave),
                (2, 2, slave),
                (1, master, 0),
                (1, slave, 0),
            ]
            .iter()
            .copied()
            .enumerate()
            {
                let start = index * 24;
                actions[start..start + 4].copy_from_slice(&op.to_le_bytes());
                actions[start + 4..start + 8].copy_from_slice(&fd.to_le_bytes());
                actions[start + 8..start + 12].copy_from_slice(&source.to_le_bytes());
            }
            let path = b"/tmp/pty-child.wasm";
            let mut pid = 0;
            if proc_spawn_v3(
                path.as_ptr(),
                path.len() as u32,
                path.as_ptr(),
                path.len() as u32,
                b"".as_ptr(),
                0,
                actions.as_ptr(),
                actions.len() as u32,
                b"/".as_ptr(),
                1,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut pid,
            ) != 0
            {
                return 30;
            }
            if fd_close(slave) != 0 || send(master, b"hello\n") != (0, 6) {
                return 31;
            }
            let mut result = Vec::new();
            let mut data = [0u8; 128];
            loop {
                let (errno, size) = receive(master, &mut data);
                if errno == 29 {
                    break;
                }
                if errno != 0 || size == 0 || result.len() + size as usize > 128 {
                    return 32;
                }
                result.extend_from_slice(&data[..size as usize]);
            }
            let mut code = 0;
            let mut signal = 0;
            let mut waited = 0;
            let mut core = 0;
            if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
                || code != 7
                || signal != 0
                || waited != pid
            {
                return 33;
            }
            if result != b"hello\r\nout:hello\r\nerr\r\n" {
                return 34;
            }
            send(1, &result);
            return 0;
        }
        if cfg!(case = "blocked") {
            send(1, b"waiting for terminal");
            let mut byte = [0];
            receive(master, &mut byte);
            return 99;
        }
        if isatty(master) != 1 || isatty(slave) != 1 || isatty(1) != 0 {
            return 2;
        }
        let mut cols = 0;
        let mut rows = 0;
        if get_size(slave, &mut cols, &mut rows) != 0 || cols != 80 || rows != 24 {
            return 3;
        }
        if fd_fdstat_set_flags(master, 4) != 0 || fd_fdstat_set_flags(slave, 4) != 0 {
            return 4;
        }
        let mut stat = [0u8; 24];
        if fd_fdstat_get(slave, stat.as_mut_ptr()) != 0 || stat[0] != 2 {
            return 101;
        }
        let mut subscriptions = [0u8; 96];
        subscriptions[0..8].copy_from_slice(&123u64.to_le_bytes());
        subscriptions[8] = 1;
        subscriptions[16..20].copy_from_slice(&slave.to_le_bytes());
        subscriptions[48..56].copy_from_slice(&456u64.to_le_bytes());
        let mut events = [0u8; 64];
        let mut ready = 0;
        if poll_oneoff(subscriptions.as_ptr(), events.as_mut_ptr(), 2, &mut ready) != 0
            || ready != 1
            || u64::from_le_bytes(events[..8].try_into().unwrap()) != 456
        {
            return 102;
        }
        let mut data = [0u8; 65_536];
        if receive(slave, &mut data).0 != 6 || send(master, b"abX\x7fc\r") != (0, 6) {
            return 5;
        }
        if receive(slave, &mut data) != (0, 4) || &data[..4] != b"abc\n" {
            return 6;
        }
        if receive(master, &mut data) != (0, 9) || &data[..9] != b"abX\x08 \x08c\r\n" {
            return 7;
        }
        if send(master, b"one\ntwo\n") != (0, 8)
            || receive(slave, &mut data) != (0, 4)
            || &data[..4] != b"one\n"
            || receive(slave, &mut data) != (0, 4)
            || &data[..4] != b"two\n"
        {
            return 8;
        }
        receive(master, &mut data);
        if send(master, b"\x04") != (0, 1) {
            return 103;
        }
        if poll_oneoff(subscriptions.as_ptr(), events.as_mut_ptr(), 2, &mut ready) != 0
            || ready != 2
            || events[16..24] != [0; 8]
        {
            return 104;
        }
        if receive(slave, &mut data) != (0, 0)
            || send(master, b"next\n") != (0, 5)
            || receive(slave, &mut data) != (0, 5)
        {
            return 9;
        }
        receive(master, &mut data);
        if send(slave, b"out\n") != (0, 4)
            || receive(master, &mut data) != (0, 5)
            || &data[..5] != b"out\r\n"
        {
            return 10;
        }
        if fd_dup2(slave, 0) != 0 || set_raw_mode(1) != 0 {
            return 11;
        }
        let raw = b"\0\x03\x04\r\n\x7f";
        if send(master, raw) != (0, raw.len() as u32)
            || receive(slave, &mut data) != (0, raw.len() as u32)
            || &data[..raw.len()] != raw
            || receive(master, &mut data).0 != 6
            || send(slave, b"raw\n") != (0, 4)
            || receive(master, &mut data) != (0, 4)
            || &data[..4] != b"raw\n"
        {
            return 12;
        }
        if set_raw_mode(0) != 0
            || send(master, b"restored\n") != (0, 9)
            || receive(slave, &mut data) != (0, 9)
            || &data[..9] != b"restored\n"
            || receive(master, &mut data) != (0, 10)
            || &data[..10] != b"restored\r\n"
            || set_raw_mode(1) != 0
        {
            return 105;
        }
        data.fill(42);
        if send(master, &data) != (0, 65_536) || send(master, b"x").0 != 6 {
            return 13;
        }
        if receive(slave, &mut data) != (0, 65_536) {
            return 14;
        }
        let mut alias = 0;
        if fd_dup(slave, &mut alias) != 0 || fd_close(slave) != 0 || fd_close(0) != 0 {
            return 15;
        }
        if send(alias, b"alias") != (0, 5)
            || receive(master, &mut data) != (0, 5)
            || &data[..5] != b"alias"
            || fd_close(alias) != 0
        {
            return 16;
        }
        let mut restricted = 0;
        if fd_dup(master, &mut restricted) != 0
            || fd_fdstat_set_rights(restricted, 2, 0) != 0
            || send(restricted, b"denied").0 != 76
            || fd_close(restricted) != 0
        {
            return 106;
        }
        if receive(master, &mut data).0 != 29 || send(master, b"late").0 != 29 {
            return 17;
        }
        if fd_close(master) != 0 || isatty(master) != 0 {
            return 18;
        }
        0
    }
}
