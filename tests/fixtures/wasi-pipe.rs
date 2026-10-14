use std::convert::TryInto;

#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn fd_pipe(reader: *mut u32, writer: *mut u32) -> u32;
    fn fd_dup(fd: u32, output: *mut u32) -> u32;
}
#[link(wasm_import_module = "host_fs")]
unsafe extern "C" {
    fn fd_mode(fd: u32) -> u32;
}
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_read(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_close(fd: u32) -> u32;
    fn fd_fdstat_set_flags(fd: u32, flags: u32) -> u32;
    fn fd_seek(fd: u32, offset: i64, whence: u32, output: *mut u64) -> u32;
    fn poll_oneoff(input: *const u8, output: *mut u8, count: u32, events: *mut u32) -> u32;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let mut reader = 0;
        let mut writer = 0;
        if fd_pipe(&mut reader, &mut writer) != 0 {
            return 1;
        }
        let mut data = [0u8; 65_536];
        let mut count = 91;
        let io = Io {
            pointer: data.as_mut_ptr(),
            length: 1,
        };
        if cfg!(case = "blocked") {
            let mut marker = *b"blocked pipe";
            let output = Io {
                pointer: marker.as_mut_ptr(),
                length: marker.len() as u32,
            };
            if fd_write(1, &output, 1, &mut count) != 0 {
                return 20;
            }
            if fd_read(reader, &io, 1, &mut count) == 0 {
                return 21;
            }
            return 22;
        }
        if fd_mode(reader) != 0o10600 || fd_mode(writer) != 0o10600 {
            return 2;
        }
        if fd_fdstat_set_flags(reader, 4) != 0 || fd_fdstat_set_flags(writer, 4) != 0 {
            return 3;
        }
        if fd_read(reader, &io, 1, &mut count) != 6 || count != 91 {
            return 4;
        }
        let mut subscriptions = [0u8; 96];
        subscriptions[0..8].copy_from_slice(&123u64.to_le_bytes());
        subscriptions[8] = 1;
        subscriptions[16..20].copy_from_slice(&reader.to_le_bytes());
        subscriptions[48..56].copy_from_slice(&456u64.to_le_bytes());
        subscriptions[72..80].copy_from_slice(&1_000_000u64.to_le_bytes());
        let mut events = [0u8; 64];
        let mut ready = 0;
        if poll_oneoff(subscriptions.as_ptr(), events.as_mut_ptr(), 2, &mut ready) != 0
            || ready != 1
            || u64::from_le_bytes(events[0..8].try_into().unwrap()) != 456
        {
            return 5;
        }
        data.fill(42);
        let fill = Io {
            pointer: data.as_mut_ptr(),
            length: 65_536,
        };
        if fd_write(writer, &fill, 1, &mut count) != 0 || count != 65_536 {
            return 6;
        }
        if fd_write(writer, &io, 1, &mut count) != 6 {
            return 7;
        }
        let invalid = Io {
            pointer: u32::MAX as *mut u8,
            length: 1,
        };
        if fd_read(reader, &invalid, 1, &mut count) != 21 {
            return 8;
        }
        if fd_read(reader, &io, 1, &mut count) != 0 || data[0] != 42 || count != 1 {
            return 9;
        }
        let atomic = Io {
            pointer: data.as_mut_ptr(),
            length: 2,
        };
        if fd_write(writer, &atomic, 1, &mut count) != 6 {
            return 10;
        }
        let drain = Io {
            pointer: data.as_mut_ptr(),
            length: 65_536,
        };
        if fd_read(reader, &drain, 1, &mut count) != 0 || count != 65_535 {
            return 11;
        }
        let mut alias = 0;
        if fd_dup(writer, &mut alias) != 0 || fd_close(writer) != 0 {
            return 12;
        }
        if fd_read(reader, &io, 1, &mut count) != 6 {
            return 13;
        }
        if fd_write(alias, &atomic, 1, &mut count) != 0 || count != 2 {
            return 14;
        }
        if fd_close(alias) != 0
            || fd_read(reader, &drain, 1, &mut count) != 0
            || count != 2
            || fd_read(reader, &io, 1, &mut count) != 0
            || count != 0
        {
            return 15;
        }
        if poll_oneoff(subscriptions.as_ptr(), events.as_mut_ptr(), 1, &mut ready) != 0
            || ready != 1
            || events[24] != 1
        {
            return 16;
        }
        let mut position = 0;
        if fd_seek(reader, 0, 0, &mut position) != 70 {
            return 17;
        }
        if fd_pipe(&mut reader, &mut writer) != 0
            || fd_close(reader) != 0
            || fd_write(writer, &io, 1, &mut count) != 64
        {
            return 18;
        }
        let mut unchanged = 91;
        if fd_pipe(&mut unchanged, u32::MAX as *mut u32) != 21 || unchanged != 91 {
            return 19;
        }
        let mut pairs = 0;
        loop {
            let result = fd_pipe(&mut reader, &mut writer);
            if result == 33 {
                break;
            }
            if result != 0 {
                return 23;
            }
            pairs += 1;
            if pairs > 64 {
                return 24;
            }
        }
        if pairs == 0
            || fd_close(reader) != 0
            || fd_close(writer) != 0
            || fd_pipe(&mut reader, &mut writer) != 0
        {
            return 25;
        }
        0
    }
}
