#[link(wasm_import_module = "host_process")]
unsafe extern "C" {
    fn fd_dup(fd: u32, output: *mut u32) -> u32;
    fn fd_dup2(fd: u32, target: u32) -> u32;
    fn fd_getfd(fd: u32, output: *mut u32) -> u32;
    fn fd_setfd(fd: u32, flags: u32) -> u32;
}
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
    fn fd_close(fd: u32) -> u32;
    fn fd_renumber(fd: u32, target: u32) -> u32;
    fn fd_read(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_write(fd: u32, vectors: *const Io, length: u32, output: *mut u32) -> u32;
    fn fd_seek(fd: u32, offset: i64, whence: u32, output: *mut u64) -> u32;
    fn fd_tell(fd: u32, output: *mut u64) -> u32;
    fn fd_fdstat_get(fd: u32, output: *mut u8) -> u32;
    fn fd_fdstat_set_flags(fd: u32, flags: u32) -> u32;
    fn fd_prestat_get(fd: u32, output: *mut u8) -> u32;
}
#[repr(C)]
struct Io {
    pointer: *mut u8,
    length: u32,
}

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    unsafe {
        let path = b"tmp/dup";
        let other = b"tmp/other";
        let mut fd = 0;
        let rights = 2 | 4 | 8 | 32 | 64 | (1 << 21) | (1 << 27);
        if path_open(
            3,
            1,
            path.as_ptr(),
            path.len() as u32,
            0,
            rights,
            0,
            0,
            &mut fd,
        ) != 0
        {
            return 1;
        }
        let mut alias = 0;
        if fd_setfd(fd, 1) != 0 || fd_dup(fd, &mut alias) != 0 {
            return 2;
        }
        let mut flag = 91;
        if fd_getfd(alias, &mut flag) != 0 || flag != 0 || fd_getfd(fd, &mut flag) != 0 || flag != 1
        {
            return 3;
        }
        let mut buffer = [0u8; 2];
        let vector = Io {
            pointer: buffer.as_mut_ptr(),
            length: 1,
        };
        let mut count = 0;
        if fd_read(fd, &vector, 1, &mut count) != 0 || count != 1 || buffer[0] != b'a' {
            return 4;
        }
        if fd_read(alias, &vector, 1, &mut count) != 0 || buffer[0] != b'b' {
            return 5;
        }
        let mut position = 0;
        if fd_tell(fd, &mut position) != 0 || position != 2 {
            return 6;
        }
        if fd_seek(alias, 4, 0, &mut position) != 0
            || fd_tell(fd, &mut position) != 0
            || position != 4
        {
            return 7;
        }
        if fd_fdstat_set_flags(alias, 1) != 0 {
            return 8;
        }
        let mut stat = [0u8; 24];
        if fd_fdstat_get(fd, stat.as_mut_ptr()) != 0 || stat[2] != 1 {
            return 9;
        }
        if fd_close(fd) != 0 || fd_read(alias, &vector, 1, &mut count) != 0 || buffer[0] != b'e' {
            return 10;
        }
        let mut target = 0;
        if path_open(
            3,
            1,
            other.as_ptr(),
            other.len() as u32,
            0,
            rights,
            0,
            0,
            &mut target,
        ) != 0
            || fd_dup2(alias, target) != 0
        {
            return 11;
        }
        if fd_close(alias) != 0 || fd_read(target, &vector, 1, &mut count) != 0 || buffer[0] != b'f'
        {
            return 12;
        }
        if fd_setfd(target, 1) != 0
            || fd_dup2(target, target) != 0
            || fd_getfd(target, &mut flag) != 0
            || flag != 1
        {
            return 13;
        }
        if fd_setfd(target, 2) != 28 || fd_dup(target, u32::MAX as *mut u32) != 21 {
            return 14;
        }
        if fd_dup2(target, 1) != 0 || fd_getfd(1, &mut flag) != 0 || flag != 0 {
            return 15;
        }
        let mut output = *b"Z";
        let write = Io {
            pointer: output.as_mut_ptr(),
            length: 1,
        };
        if fd_write(1, &write, 1, &mut count) != 0 || count != 1 {
            return 16;
        }
        if fd_tell(target, &mut position) != 0 || position != 7 {
            return 17;
        }
        if fd_dup2(target, 3) != 0 || fd_prestat_get(3, stat.as_mut_ptr()) != 8 {
            return 18;
        }
        if fd_close(1) != 0
            || fd_close(target) != 0
            || fd_read(3, &vector, 1, &mut count) != 0
            || count != 0
        {
            return 19;
        }
        if fd_close(3) != 0 || fd_getfd(3, &mut flag) != 8 || fd_dup(3, &mut alias) != 8 {
            return 20;
        }
        let mut stdout = 0;
        if fd_dup(2, &mut stdout) != 0 || fd_close(2) != 0 {
            return 21;
        }
        let mut marker = *b"alias stderr";
        let io = Io {
            pointer: marker.as_mut_ptr(),
            length: marker.len() as u32,
        };
        if fd_write(stdout, &io, 1, &mut count) != 0 {
            return 22;
        }
        let mut stdin = 0;
        if fd_dup(0, &mut stdin) != 0
            || fd_close(0) != 0
            || fd_read(stdin, &vector, 1, &mut count) != 0
            || buffer[0] != b'X'
        {
            return 23;
        }
        let mut readonly = 0;
        if path_open(
            0x40000003,
            1,
            path.as_ptr(),
            path.len() as u32,
            0,
            2 | 4 | 32 | (1 << 21),
            0,
            0,
            &mut readonly,
        ) != 0
        {
            return 24;
        }
        let mut reader = 0;
        if fd_dup(readonly, &mut reader) != 0
            || fd_write(reader, &write, 1, &mut count) != 76
            || fd_fdstat_set_flags(reader, 1) != 76
        {
            return 25;
        }
        if fd_dup2(9999, reader) != 8
            || fd_read(reader, &vector, 1, &mut count) != 0
            || buffer[0] != b'a'
        {
            return 26;
        }
        if fd_dup(0x40000003, &mut alias) != 8 || fd_dup2(readonly, 0x40000003) != 8 {
            return 27;
        }
        if fd_renumber(reader, 100) != 8
            || fd_getfd(reader, &mut flag) != 0
            || fd_dup2(0, 100) != 0
            || fd_setfd(reader, 1) != 0
            || fd_renumber(reader, 100) != 0
        {
            return 32;
        }
        if fd_getfd(reader, &mut flag) != 8 || fd_getfd(100, &mut flag) != 0 || flag != 1 {
            return 33;
        }
        if fd_tell(100, &mut position) != 0 || position != 1 {
            return 34;
        }
        if fd_renumber(100, 100) != 0 || fd_getfd(100, &mut flag) != 0 || flag != 1 {
            return 35;
        }
        if fd_renumber(9999, 100) != 8
            || fd_read(100, &vector, 1, &mut count) != 0
            || buffer[0] != b'b'
        {
            return 36;
        }
        if fd_renumber(100, 0x40000003) != 8 || fd_renumber(0x40000003, 100) != 8 {
            return 37;
        }
        if fd_dup2(readonly, reader) != 0 || fd_renumber(100, reader) != 0 {
            return 38;
        }
        let mut allocated = 0;
        loop {
            let result = fd_dup(readonly, &mut alias);
            if result == 33 {
                break;
            }
            if result != 0 {
                return 28;
            }
            allocated += 1;
            if allocated > 128 {
                return 29;
            }
        }
        if allocated == 0 || fd_read(reader, &vector, 1, &mut count) != 0 || buffer[0] != b'c' {
            return 30;
        }
        if fd_close(alias) != 0 || fd_dup(readonly, &mut alias) != 0 {
            return 31;
        }
        if fd_renumber(readonly, 2) != 0 || fd_close(reader) != 0 {
            return 39;
        }
        if fd_write(2, &write, 1, &mut count) != 76
            || fd_read(2, &vector, 1, &mut count) != 0
            || buffer[0] != b'd'
        {
            return 40;
        }
        if fd_dup2(1, 2) != 0 || fd_renumber(stdout, 2) != 0 || fd_write(2, &io, 1, &mut count) != 0
        {
            return 41;
        }
        0
    }
}
