#[link(wasm_import_module = "host_fs")]
unsafe extern "C" {
    fn path_mode(fd: u32, path: *const u8, length: u32, follow: u32) -> u32;
    fn fd_mode(fd: u32) -> u32;
    fn open_tmpfile(
        fd: u32,
        path: *const u8,
        length: usize,
        flags: u32,
        mode: u32,
        output: *mut u32,
    ) -> u32;
}

#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn umask(mask: u32, set_mask: u32, previous: *mut u32) -> u32;
    fn proc_umask(mask: u32, previous: *mut u32) -> u32;
}
#[link(wasm_import_module = "host_tty")]
unsafe extern "C" {
    fn set_raw_mode(enabled: u32) -> u32;
    fn read(pointer: *mut u8, length: usize, timeout: u32) -> u32;
}
fn main() -> std::io::Result<()> {
    if std::env::args().any(|arg| arg == "--tty-read") {
        println!("before terminal input");
        std::thread::sleep(std::time::Duration::from_millis(1));
        let mut byte = 0;
        unsafe {
            read(&mut byte, 1, 0);
        }
        panic!("unavailable terminal returned input");
    }
    let mut previous = 0;
    assert_eq!(unsafe { umask(0, 0, &mut previous) }, 0);
    assert_eq!(previous, 0o022);
    assert_eq!(unsafe { umask(0o077, 1, &mut previous) }, 0);
    assert_eq!(previous, 0o022);
    assert_eq!(unsafe { umask(0, 2, &mut previous) }, 28);
    assert_eq!(unsafe { umask(0, u32::MAX, &mut previous) }, 28);
    assert_eq!(unsafe { umask(0, 1, (u32::MAX - 1) as *mut u32) }, 21);
    assert_eq!(unsafe { umask(0, 0, &mut previous) }, 0);
    assert_eq!(previous, 0o077);
    if std::env::args().any(|arg| arg == "--checkpoint") {
        println!("mask checkpoint ready");
        std::thread::sleep(std::time::Duration::from_secs(31));
        assert_eq!(unsafe { umask(0, 0, &mut previous) }, 0);
        assert_eq!(previous, 0o077);
    }
    let mut temporary = 0;
    let path = b"tmp";
    assert_eq!(
        unsafe {
            open_tmpfile(
                3,
                path.as_ptr(),
                path.len(),
                0x14000000,
                0o666,
                &mut temporary,
            )
        },
        0
    );
    assert_eq!(unsafe { fd_mode(temporary) } & 0o777, 0o600);
    std::fs::write("/tmp/masked-file", b"private")?;
    std::fs::create_dir("/tmp/masked-directory")?;
    for (path, mode) in [("tmp/masked-file", 0o600), ("tmp/masked-directory", 0o700)] {
        assert_eq!(
            unsafe { path_mode(3, path.as_ptr(), path.len() as u32, 1) } & 0o777,
            mode
        );
    }
    assert_eq!(unsafe { proc_umask(0o777, &mut previous) }, 0);
    assert_eq!(previous, 0o077);
    std::fs::write("/tmp/zero-mode-file", b"descriptor retained")?;
    let path = b"tmp/zero-mode-file";
    assert_eq!(
        unsafe { path_mode(3, path.as_ptr(), path.len() as u32, 1) } & 0o777,
        0
    );
    assert_eq!(unsafe { proc_umask(0o077, &mut previous) }, 0);
    assert_eq!(previous, 0o777);
    assert_eq!(unsafe { proc_umask(0o1000, &mut previous) }, 0);
    assert_eq!(previous, 0o077);
    std::fs::write("/tmp/unmasked-file", b"shared")?;
    std::fs::create_dir("/tmp/unmasked-directory")?;
    for (path, mode) in [
        ("tmp/unmasked-file", 0o666),
        ("tmp/unmasked-directory", 0o777),
    ] {
        assert_eq!(
            unsafe { path_mode(3, path.as_ptr(), path.len() as u32, 1) } & 0o777,
            mode
        );
    }
    assert_eq!(unsafe { set_raw_mode(1) }, 59);
    assert_eq!(unsafe { set_raw_mode(0) }, 59);
    println!("umask bounds and creation modes verified");
    Ok(())
}
