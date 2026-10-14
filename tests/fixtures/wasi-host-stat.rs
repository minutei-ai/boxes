#[link(wasm_import_module = "host_fs")]
unsafe extern "C" {
    fn path_mode(fd: u32, path: *const u8, length: u32, follow: u32) -> u32;
    fn path_size(fd: u32, path: *const u8, length: u32, follow: u32) -> u64;
    fn path_blocks(fd: u32, path: *const u8, length: u32, follow: u32) -> u64;
    fn path_owner(
        fd: u32,
        path: *const u8,
        length: u32,
        follow: u32,
        uid: *mut u32,
        gid: *mut u32,
    ) -> u32;
    fn fd_mode(fd: u32) -> u32;
    fn fd_size(fd: u32) -> u64;
    fn fd_blocks(fd: u32) -> u64;
    fn fd_owner(fd: u32, uid: *mut u32, gid: *mut u32) -> u32;
}
#[link(wasm_import_module = "host_user")]
unsafe extern "C" {
    fn isatty(fd: u32, output: *mut u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        length: u32,
        flags: u32,
        rights: u64,
        inherit: u64,
        fdflags: u32,
        output: *mut u32,
    ) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn fd_filestat_get(fd: u32, output: *mut u8) -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let path = b"tmp/meta";
        let link = b"tmp/link";
        let missing = b"tmp/missing";
        let mut uid = 91;
        let mut gid = 92;
        let root = 0x40000003;
        if cfg!(case = "denied") {
            if path_mode(root, path.as_ptr(), path.len() as u32, 1) != 0
                || path_size(root, path.as_ptr(), path.len() as u32, 1) != u64::MAX
                || path_blocks(root, path.as_ptr(), path.len() as u32, 1) != u64::MAX
                || path_owner(
                    root,
                    path.as_ptr(),
                    path.len() as u32,
                    1,
                    &mut uid,
                    &mut gid,
                ) != 2
                || uid != 91
                || gid != 92
            {
                return 22;
            }
            return 0;
        }
        if path_mode(root, path.as_ptr(), path.len() as u32, 1) != 0o100640 {
            return 1;
        }
        if path_size(root, path.as_ptr(), path.len() as u32, 1) != 513 {
            return 2;
        }
        if path_blocks(root, path.as_ptr(), path.len() as u32, 1) != 2 {
            return 3;
        }
        if path_owner(
            root,
            path.as_ptr(),
            path.len() as u32,
            1,
            &mut uid,
            &mut gid,
        ) != 0
            || uid != 0
            || gid != 0
        {
            return 4;
        }
        if path_mode(root, link.as_ptr(), link.len() as u32, 0) != 0o120777 {
            return 5;
        }
        if path_mode(root, link.as_ptr(), link.len() as u32, 1) != 0o100640 {
            return 6;
        }
        if path_size(root, missing.as_ptr(), missing.len() as u32, 1) != u64::MAX {
            return 7;
        }
        if path_blocks(root, missing.as_ptr(), missing.len() as u32, 1) != u64::MAX {
            return 8;
        }
        if path_mode(root, missing.as_ptr(), missing.len() as u32, 1) != 0 {
            return 9;
        }
        if path_owner(
            root,
            missing.as_ptr(),
            missing.len() as u32,
            1,
            &mut uid,
            &mut gid,
        ) != 44
        {
            return 10;
        }
        let mut fd = 0;
        if path_open(
            3,
            1,
            path.as_ptr(),
            path.len() as u32,
            0,
            (1 << 1) | (1 << 21),
            0,
            0,
            &mut fd,
        ) != 0
        {
            return 11;
        }
        if fd_mode(fd) != 0o100640 || fd_size(fd) != 513 || fd_blocks(fd) != 2 {
            return 12;
        }
        if fd_owner(fd, &mut uid, &mut gid) != 0 || uid != 0 || gid != 0 {
            return 13;
        }
        let mut stat = [0u8; 68];
        stat[64..].fill(123);
        if fd_filestat_get(fd, stat.as_mut_ptr()) != 0 || stat[64..] != [123; 4] {
            return 14;
        }
        uid = 91;
        if fd_owner(fd, &mut uid, u32::MAX as *mut u32) != 21 || uid != 91 {
            return 15;
        }
        let mut tty = 91;
        if isatty(fd, &mut tty) != 0 || tty != 0 {
            return 16;
        }
        if fd_close(fd) != 0
            || fd_mode(fd) != 0
            || fd_size(fd) != u64::MAX
            || fd_blocks(fd) != u64::MAX
            || fd_owner(fd, &mut uid, &mut gid) != 8
        {
            return 17;
        }
        if isatty(fd, &mut tty) != 8 {
            return 18;
        }
        if fd_mode(1) != 0o20000 || fd_size(1) != 0 || isatty(1, &mut tty) != 0 || tty != 0 {
            return 19;
        }
        let restricted = b"tmp/restricted";
        let escape = b"escape";
        let mut directory = 0;
        if path_open(
            3,
            1,
            restricted.as_ptr(),
            restricted.len() as u32,
            2,
            1 << 18,
            0,
            0,
            &mut directory,
        ) != 0
        {
            return 23;
        }
        if path_mode(directory, escape.as_ptr(), escape.len() as u32, 0) != 0o120777
            || path_mode(directory, escape.as_ptr(), escape.len() as u32, 1) != 0
            || path_size(directory, escape.as_ptr(), escape.len() as u32, 1) != u64::MAX
            || path_owner(
                directory,
                escape.as_ptr(),
                escape.len() as u32,
                1,
                &mut uid,
                &mut gid,
            ) != 76
        {
            return 24;
        }
        if fd_close(directory) != 0 {
            return 25;
        }
        if fd_close(3) != 0 || path_mode(root, path.as_ptr(), path.len() as u32, 1) != 0o100640 {
            return 20;
        }
        let blocked = b"tmp/link";
        if path_owner(
            root,
            blocked.as_ptr(),
            blocked.len() as u32,
            2,
            &mut uid,
            &mut gid,
        ) != 28
        {
            return 21;
        }
        0
    }
}
