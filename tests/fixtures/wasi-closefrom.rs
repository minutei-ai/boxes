#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn proc_closefrom(minimum: u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
    fn fd_getfd(fd: u32, flags: *mut u32) -> u32;
    fn fd_pipe(reader: *mut u32, writer: *mut u32) -> u32;
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
    fn fd_read(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_prestat_get(fd: u32, output: *mut u8) -> u32;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let path = b"tmp/other";
        let mut fd = 0;
        if path_open(3, 1, path.as_ptr(), path.len() as u32, 0, 2, 0, 0, &mut fd) != 0 || fd != 4 {
            return 1;
        }
        let mut flags = 91;
        if fd_dup2(fd, 9) != 0
            || fd_dup2(1, 8) != 0
            || proc_closefrom(u32::MAX) != 0
            || fd_getfd(9, &mut flags) != 0
        {
            return 2;
        }
        for _ in 0..72 {
            let mut reader = 0;
            let mut writer = 0;
            if fd_pipe(&mut reader, &mut writer) != 0 || reader != 5 || writer != 6 {
                return 3;
            }
            if proc_closefrom(6) != 0
                || fd_getfd(6, &mut flags) != 8
                || fd_getfd(8, &mut flags) != 8
                || fd_getfd(9, &mut flags) != 8
            {
                return 4;
            }
            let mut byte = [0u8];
            let io = Io {
                pointer: byte.as_mut_ptr(),
                length: 1,
            };
            let mut count = 91;
            if fd_read(reader, &io, 1, &mut count) != 0 || count != 0 || fd_close(reader) != 0 {
                return 5;
            }
        }
        let mut byte = [0u8];
        let io = Io {
            pointer: byte.as_mut_ptr(),
            length: 1,
        };
        let mut count = 91;
        if fd_read(4, &io, 1, &mut count) != 0 || count != 1 || byte[0] != b'o' {
            return 6;
        }
        if proc_closefrom(0) != 0 {
            return 7;
        }
        for fd in 0..5 {
            if fd_getfd(fd, &mut flags) != 8 {
                return 8;
            }
        }
        let mut preopen = [0u8; 8];
        if fd_prestat_get(3, preopen.as_mut_ptr()) != 8
            || fd_prestat_get(0x40000003, preopen.as_mut_ptr()) != 0
        {
            return 9;
        }
        if path_open(
            0x40000003,
            1,
            path.as_ptr(),
            path.len() as u32,
            0,
            2,
            0,
            0,
            &mut fd,
        ) != 0
        {
            return 10;
        }
        if fd_read(fd, &io, 1, &mut count) != 0 || count != 1 || byte[0] != b'o' {
            return 11;
        }
        0
    }
}
