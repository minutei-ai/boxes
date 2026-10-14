use std::convert::TryInto;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;

#[repr(C)]
struct Vector {
    pointer: *mut u8,
    length: usize,
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_fdstat_get(fd: u32, stat: *mut u8) -> u32;
    fn fd_fdstat_set_rights(fd: u32, base: u64, inheriting: u64) -> u32;
    fn fd_fdstat_set_flags(fd: u32, flags: u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Vector, count: usize, written: *mut u32) -> u32;
    fn fd_read(fd: u32, vectors: *const Vector, count: usize, read: *mut u32) -> u32;
    fn fd_advise(fd: u32, offset: u64, length: u64, advice: u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn fd_renumber(fd: u32, target: u32) -> u32;
    fn poll_oneoff(input: *const u8, output: *mut u8, count: usize, events: *mut u32) -> u32;
    fn path_open(
        fd: u32,
        flags: u32,
        path: *const u8,
        length: usize,
        oflags: u32,
        base: u64,
        inheriting: u64,
        fdflags: u32,
        output: *mut u32,
    ) -> u32;
}
#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn fd_dup(fd: u32, output: *mut u32) -> u32;
    fn fd_pipe(reader: *mut u32, writer: *mut u32) -> u32;
}
fn rights(fd: u32) -> (u64, u64) {
    let mut stat = [0u8; 24];
    assert_eq!(unsafe { fd_fdstat_get(fd, stat.as_mut_ptr()) }, 0);
    (
        u64::from_le_bytes(stat[8..16].try_into().unwrap()),
        u64::from_le_bytes(stat[16..24].try_into().unwrap()),
    )
}
fn main() -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open("/tmp/rights")?;
    file.write_all(b"retained")?;
    file.seek(SeekFrom::Start(0))?;
    let fd = file.as_raw_fd() as u32;
    let before = rights(fd);
    assert_eq!(
        unsafe { fd_fdstat_set_rights(fd, before.0 & !64, 1 << 63) },
        76
    );
    assert_eq!(rights(fd), before);
    let reduced = before.0 & !(64 | (1 << 7) | (1 << 3));
    assert_eq!(unsafe { fd_fdstat_set_rights(fd, reduced, 0) }, 0);
    assert_eq!(rights(fd), (reduced, 0));
    assert_eq!(unsafe { fd_fdstat_set_rights(fd, before.0, before.1) }, 76);
    assert_eq!(
        unsafe { fd_fdstat_set_rights(fd, reduced | (1 << 63), 0) },
        76
    );
    let mut byte = [b'X'];
    let vector = Vector {
        pointer: byte.as_mut_ptr(),
        length: 1,
    };
    let mut count = 0xdeadbeef;
    assert_eq!(unsafe { fd_write(fd, &vector, 1, &mut count) }, 76);
    assert_eq!(count, 0xdeadbeef);
    assert_eq!(unsafe { fd_advise(fd, 0, 0, 0) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_flags(fd, 0) }, 76);
    let mut duplicate = 0;
    assert_eq!(unsafe { fd_dup(fd, &mut duplicate) }, 0);
    assert_eq!(rights(duplicate), (reduced, 0));
    assert_eq!(unsafe { fd_write(duplicate, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_rights(duplicate, before.0, 0) }, 76);
    assert_eq!(unsafe { fd_close(duplicate) }, 0);
    assert_eq!(unsafe { fd_fdstat_set_rights(duplicate, 0, 0) }, 8);
    let mut reader = 0;
    let mut writer = 0;
    assert_eq!(unsafe { fd_pipe(&mut reader, &mut writer) }, 0);
    let pipe = rights(writer);
    assert_eq!(unsafe { fd_fdstat_set_rights(writer, pipe.0 & !64, 0) }, 0);
    assert_eq!(unsafe { fd_write(writer, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_rights(writer, pipe.0, 0) }, 76);
    let input = rights(reader);
    assert_eq!(unsafe { fd_fdstat_set_rights(reader, input.0 & !2, 0) }, 0);
    assert_eq!(unsafe { fd_read(reader, &vector, 1, &mut count) }, 76);
    let mut target = 0;
    assert_eq!(unsafe { fd_dup(1, &mut target) }, 0);
    assert_eq!(unsafe { fd_renumber(writer, target) }, 0);
    assert_eq!(rights(target), (pipe.0 & !64, 0));
    assert_eq!(unsafe { fd_write(target, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_close(target) }, 0);
    assert_eq!(unsafe { fd_close(reader) }, 0);
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;
    assert_eq!(data, b"retained");
    assert_eq!(unsafe { fd_fdstat_set_rights(fd, reduced & !2, 0) }, 0);
    assert_eq!(unsafe { fd_read(fd, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_rights(4000, 0, 0) }, 8);
    let mut output = 0;
    assert_eq!(unsafe { fd_dup(1, &mut output) }, 0);
    let stdout = rights(1);
    assert_eq!(unsafe { fd_fdstat_set_rights(1, 0, 0) }, 0);
    assert_eq!(rights(1), (0, 0));
    assert_eq!(unsafe { fd_write(1, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_flags(1, 0) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_rights(1, stdout.0, 0) }, 76);
    let mut subscription = [0u8; 48];
    subscription[8] = 2;
    subscription[16..20].copy_from_slice(&1u32.to_le_bytes());
    let mut event = [0u8; 32];
    let mut events = 0;
    assert_eq!(
        unsafe { poll_oneoff(subscription.as_ptr(), event.as_mut_ptr(), 1, &mut events) },
        0
    );
    assert_eq!(events, 1);
    assert_eq!(u16::from_le_bytes(event[8..10].try_into().unwrap()), 76);
    let mut restricted = 0;
    assert_eq!(unsafe { fd_dup(1, &mut restricted) }, 0);
    assert_eq!(rights(restricted), (0, 0));
    assert_eq!(unsafe { fd_write(restricted, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_rights(0, 0, 0) }, 0);
    assert_eq!(unsafe { fd_read(0, &vector, 1, &mut count) }, 76);
    let parent = rights(3);
    assert_eq!(
        unsafe { fd_fdstat_set_rights(3, parent.0 & !((1 << 10) | (1 << 19)), parent.1) },
        0
    );
    let mut opened = 0;
    assert_eq!(
        unsafe { path_open(3, 0, b"tmp/denied".as_ptr(), 10, 1, 64, 0, 0, &mut opened) },
        76
    );
    assert_eq!(
        unsafe { path_open(3, 0, b"tmp/rights".as_ptr(), 10, 8, 64, 0, 0, &mut opened) },
        76
    );
    let parent = rights(3);
    assert_eq!(unsafe { fd_fdstat_set_rights(3, parent.0, 0) }, 0);
    assert_eq!(
        unsafe { path_open(3, 0, b"tmp/rights".as_ptr(), 10, 0, 2, 0, 0, &mut opened) },
        76
    );
    assert_eq!(unsafe { fd_fdstat_set_rights(3, parent.0, parent.1) }, 76);
    #[cfg(case = "checkpoint")]
    {
        let mut marker = b"rights checkpoint\n".to_vec();
        let marker = Vector {
            pointer: marker.as_mut_ptr(),
            length: marker.len(),
        };
        assert_eq!(unsafe { fd_write(output, &marker, 1, &mut count) }, 0);
        std::thread::sleep(std::time::Duration::from_secs(31));
    }
    assert_eq!(rights(1), (0, 0));
    assert_eq!(unsafe { fd_write(1, &vector, 1, &mut count) }, 76);
    assert_eq!(unsafe { fd_fdstat_set_rights(fd, before.0, 0) }, 76);
    let mut message = b"rights reductions retained across aliases and suspension\n".to_vec();
    let result = Vector {
        pointer: message.as_mut_ptr(),
        length: message.len(),
    };
    assert_eq!(unsafe { fd_write(output, &result, 1, &mut count) }, 0);
    assert_eq!(count as usize, message.len());
    Ok(())
}
