#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
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
    fn proc_spawn_v4(
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
        search: *const u8,
        search_len: u32,
        flags: u32,
        default_lo: u32,
        default_hi: u32,
        mask_lo: u32,
        mask_hi: u32,
        group: u32,
        policy: u32,
        priority: u32,
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
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        len: u32,
        flags: u32,
        rights: u64,
        inherit: u64,
        fdflags: u32,
        output: *mut u32,
    ) -> u32;
}
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut actions = [0u8; 256];
        let mut length = 0usize;
        if cfg!(case = "chdir") || cfg!(case = "symlink") || cfg!(case = "path-chdir") {
            let path = if cfg!(case = "symlink") {
                b"link"
            } else {
                b"work"
            };
            actions[..4].copy_from_slice(&4u32.to_le_bytes());
            actions[20..24].copy_from_slice(&4u32.to_le_bytes());
            actions[24..28].copy_from_slice(path);
            length = 28;
        }
        if cfg!(case = "fchdir") {
            let path = b"tmp/work";
            let mut fd = 0;
            if path_open(
                3,
                1,
                path.as_ptr(),
                path.len() as u32,
                2,
                1 << 14,
                0,
                0,
                &mut fd,
            ) != 0
            {
                return 1;
            }
            for (index, (command, target, source)) in [(2u32, 12, fd), (1, fd, 0), (5, 12, 0)]
                .iter()
                .copied()
                .enumerate()
            {
                let offset = index * 24;
                actions[offset..offset + 4].copy_from_slice(&command.to_le_bytes());
                actions[offset + 4..offset + 8].copy_from_slice(&target.to_le_bytes());
                actions[offset + 8..offset + 12].copy_from_slice(&source.to_le_bytes());
            }
            length = 72;
        }
        if cfg!(case = "closed") {
            for (index, command) in [1u32, 5].iter().copied().enumerate() {
                let offset = index * 24;
                actions[offset..offset + 4].copy_from_slice(&command.to_le_bytes());
                actions[offset + 4..offset + 8].copy_from_slice(&3u32.to_le_bytes());
            }
            length = 48;
        }
        if cfg!(case = "malformed") {
            actions[..4].copy_from_slice(&4u32.to_le_bytes());
            actions[20..24].copy_from_slice(&99u32.to_le_bytes());
            length = 24;
        }
        if cfg!(case = "redirect")
            || cfg!(case = "open-dir")
            || cfg!(case = "exclusive")
            || cfg!(case = "open-close")
            || cfg!(case = "closefrom")
            || cfg!(case = "readonly")
            || cfg!(case = "nofollow")
        {
            let path = if cfg!(case = "open-dir") {
                b"work".as_slice()
            } else if cfg!(case = "readonly") {
                b"/opt/cirro/bin/jq".as_slice()
            } else if cfg!(case = "nofollow") {
                b"work/jq".as_slice()
            } else if cfg!(case = "exclusive") {
                b"work/input.json".as_slice()
            } else {
                b"work/output.txt".as_slice()
            };
            let flags = if cfg!(case = "open-dir") {
                0x10000u32
            } else if cfg!(case = "readonly") {
                1
            } else if cfg!(case = "nofollow") {
                0x20000
            } else if cfg!(case = "exclusive") {
                0xc1
            } else {
                0x241
            };
            for (index, value) in [3u32, 12, 0, flags, 0o600, path.len() as u32]
                .iter()
                .enumerate()
            {
                actions[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
            }
            actions[24..24 + path.len()].copy_from_slice(path);
            length = 24 + path.len();
            let next = if cfg!(case = "open-dir") {
                5u32
            } else if cfg!(case = "closefrom") {
                6
            } else if cfg!(case = "open-close") {
                1
            } else {
                2
            };
            actions[length..length + 4].copy_from_slice(&next.to_le_bytes());
            let target = if next == 2 { 1u32 } else { 12 };
            actions[length + 4..length + 8].copy_from_slice(&target.to_le_bytes());
            if next == 2 {
                actions[length + 8..length + 12].copy_from_slice(&12u32.to_le_bytes());
            }
            length += 24;
            if cfg!(case = "redirect") {
                actions[length..length + 4].copy_from_slice(&1u32.to_le_bytes());
                actions[length + 4..length + 8].copy_from_slice(&12u32.to_le_bytes());
                length += 24;
            }
            if cfg!(case = "open-close") || cfg!(case = "closefrom") {
                actions[length..length + 4].copy_from_slice(&2u32.to_le_bytes());
                actions[length + 4..length + 8].copy_from_slice(&1u32.to_le_bytes());
                actions[length + 8..length + 12].copy_from_slice(&12u32.to_le_bytes());
                length += 24;
            }
            if cfg!(case = "redirect") {
                let offset = length;
                actions[offset..offset + 4].copy_from_slice(&4u32.to_le_bytes());
                actions[offset + 20..offset + 24].copy_from_slice(&4u32.to_le_bytes());
                actions[offset + 24..offset + 28].copy_from_slice(b"work");
                length += 28;
            }
        }
        if cfg!(case = "closefrom-root")
            || cfg!(case = "closefrom-high")
            || cfg!(case = "closefrom-negative")
        {
            actions.fill(0);
            actions[..4].copy_from_slice(&6u32.to_le_bytes());
            let minimum = if cfg!(case = "closefrom-negative") {
                u32::MAX
            } else if cfg!(case = "closefrom-high") {
                1024
            } else {
                3
            };
            actions[4..8].copy_from_slice(&minimum.to_le_bytes());
            length = 24;
            if !cfg!(case = "closefrom-negative") {
                actions[24..28].copy_from_slice(&4u32.to_le_bytes());
                actions[44..48].copy_from_slice(&4u32.to_le_bytes());
                actions[48..52].copy_from_slice(b"work");
                length = 52;
            }
        }
        let cwd = if cfg!(case = "explicit")
            || cfg!(case = "relative")
            || cfg!(case = "path-empty")
            || cfg!(case = "path-absolute")
            || cfg!(case = "path-slash")
            || cfg!(case = "sched-zero")
        {
            b"/tmp/work".as_slice()
        } else if cfg!(case = "missing") {
            b"/tmp/absent".as_slice()
        } else if cfg!(case = "file") {
            b"/tmp/work/input.json".as_slice()
        } else {
            b"/tmp".as_slice()
        };
        let path = if cfg!(case = "relative")
            || cfg!(case = "path-absolute")
            || cfg!(case = "path-empty")
            || cfg!(case = "path-chdir")
            || cfg!(case = "path-missing")
            || cfg!(case = "path-absent")
            || cfg!(case = "path-denied")
        {
            b"jq".as_slice()
        } else {
            b"/opt/cirro/bin/jq".as_slice()
        };
        let argv = b"kept argv0\0.value\0input.json\0";
        let env = b"PWD=/wrong\0";
        let mut pid = 91;
        let status = if cfg!(case = "path-absolute")
            || cfg!(case = "path-empty")
            || cfg!(case = "path-chdir")
            || cfg!(case = "path-slash")
            || cfg!(case = "path-missing")
            || cfg!(case = "path-absent")
            || cfg!(case = "path-denied")
            || cfg!(case = "sched-zero")
            || cfg!(case = "sched-priority")
            || cfg!(case = "sched-policy")
        {
            let search = if cfg!(case = "path-absolute") {
                b"/missing:/tmp/work/input.json:/tmp/denied:/opt/cirro/bin".as_slice()
            } else if cfg!(case = "path-missing") || cfg!(case = "path-slash") {
                b"/missing".as_slice()
            } else if cfg!(case = "path-denied") {
                b"/tmp/denied:/missing".as_slice()
            } else {
                b"".as_slice()
            };
            let search_ptr = if cfg!(case = "path-absent") {
                std::ptr::null()
            } else {
                search.as_ptr()
            };
            let flags = if cfg!(case = "sched-priority") {
                16
            } else if cfg!(case = "sched-policy") || cfg!(case = "sched-zero") {
                32
            } else {
                0
            };
            proc_spawn_v4(
                path.as_ptr(),
                path.len() as u32,
                argv.as_ptr(),
                argv.len() as u32,
                env.as_ptr(),
                env.len() as u32,
                actions.as_ptr(),
                length as u32,
                cwd.as_ptr(),
                cwd.len() as u32,
                search_ptr,
                search.len() as u32,
                flags,
                0,
                0,
                0,
                0,
                0,
                u32::from(cfg!(case = "sched-policy")),
                u32::from(cfg!(case = "sched-priority")),
                &mut pid,
            )
        } else {
            proc_spawn_v3(
                path.as_ptr(),
                path.len() as u32,
                argv.as_ptr(),
                argv.len() as u32,
                env.as_ptr(),
                env.len() as u32,
                actions.as_ptr(),
                length as u32,
                cwd.as_ptr(),
                cwd.len() as u32,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut pid,
            )
        };
        if cfg!(case = "path-missing")
            || cfg!(case = "path-absent")
            || cfg!(case = "path-denied")
            || cfg!(case = "sched-priority")
            || cfg!(case = "sched-policy")
            || cfg!(case = "missing")
            || cfg!(case = "file")
            || cfg!(case = "closed")
            || cfg!(case = "malformed")
            || cfg!(case = "closefrom-negative")
            || cfg!(case = "exclusive")
            || cfg!(case = "open-close")
            || cfg!(case = "closefrom")
            || cfg!(case = "readonly")
            || cfg!(case = "nofollow")
        {
            if pid != 91 {
                return 99;
            }
            return status as i32;
        }
        if status != 0 {
            return 500 + status as i32;
        }
        let mut code = 91;
        let mut signal = 0;
        let mut waited = 0;
        let mut core = 0;
        if proc_waitpid_v2(pid, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
            || code != 0
            || waited != pid
        {
            return 2;
        }
        0
    }
}
