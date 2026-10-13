use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};

#[link(wasm_import_module = "host_fs")]
unsafe extern "C" {
    fn set_open_mode(mode: u32) -> i32;
    fn set_open_direct(enabled: u32) -> i32;
    fn open_tmpfile(
        fd: u32,
        path: *const u8,
        length: usize,
        flags: u32,
        mode: u32,
        output: *mut u32,
    ) -> i32;
}
#[link(wasm_import_module = "host_net")]
unsafe extern "C" {
    fn net_send(fd: u32, bytes: *const u8, length: usize, flags: u32, output: *mut u32) -> i32;
    fn net_recv(fd: u32, bytes: *mut u8, length: usize, flags: u32, output: *mut u32) -> i32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_close(fd: u32) -> i32;
    fn fd_prestat_get(fd: u32, output: *mut u8) -> i32;
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        length: usize,
        flags: u32,
        rights: u64,
        inheriting: u64,
        fdflags: u32,
        output: *mut u32,
    ) -> i32;
}
fn main() -> std::io::Result<()> {
    let path = b"tmp";
    let mut fd = 0;
    if std::env::args().any(|arg| arg == "--denied") {
        assert_eq!(
            unsafe { open_tmpfile(3, path.as_ptr(), path.len(), 0x14000000, 0o600, &mut fd) },
            2
        );
        println!("temporary file denied");
        return Ok(());
    }
    assert_eq!(unsafe { set_open_mode(0o600) }, 0);
    std::fs::write("/tmp/mode-explicit", b"private")?;
    std::fs::write("/tmp/mode-default", b"default")?;
    assert_eq!(unsafe { set_open_direct(1) }, 0);
    assert!(std::fs::File::open("/tmp/mode-default").is_err());
    let regular = std::fs::File::open("/tmp/mode-default")?;
    let mut count = 0;
    let mut bytes = [0u8; 1];
    assert_eq!(
        unsafe { net_send(regular.as_raw_fd() as u32, bytes.as_ptr(), 1, 0, &mut count) },
        57
    );
    assert_eq!(
        unsafe { net_recv(999, bytes.as_mut_ptr(), 1, 0, &mut count) },
        8
    );
    assert_eq!(
        unsafe { open_tmpfile(3, path.as_ptr(), path.len(), 0x14000000, 0o600, &mut fd) },
        0
    );
    let protected = b"opt/cirro";
    let mut protected_fd = 0;
    assert_eq!(
        unsafe {
            open_tmpfile(
                3,
                protected.as_ptr(),
                protected.len(),
                0x14000000,
                0o600,
                &mut protected_fd,
            )
        },
        69
    );
    let mut file = unsafe { std::fs::File::from_raw_fd(fd as i32) };
    file.write_all(b"detached")?;
    file.sync_all()?;
    file.seek(SeekFrom::Start(0))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    assert_eq!(contents, "detached");
    assert_eq!(file.metadata()?.len(), 8);
    assert_eq!(unsafe { fd_close(3) }, 0);
    assert_eq!(unsafe { fd_close(0x40000003) }, 8);
    let mut preopen = [0u8; 8];
    assert_eq!(
        unsafe { fd_prestat_get(0x40000003, preopen.as_mut_ptr()) },
        0
    );
    assert_eq!(unsafe { fd_prestat_get(3, preopen.as_mut_ptr()) }, 8);
    assert_eq!(
        unsafe { fd_prestat_get(0x40000004, preopen.as_mut_ptr()) },
        8
    );
    let hidden_path = b"tmp/mode-default";
    let mut hidden_fd = 0;
    assert_eq!(
        unsafe {
            path_open(
                0x40000003,
                1,
                hidden_path.as_ptr(),
                hidden_path.len(),
                0,
                2 | 4 | 32 | (1 << 21),
                0,
                0,
                &mut hidden_fd,
            )
        },
        0
    );
    let mut hidden_file = unsafe { std::fs::File::from_raw_fd(hidden_fd as i32) };
    let mut hidden_contents = String::new();
    hidden_file.read_to_string(&mut hidden_contents)?;
    assert_eq!(hidden_contents, "default");
    println!("creation modes and detached temporary file passed");
    Ok(())
}
