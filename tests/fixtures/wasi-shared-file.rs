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
    fn fd_read(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_seek(fd: u32, offset: i64, whence: u32, output: *mut u64) -> u32;
    fn fd_tell(fd: u32, output: *mut u64) -> u32;
    fn clock_time_get(clock: u32, precision: u64, output: *mut u64) -> u32;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut position = 0;
        if !cfg!(case = "child") {
            let path = b"tmp/shared";
            let mut fd = 0;
            if path_open(
                3,
                1,
                path.as_ptr(),
                path.len() as u32,
                0,
                2 | 4 | 32 | 64 | (1 << 21),
                0,
                0,
                &mut fd,
            ) != 0
                || fd != 4
            {
                return 1;
            }
            if fd_seek(fd, 2, 0, &mut position) != 0 {
                return 2;
            }
            if clock_time_get(0, 0, &mut position) != 0 {
                return 3;
            }
            return 0;
        }
        let mut bytes = [0u8; 4];
        let mut count = 0;
        let one = Io {
            pointer: bytes.as_mut_ptr(),
            length: 1,
        };
        if fd_read(4, &one, 1, &mut count) != 0 || count != 1 || bytes[0] != b'c' {
            return 4;
        }
        bytes[0] = b'X';
        count = 91;
        let status = fd_write(4, &one, 1, &mut count);
        let expected = if status == 0 { 4 } else { 3 };
        if status != 0 && status != 2 {
            return 5;
        }
        if status == 0 && count != 1 || status == 2 && count != 91 {
            return 6;
        }
        if fd_tell(4, &mut position) != 0 || position != expected {
            return 7;
        }
        if fd_seek(4, 0, 0, &mut position) != 0 {
            return 8;
        }
        let all = Io {
            pointer: bytes.as_mut_ptr(),
            length: 4,
        };
        if fd_read(4, &all, 1, &mut count) != 0 || count != expected as u32 {
            return 9;
        }
        if bytes[..3] != *b"abc" || status == 0 && bytes[3] != b'X' {
            return 10;
        }
        0
    }
}
