#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_write(fd: u32, vectors: *const Io, length: u32, count: *mut u32) -> u32;
}
#[repr(C)]
struct Io {
    pointer: *const u8,
    length: u32,
}
#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    let marker = b"cpu loop started\n";
    let io = Io {
        pointer: marker.as_ptr(),
        length: marker.len() as u32,
    };
    let mut count = 0;
    if unsafe { fd_write(1, &io, 1, &mut count) } != 0 {
        return -1;
    }
    let mut value = 0u32;
    let mut index = 0u32;
    while cfg!(case = "infinite") || index < 200_000 {
        value = value.wrapping_add(unsafe { std::ptr::read_volatile(&index) });
        index = index.wrapping_add(1);
    }
    (value % 1024) as i32
}
