#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_getpgid(pid: u32, group: *mut u32) -> u32;
    fn proc_setpgid(pid: u32, group: u32) -> u32;
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
    fn proc_exit(code: u32) -> !;
}
#[cfg(any(
    case = "child-new",
    case = "child-join",
    case = "child-inherit",
    case = "child-session"
))]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let mut group = 91;
        let expected = if cfg!(case = "child-new") || cfg!(case = "child-session") {
            2
        } else {
            1
        };
        if proc_getpgid(0, &mut group) != 0 || group != expected {
            proc_exit(40);
        }
        if proc_getpgid(1, &mut group) != 0 || group != 1 {
            proc_exit(41);
        }
        if proc_setpgid(0, 99) != 63 || proc_getpgid(0, &mut group) != 0 || group != expected {
            proc_exit(42);
        }
        if cfg!(case = "child-session") {
            if proc_setpgid(0, 1) != 63 || proc_getpgid(0, &mut group) != 0 || group != 2 {
                proc_exit(45);
            }
            let path = b"/tmp/grandchild.wasm";
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
                2,
                0,
                0,
                0,
                0,
                1,
                &mut pid,
            ) != 63
                || pid != 91
            {
                proc_exit(46);
            }
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
                proc_exit(47);
            }
            let mut code = 91;
            let mut signal = 91;
            let mut waited = 91;
            let mut core = 91;
            if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
                || code != 7
                || signal != 0
                || waited != pid
                || core != 0
            {
                proc_exit(48);
            }
            if proc_getpgid(pid, &mut group) != 71 || proc_getpgid(0, &mut group) != 0 || group != 2
            {
                proc_exit(49);
            }
            proc_exit(7);
        }
        if proc_setpgid(0, 1) != 0 || proc_getpgid(2, &mut group) != 0 || group != 1 {
            proc_exit(43);
        }
        if proc_setpgid(0, 0) != 0 || proc_getpgid(0, &mut group) != 0 || group != 2 {
            proc_exit(44);
        }
        proc_exit(7);
    }
}
#[cfg(case = "grandchild-session")]
#[unsafe(no_mangle)]
pub extern "C" fn _start() {
    unsafe {
        let mut group = 91;
        if proc_getpgid(0, &mut group) != 0 || group != 2 {
            proc_exit(50);
        }
        if proc_setpgid(0, 1) != 63 || proc_setpgid(0, 2) != 0 {
            proc_exit(51);
        }
        if proc_setpgid(0, 0) != 0 || proc_getpgid(0, &mut group) != 0 || group != 3 {
            proc_exit(52);
        }
        if proc_setpgid(0, 2) != 0 || proc_getpgid(0, &mut group) != 0 || group != 2 {
            proc_exit(53);
        }
        proc_exit(7);
    }
}
#[cfg(not(any(
    case = "child-new",
    case = "child-join",
    case = "child-inherit",
    case = "child-session",
    case = "grandchild-session"
)))]
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut group = 91;
        if proc_getpgid(0, &mut group) != 0 || group != 1 || proc_setpgid(0, 0) != 0 {
            return 1;
        }
        group = 91;
        if proc_getpgid(99, &mut group) != 71
            || group != 91
            || proc_getpgid(u32::MAX, &mut group) != 71
            || group != 91
        {
            return 2;
        }
        if proc_setpgid(u32::MAX, 0) != 28
            || proc_setpgid(0, u32::MAX) != 28
            || proc_setpgid(99, 0) != 71
            || proc_setpgid(0, 99) != 63
        {
            return 3;
        }
        if proc_getpgid(0, u32::MAX as *mut u32) != 21
            || proc_getpgid(0, &mut group) != 0
            || group != 1
        {
            return 4;
        }
        let path = b"/tmp/group.wasm";
        let mut pid = 91;
        for (flags, group, expected) in [(2, 99, 63), (2, u32::MAX, 28), (0, 1, 28), (130, 0, 63)] {
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
                flags,
                0,
                0,
                0,
                0,
                group,
                &mut pid,
            ) != expected
                || pid != 91
            {
                return 5;
            }
        }
        let flags = if cfg!(case = "parent-session") {
            128
        } else if cfg!(case = "parent-inherit") {
            0
        } else {
            2
        };
        let requested = if cfg!(case = "parent-join") { 1 } else { 0 };
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
            flags,
            0,
            0,
            0,
            0,
            requested,
            &mut pid,
        ) != 0
            || pid != 2
        {
            return 6;
        }
        let mut code = 91;
        let mut signal = 91;
        let mut waited = 91;
        let mut core = 91;
        if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
            || code != 7
            || signal != 0
            || waited != pid
            || core != 0
        {
            return 7;
        }
        group = 91;
        if proc_getpgid(pid, &mut group) != 71
            || group != 91
            || proc_getpgid(0, &mut group) != 0
            || group != 1
        {
            return 8;
        }
        if proc_setpgid(0, pid) != 63 {
            return 9;
        }
        0
    }
}
