#![no_std]

use core::convert::TryInto;

#[repr(C)]
struct Iovec {
    pointer: *const u8,
    length: usize,
}

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn path_open(
        fd: u32,
        follow: u32,
        path: *const u8,
        length: usize,
        flags: u32,
        rights: u64,
        inheriting: u64,
        fdflags: u32,
        result: *mut u32,
    ) -> i32;
    fn fd_write(fd: u32, vectors: *const Iovec, count: usize, written: *mut u32) -> i32;
    fn fd_read(fd: u32, vectors: *const Iovec, count: usize, read: *mut u32) -> i32;
    fn fd_pread(fd: u32, vectors: *const Iovec, count: usize, offset: u64, read: *mut u32) -> i32;
    fn fd_pwrite(
        fd: u32,
        vectors: *const Iovec,
        count: usize,
        offset: u64,
        written: *mut u32,
    ) -> i32;
    fn fd_readdir(fd: u32, buffer: *mut u8, length: usize, cookie: u64, used: *mut u32) -> i32;
    fn path_create_directory(fd: u32, path: *const u8, length: usize) -> i32;
    fn path_remove_directory(fd: u32, path: *const u8, length: usize) -> i32;
    fn path_unlink_file(fd: u32, path: *const u8, length: usize) -> i32;
    fn path_readlink(
        fd: u32,
        path: *const u8,
        length: usize,
        buffer: *mut u8,
        capacity: usize,
        used: *mut u32,
    ) -> i32;
    fn fd_filestat_set_size(fd: u32, size: u64) -> i32;
    fn fd_filestat_set_times(fd: u32, atime: u64, mtime: u64, flags: u32) -> i32;
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
    fn fd_sync(fd: u32) -> i32;
    fn fd_close(fd: u32) -> i32;
    fn random_get(bytes: *mut u8, length: usize) -> i32;
    fn clock_time_get(clock: u32, precision: u64, time: *mut u64) -> i32;
    fn proc_exit(code: u32) -> !;
}

fn open(
    base: u32,
    path: &[u8],
    flags: u32,
    rights: u64,
    inheriting: u64,
    follow: u32,
) -> Result<u32, i32> {
    let mut fd = 0;
    let errno = unsafe {
        path_open(
            base,
            follow,
            path.as_ptr(),
            path.len(),
            flags,
            rights,
            inheriting,
            0,
            &mut fd,
        )
    };
    if errno != 0 {
        return Err(errno);
    }
    Ok(fd)
}

fn write(fd: u32, data: &[u8]) -> i32 {
    let mut written = 0;
    let vector = Iovec {
        pointer: data.as_ptr(),
        length: data.len(),
    };
    unsafe { fd_write(fd, &vector, 1, &mut written) }
}

