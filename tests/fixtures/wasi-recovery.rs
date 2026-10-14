#[repr(C)]
struct Io {
    pointer: *const u8,
    length: u32,
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
        out: *mut u32,
    ) -> u32;
    fn fd_write(fd: u32, io: *const Io, count: u32, out: *mut u32) -> u32;
    fn fd_sync(fd: u32) -> u32;
}
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let path = b"tmp/recovery-counter";
        let mut fd = 0;
        let mut count = 0;
        if path_open(3, 1, path.as_ptr(), path.len() as u32, 1, 86, 0, 1, &mut fd) != 0 {
            return 1;
        }
        let a = Io {
            pointer: b"A".as_ptr(),
            length: 1,
        };
        if fd_write(fd, &a, 1, &mut count) != 0
            || count != 1
            || (!cfg!(case = "unsynced") && fd_sync(fd) != 0)
        {
            return 2;
        }
        let marker = b"entered once\n";
        let line = Io {
            pointer: marker.as_ptr(),
            length: marker.len() as u32,
        };
        if fd_write(1, &line, 1, &mut count) != 0 {
            return 3;
        }
        let mut value = 0u32;
        let mut index = 0u32;
        while index < 3_000_000 {
            value = value.wrapping_add(std::ptr::read_volatile(&index));
            index = index.wrapping_add(1);
        }
        let b = Io {
            pointer: b"B".as_ptr(),
            length: 1,
        };
        if fd_write(fd, &b, 1, &mut count) != 0 || count != 1 || fd_sync(fd) != 0 {
            return 4;
        }
        (value % 1024) as i32
    }
}
