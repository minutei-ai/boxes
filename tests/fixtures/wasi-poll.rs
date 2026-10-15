use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_allocate(fd: u32, offset: u64, length: u64) -> i32;
    fn poll_oneoff(input: *const u8, output: *mut u8, count: usize, ready: *mut u32) -> i32;
}

fn check(errno: i32) -> std::io::Result<()> {
    if errno == 0 {
        return Ok(());
    }
    Err(std::io::Error::from_raw_os_error(errno))
}

fn main() -> std::io::Result<()> {
    std::fs::write("/tmp/allocated", b"original")?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/allocated")?;
    file.seek(SeekFrom::Start(3))?;
    check(unsafe { fd_allocate(file.as_raw_fd() as u32, 10, 6) })?;
    assert_eq!(file.stream_position()?, 3);
    assert_eq!(file.metadata()?.len(), 16);
    check(unsafe { fd_allocate(file.as_raw_fd() as u32, 0, 1) })?;
    assert_eq!(file.metadata()?.len(), 16);
    let mut subscriptions = [0u8; 192];
    subscriptions[..8].copy_from_slice(&u64::MAX.to_le_bytes());
    subscriptions[8] = 1;
    subscriptions[16..20].copy_from_slice(&(file.as_raw_fd() as u32).to_le_bytes());
    subscriptions[48..56].copy_from_slice(&2u64.to_le_bytes());
    subscriptions[56] = 1;
    subscriptions[96..104].copy_from_slice(&3u64.to_le_bytes());
    subscriptions[104] = 1;
    subscriptions[112..116].copy_from_slice(&999u32.to_le_bytes());
    subscriptions[144..152].copy_from_slice(&4u64.to_le_bytes());
    subscriptions[160..164].copy_from_slice(&1u32.to_le_bytes());
    let mut events = [0u8; 128];
    let mut ready = 0;
    check(unsafe { poll_oneoff(subscriptions.as_ptr(), events.as_mut_ptr(), 4, &mut ready) })?;
    assert_eq!(ready, 4);
    assert_eq!(&events[..8], &u64::MAX.to_le_bytes());
    assert_eq!(&events[16..24], &13u64.to_le_bytes());
    assert_eq!(&events[56..58], &1u16.to_le_bytes());
    assert_eq!(&events[72..74], &8u16.to_le_bytes());
    assert_eq!(&events[96..104], &4u64.to_le_bytes());
    let started = Instant::now();
    std::thread::sleep(Duration::from_millis(10));
    assert!(started.elapsed() >= Duration::from_millis(10));
    let delay = match std::env::args().nth(1).as_deref() {
        None | Some("nanosecond") => Duration::from_nanos(1),
        Some("millisecond") => Duration::from_millis(1),
        _ => return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
    };
    for _ in 0..3 {
        std::thread::sleep(delay);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)?;
    assert_eq!(&contents[..8], b"original");
    assert_eq!(&contents[8..], &[0u8; 8]);
    println!("allocation preserved cursor and zeros; poll preserved userdata, EOF and clocks");
    Ok(())
}