#[unsafe(no_mangle)]
pub extern "C" fn run() -> i32 {
    if cfg!(case = "directory-cookies") {
        let fd = match open(3, b"tmp/raw-dir", 2, 1 << 14, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        let mut data = [0u8; 25];
        let mut used = 0;
        if unsafe { fd_readdir(fd, data.as_mut_ptr(), 1, 0, &mut used) } != 0 || used != 1 {
            return -1;
        }
        if unsafe { fd_readdir(fd, data.as_mut_ptr(), 25, 0, &mut used) } != 0
            || used != 25
            || data[24] != b'a'
            || data[20] != 4
        {
            return -1;
        }
        let inode = u64::from_le_bytes(data[8..16].try_into().unwrap_or_default());
        if inode == 0 {
            return -1;
        }
        if unsafe { fd_readdir(fd, data.as_mut_ptr(), 25, 1, &mut used) } != 0
            || used != 25
            || data[24] != b'b'
            || data[20] != 3
        {
            return -1;
        }
        if unsafe { fd_readdir(fd, data.as_mut_ptr(), 25, 3, &mut used) } != 0 || used != 0 {
            return -1;
        }
        return unsafe { fd_readdir(fd, data.as_mut_ptr(), 25, 99, &mut used) };
    }
    if cfg!(case = "directory-rights") {
        let fd = match open(3, b"tmp/raw-dir", 2, 1 << 13, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        let mut data = [0u8; 25];
        let mut used = 0;
        return unsafe { fd_readdir(fd, data.as_mut_ptr(), 25, 0, &mut used) };
    }
    if cfg!(case = "path-types") {
        let path = b"tmp/raw-dir";
        if unsafe { path_create_directory(3, path.as_ptr(), path.len()) } != 20 {
            return -1;
        }
        if unsafe { path_unlink_file(3, path.as_ptr(), path.len()) } != 31 {
            return -1;
        }
        if unsafe { path_remove_directory(3, path.as_ptr(), path.len()) } != 55 {
            return -1;
        }
        let file = b"tmp/raw-dir/a";
        return unsafe { path_remove_directory(3, file.as_ptr(), file.len()) };
    }
    if cfg!(case = "readlink-small") {
        let path = b"tmp/raw-dir/c";
        let mut data = [0u8; 1];
        let mut used = 0;
        let errno = unsafe {
            path_readlink(
                3,
                path.as_ptr(),
                path.len(),
                data.as_mut_ptr(),
                1,
                &mut used,
            )
        };
        if errno != 0 || used != 1 || data[0] != b't' {
            return -1;
        }
        return 42;
    }
    if cfg!(case = "buffers") {
        let first = match open(3, b"tmp/large", 0, 2, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        if !matches!(open(3, b"tmp/small", 0, 2, 0, 1), Err(48)) {
            return -1;
        }
        if unsafe { fd_close(first) } != 0 {
            return -1;
        }
        if open(3, b"tmp/small", 0, 2, 0, 1).is_err() {
            return -1;
        }
        return 42;
    }
    if cfg!(case = "race-a") || cfg!(case = "race-b") {
        let data = if cfg!(case = "race-a") { b"A" } else { b"B" };
        for path in [b"tmp/race-one", b"tmp/race-two"] {
            let fd = match open(3, path, 9, 64, 0, 1) {
                Ok(fd) => fd,
                Err(errno) => return errno,
            };
            let errno = write(fd, data);
            if errno != 0 {
                return errno;
            }
        }
        return 42;
    }
    if cfg!(case = "bad-pointer") {
        let mut written = 0;
        return unsafe { fd_write(1, 0xfffffff0usize as *const Iovec, 1, &mut written) };
    }
    if cfg!(case = "rights") || cfg!(case = "writeonly") || cfg!(case = "writeonly-write") {
        let rights = if cfg!(case = "rights") { 2 } else { 64 };
        let fd = match open(3, b"tmp/existing", 0, rights, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        if cfg!(case = "rights") || cfg!(case = "writeonly-write") {
            return write(fd, b"changed");
        }
        let mut data = [0u8; 32];
        let vector = Iovec {
            pointer: data.as_mut_ptr(),
            length: data.len(),
        };
        let mut read = 0;
        return unsafe { fd_read(fd, &vector, 1, &mut read) };
    }
    if cfg!(case = "positioned") || cfg!(case = "aliases") {
        let fd = match open(3, b"tmp/existing", 0, 2 | 4 | 64, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        let mut count = 0;
        let mut data = [0u8; 2];
        if cfg!(case = "positioned") {
            let source = Iovec {
                pointer: b"AB".as_ptr(),
                length: 2,
            };
            let errno = unsafe { fd_pwrite(fd, &source, 1, 2, &mut count) };
            if errno != 0 {
                return errno;
            }
            let output = Iovec {
                pointer: data.as_mut_ptr(),
                length: 2,
            };
            let errno = unsafe { fd_pread(fd, &output, 1, 2, &mut count) };
            if errno != 0 || &data != b"AB" {
                return -1;
            }
            let errno = unsafe { fd_read(fd, &output, 1, &mut count) };
            if errno != 0 || &data != b"or" {
                return -1;
            }
        } else {
            let other = match open(3, b"tmp/existing", 0, 2, 0, 1) {
                Ok(fd) => fd,
                Err(errno) => return errno,
            };
            if write(fd, b"CH") != 0 {
                return -1;
            }
            let output = Iovec {
                pointer: data.as_mut_ptr(),
                length: 2,
            };
            if unsafe { fd_read(other, &output, 1, &mut count) } != 0 || &data != b"CH" {
                return -1;
            }
        }
        return 42;
    }
    if cfg!(case = "budget") {
        let mut byte = 0u8;
        for _ in 0..257 {
            if unsafe { random_get(&mut byte, 1) } != 0 {
                return -1;
            }
        }
        return 42;
    }
    if cfg!(case = "escape") {
        return match open(3, b"../escape", 1, 64, 0, 1) {
            Ok(_) => -1,
            Err(errno) => errno,
        };
    }
    if cfg!(case = "nofollow") {
        return match open(3, b"tmp/link", 0, 2, 0, 0) {
            Ok(_) => -1,
            Err(errno) => errno,
        };
    }
    if cfg!(case = "symlink-escape") {
        let fd = match open(3, b"tmp/scoped", 2, 1 << 13, 2, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        return match open(fd, b"outside", 0, 2, 0, 1) {
            Ok(_) => -1,
            Err(errno) => errno,
        };
    }
    if cfg!(case = "setter-escape") {
        let fd = match open(3, b"tmp/scoped", 2, 1 << 20, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        return unsafe { path_filestat_set_times(fd, 1, b"outside".as_ptr(), 7, 1, 2, 5) };
    }
    if cfg!(case = "descriptors") {
        for _ in 0..129 {
            if let Err(errno) = open(3, b"tmp/existing", 0, 2, 0, 1) {
                return errno;
            }
        }
        return -1;
    }
    if cfg!(case = "closed-stdio") {
        let errno = unsafe { fd_close(1) };
        if errno != 0 {
            return errno;
        }
        return write(1, b"closed");
    }
    if cfg!(case = "clock-random") {
        let mut data = [0u8; 64];
        let mut time = 0u64;
        let errno = unsafe { random_get(data.as_mut_ptr(), data.len()) };
        if errno != 0 {
            return errno;
        }
        let errno = unsafe { clock_time_get(0, 0, &mut time) };
        if errno != 0 || time == 0 || data.iter().all(|byte| *byte == 0) {
            return -1;
        }
        let mut first = 0;
        let mut second = 0;
        if unsafe { clock_time_get(1, 0, &mut first) } != 0
            || unsafe { clock_time_get(1, 0, &mut second) } != 0
            || second < first
        {
            return -1;
        }
        return 42;
    }
    if cfg!(case = "package-times") {
        let fd = match open(3, b"opt/cirro/bin/probe", 0, 2 | (1 << 23), 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        return unsafe { fd_filestat_set_times(fd, 1, 2, 5) };
    }
    if cfg!(case = "setter-rights") {
        let fd = match open(3, b"tmp/existing", 0, 2 | 4 | (1 << 21), 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        let directory = match open(3, b"tmp", 2, 1 << 13, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        if unsafe { fd_filestat_set_size(fd, 2) } != 76
            || unsafe { fd_filestat_set_times(fd, 1, 2, 5) } != 76
            || unsafe { path_filestat_set_times(directory, 1, b"existing".as_ptr(), 8, 1, 2, 5) }
                != 76
        {
            return -1;
        }
        return 42;
    }
    if cfg!(case = "setter-flags") {
        let fd = match open(
            3,
            b"tmp/existing",
            0,
            2 | (1 << 21) | (1 << 22) | (1 << 23),
            0,
            1,
        ) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        for flags in [3, 12, 16] {
            if unsafe { fd_filestat_set_times(fd, 1, 2, flags) } != 28
                || unsafe {
                    path_filestat_set_times(3, 1, b"tmp/existing".as_ptr(), 12, 1, 2, flags)
                } != 28
            {
                return -1;
            }
        }
        if unsafe { fd_filestat_set_size(fd, u64::MAX) } != 22
            || unsafe { fd_filestat_set_size(1, 2) } != 8
            || unsafe { fd_filestat_set_times(999, 1, 2, 5) } != 8
            || unsafe { path_filestat_set_times(3, 2, b"tmp/existing".as_ptr(), 12, 1, 2, 5) } != 28
        {
            return -1;
        }
        return 42;
    }
    if cfg!(case = "setter-denied") {
        let fd = match open(
            3,
            b"tmp/existing",
            0,
            2 | (1 << 21) | (1 << 22) | (1 << 23),
            0,
            1,
        ) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        if unsafe { fd_filestat_set_size(fd, 2) } != 2
            || unsafe { fd_filestat_set_size(fd, 12) } != 2
            || unsafe { fd_filestat_set_times(fd, 1, 2, 5) } != 2
            || unsafe { path_filestat_set_times(3, 1, b"tmp/existing".as_ptr(), 12, 1, 2, 5) } != 2
        {
            return -1;
        }
        let mut data = [0u8; 8];
        let vector = Iovec {
            pointer: data.as_mut_ptr(),
            length: data.len(),
        };
        let mut count = 0;
        if unsafe { fd_read(fd, &vector, 1, &mut count) } != 0 || count != 8 || &data != b"original"
        {
            return -1;
        }
        return 42;
    }
    if cfg!(case = "setter-trap") || cfg!(case = "setter-synced-trap") || cfg!(case = "setter-now")
    {
        let fd = match open(
            3,
            b"tmp/existing",
            0,
            2 | 64 | 16 | (1 << 21) | (1 << 22) | (1 << 23),
            0,
            1,
        ) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        if cfg!(case = "setter-now") {
            let mut before = [0u8; 64];
            let mut after = [0u8; 64];
            if unsafe { fd_filestat_get(fd, before.as_mut_ptr()) } != 0
                || unsafe { fd_filestat_set_times(fd, 1, 2, 0) } != 0
                || unsafe { fd_filestat_get(fd, after.as_mut_ptr()) } != 0
                || before != after
            {
                return -1;
            }
            if unsafe { fd_filestat_set_times(fd, 0, 0, 10) } != 0
                || unsafe { fd_filestat_get(fd, after.as_mut_ptr()) } != 0
                || after[40..48] != after[48..56]
                || after[48..56] != after[56..64]
                || after[40..48] == [0u8; 8]
            {
                return -1;
            }
            return 42;
        }
        let errno = unsafe { fd_filestat_set_size(fd, 3) };
        if errno != 0 {
            return errno;
        }
        let errno = unsafe { fd_filestat_set_times(fd, 111, 222, 5) };
        if errno != 0 {
            return errno;
        }
        if cfg!(case = "setter-synced-trap") {
            let errno = unsafe { fd_sync(fd) };
            if errno != 0 {
                return errno;
            }
        }
        core::arch::wasm32::unreachable();
    }
    if cfg!(case = "fuel") {
        loop {
            core::hint::spin_loop();
        }
    }
    if cfg!(case = "memory") {
        return core::arch::wasm32::memory_grow::<0>(4096) as i32;
    }
    if cfg!(case = "exit") {
        unsafe { proc_exit(7) };
    }
    if cfg!(case = "output") {
        let data = [b'"'; 4096];
        for _ in 0..256 {
            let _ = write(1, &data);
        }
        return 42;
    }
    if cfg!(case = "trap") || cfg!(case = "synced-trap") || cfg!(case = "create-denied") {
        let fd = match open(3, b"tmp/from-abi", 9, 64 | 16, 0, 1) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };
        let errno = write(fd, b"before trap");
        if errno != 0 {
            return errno;
        }
        if cfg!(case = "create-denied") {
            return -1;
        }
        if cfg!(case = "synced-trap") {
            let errno = unsafe { fd_sync(fd) };
            if errno != 0 {
                return errno;
            }
        }
        core::arch::wasm32::unreachable();
    }
    -1
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
