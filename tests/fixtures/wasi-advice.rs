use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_advise(fd: u32, offset: u64, length: u64, advice: u32) -> u32;
    fn path_open(
        fd: u32,
        flags: u32,
        path: *const u8,
        length: usize,
        oflags: u32,
        base: u64,
        inheriting: u64,
        fdflags: u32,
        opened: *mut u32,
    ) -> u32;
    fn fd_close(fd: u32) -> u32;
}

fn main() -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open("/tmp/advice")?;
    file.write_all(b"advice preserves data")?;
    file.seek(SeekFrom::Start(7))?;
    let fd = file.as_raw_fd() as u32;
    for advice in 0..6 {
        assert_eq!(unsafe { fd_advise(fd, 0, 21, advice) }, 0);
        assert_eq!(unsafe { fd_advise(fd, 1 << 63, 0, advice) }, 0);
        assert_eq!(unsafe { fd_advise(fd, 1 << 63, 1024, advice) }, 0);
    }
    assert_eq!(unsafe { fd_advise(fd, 0, 0, 6) }, 28);
    assert_eq!(unsafe { fd_advise(fd, 0, 0, u32::MAX) }, 28);
    assert_eq!(unsafe { fd_advise(fd, u64::MAX, 1, 0) }, 61);
    assert_eq!(unsafe { fd_advise(4000, 0, 0, 0) }, 8);
    assert_eq!(unsafe { fd_advise(3, 0, 0, 0) }, 31);
    assert_eq!(unsafe { fd_advise(1, 0, 0, 0) }, 76);
    assert_eq!(file.stream_position()?, 7);
    assert_eq!(file.metadata()?.len(), 21);
    let mut restricted = 0;
    assert_eq!(
        unsafe {
            path_open(
                3,
                0,
                b"tmp/advice".as_ptr(),
                10,
                0,
                2 | 4 | 32 | (1 << 21),
                0,
                0,
                &mut restricted,
            )
        },
        0
    );
    assert_eq!(unsafe { fd_advise(restricted, 0, 0, 0) }, 76);
    assert_eq!(unsafe { fd_close(restricted) }, 0);
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    assert_eq!(bytes, b"advice preserves data");
    drop(file);
    assert_eq!(unsafe { fd_advise(fd, 0, 0, 0) }, 8);
    println!(
        "advice validated descriptors, rights, enums and ranges without changing bytes or cursor"
    );
    Ok(())
}
