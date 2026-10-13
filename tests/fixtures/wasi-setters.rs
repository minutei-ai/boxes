use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::time::{Duration, UNIX_EPOCH};

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn path_symlink(
        target: *const u8,
        target_len: usize,
        fd: u32,
        path: *const u8,
        path_len: usize,
    ) -> i32;
    fn path_filestat_set_times(
        fd: u32,
        flags: u32,
        path: *const u8,
        length: usize,
        atime: u64,
        mtime: u64,
        times: u32,
    ) -> i32;
    fn fd_filestat_get(fd: u32, metadata: *mut u8) -> i32;
    fn fd_filestat_set_times(fd: u32, atime: u64, mtime: u64, flags: u32) -> i32;
}

fn check(errno: i32) -> std::io::Result<()> {
    if errno == 0 {
        return Ok(());
    }
    Err(std::io::Error::from_raw_os_error(errno))
}

fn main() -> std::io::Result<()> {
    std::fs::create_dir("/tmp/setters-dir")?;
    std::fs::write("/tmp/setters", b"original")?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/setters")?;
    file.seek(SeekFrom::Start(6))?;
    file.set_len(2)?;
    assert_eq!(file.stream_position()?, 6);
    file.set_len(8)?;
    assert_eq!(file.stream_position()?, 6);
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    assert_eq!(bytes, b"or\0\0\0\0\0\0");
    let times = std::fs::FileTimes::new()
        .set_accessed(UNIX_EPOCH + Duration::from_nanos(100))
        .set_modified(UNIX_EPOCH + Duration::from_nanos(200));
    file.set_times(times)?;
    const LINK: &[u8] = b"tmp/setters-link";
    const TARGET: &[u8] = b"setters";
    check(unsafe { path_symlink(TARGET.as_ptr(), TARGET.len(), 3, LINK.as_ptr(), LINK.len()) })?;
    check(unsafe { path_filestat_set_times(3, 0, LINK.as_ptr(), LINK.len(), 111, 222, 5) })?;
    check(unsafe { path_filestat_set_times(3, 1, LINK.as_ptr(), LINK.len(), 333, 444, 5) })?;
    const DIRECTORY: &[u8] = b"tmp/setters-dir";
    check(unsafe {
        path_filestat_set_times(3, 1, DIRECTORY.as_ptr(), DIRECTORY.len(), 555, 666, 5)
    })?;
    const PRECISE: u64 = 9_007_199_254_740_995;
    check(unsafe { fd_filestat_set_times(file.as_raw_fd() as u32, u64::MAX, PRECISE, 5) })?;
    let mut metadata = [0u8; 64];
    check(unsafe { fd_filestat_get(file.as_raw_fd() as u32, metadata.as_mut_ptr()) })?;
    assert_eq!(&metadata[40..48], &u64::MAX.to_le_bytes());
    assert_eq!(&metadata[48..56], &PRECISE.to_le_bytes());
    std::fs::write("/tmp/setters-detached", b"detached")?;
    let detached = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/setters-detached")?;
    std::fs::remove_file("/tmp/setters-detached")?;
    detached.set_len(3)?;
    check(unsafe { fd_filestat_set_times(detached.as_raw_fd() as u32, 777, 888, 5) })?;
    check(unsafe { fd_filestat_get(detached.as_raw_fd() as u32, metadata.as_mut_ptr()) })?;
    assert_eq!(&metadata[24..32], &0u64.to_le_bytes());
    assert_eq!(&metadata[32..40], &3u64.to_le_bytes());
    assert_eq!(&metadata[40..48], &777u64.to_le_bytes());
    assert_eq!(&metadata[48..56], &888u64.to_le_bytes());
    assert!(!std::fs::exists("/tmp/setters-detached")?);
    println!("setters preserved offsets, zeros, precise times and detached inodes");
    Ok(())
}
