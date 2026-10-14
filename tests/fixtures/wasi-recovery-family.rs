#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_kill(pid: u32, signal: u32) -> u32;
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
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let path = b"/tmp/recovery-child.wasm";
        let mut child = 0;
        let status = proc_spawn_v3(
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
            &mut child,
        );
        if status != 0 {
            return 100 + status as i32;
        }
        if cfg!(case = "stopped") && proc_kill(1, 19) != 0 {
            return 150;
        }
        let mut code = 0;
        let mut signal = 0;
        let mut waited = 0;
        let mut core = 0;
        if proc_waitpid_v2(child, 0, &mut code, &mut signal, &mut waited, &mut core) != 0
            || waited != child
            || signal != 0
            || core != 0
        {
            return 200;
        }
        code as i32
    }
}
