use std::convert::TryInto;
use std::fs::{hard_link, remove_file, rename, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_filestat_get(fd: u32, output: *mut u8) -> i32;
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
    fn path_link(
        old: u32,
        flags: u32,
        source: *const u8,
        source_length: usize,
        new: u32,
        target: *const u8,
        target_length: usize,
    ) -> i32;
    fn path_symlink(
        target: *const u8,
        length: usize,
        fd: u32,
        path: *const u8,
        path_length: usize,
    ) -> i32;
    fn fd_close(fd: u32) -> i32;
}
fn stat(file: &File) -> (u64, u64) {
    let mut bytes = [0u8; 64];
    assert_eq!(
        unsafe { fd_filestat_get(file.as_raw_fd() as u32, bytes.as_mut_ptr()) },
        0
    );
    (
        u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
    )
}

fn main() -> std::io::Result<()> {
    if std::env::args().any(|arg| arg == "--denied") {
        assert!(hard_link("/tmp/source", "/tmp/denied").is_err());
        println!("link denied");
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--hidden") {
        let mut file = File::open("/tmp/visible")?;
        assert_eq!(stat(&file).1, 2);
        remove_file("/tmp/visible")?;
        assert_eq!(stat(&file).1, 1);
        let mut bytes = String::new();
        file.read_to_string(&mut bytes)?;
        assert_eq!(bytes, "hidden");
        println!("hidden alias retained");
        return Ok(());
    }
    std::fs::write("/tmp/source", b"original")?;
    hard_link("/tmp/source", "/tmp/alias")?;
    let mut original = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/source")?;
    let mut alias = File::open("/tmp/alias")?;
    assert_eq!(stat(&original).0, stat(&alias).0);
    assert_eq!(stat(&original).1, 2);
    original.write_all(b"changed!")?;
    let mut bytes = [0u8; 8];
    alias.read_exact(&mut bytes)?;
    assert_eq!(&bytes, b"changed!");
    remove_file("/tmp/source")?;
    assert_eq!(stat(&original).1, 1);
    original.seek(SeekFrom::Start(0))?;
    original.write_all(b"retained")?;
    assert_eq!(std::fs::read("/tmp/alias")?, b"retained");
    rename("/tmp/alias", "/tmp/moved")?;
    original.seek(SeekFrom::Start(0))?;
    original.write_all(b"renamed!")?;
    assert_eq!(std::fs::read("/tmp/moved")?, b"renamed!");
    hard_link("/tmp/moved", "/tmp/same")?;
    rename("/tmp/moved", "/tmp/same")?;
    assert_eq!(
        stat(&File::open("/tmp/moved")?).0,
        stat(&File::open("/tmp/same")?).0
    );
    assert_eq!(stat(&original).1, 2);
    std::fs::write("/tmp/replacement", b"new data")?;
    let mut replaced = File::open("/tmp/replacement")?;
    hard_link("/tmp/replacement", "/tmp/survivor")?;
    rename("/tmp/moved", "/tmp/replacement")?;
    assert_eq!(stat(&replaced).1, 1);
    let mut old = Vec::new();
    replaced.read_to_end(&mut old)?;
    assert_eq!(old, b"new data");
    assert_eq!(std::fs::read("/tmp/survivor")?, b"new data");
    assert_eq!(std::fs::read("/tmp/replacement")?, b"renamed!");
    remove_file("/tmp/same")?;
    remove_file("/tmp/replacement")?;
    assert_eq!(stat(&original).1, 0);
    original.seek(SeekFrom::Start(0))?;
    original.write_all(b"detached")?;
    assert!(!std::path::Path::new("/tmp/replacement").exists());
    let mut source_dir = 0;
    let mut target_dir = 0;
    assert_eq!(
        unsafe { path_open(3, 0, b"tmp".as_ptr(), 3, 2, 1 << 11, 0, 0, &mut source_dir) },
        0
    );
    assert_eq!(
        unsafe { path_open(3, 0, b"tmp".as_ptr(), 3, 2, 1 << 12, 0, 0, &mut target_dir) },
        0
    );
    assert_eq!(
        unsafe {
            path_link(
                source_dir,
                2,
                b"survivor".as_ptr(),
                8,
                target_dir,
                b"invalid".as_ptr(),
                7,
            )
        },
        28
    );
    assert_eq!(
        unsafe {
            path_link(
                target_dir,
                0,
                b"survivor".as_ptr(),
                8,
                target_dir,
                b"bad-source".as_ptr(),
                10,
            )
        },
        76
    );
    assert_eq!(
        unsafe {
            path_link(
                source_dir,
                0,
                b"survivor".as_ptr(),
                8,
                source_dir,
                b"bad-target".as_ptr(),
                10,
            )
        },
        76
    );
    assert_eq!(
        unsafe {
            path_link(
                source_dir,
                0,
                b"survivor".as_ptr(),
                8,
                target_dir,
                b"rights-target".as_ptr(),
                13,
            )
        },
        0
    );
    std::fs::write("/home/cirro/outside", b"outside")?;
    let target = b"/home/cirro/outside";
    assert_eq!(
        unsafe {
            path_symlink(
                target.as_ptr(),
                target.len(),
                target_dir,
                b"escape".as_ptr(),
                6,
            )
        },
        76
    );
    assert_eq!(
        unsafe { path_symlink(target.as_ptr(), target.len(), 3, b"tmp/escape".as_ptr(), 10) },
        0
    );
    assert_eq!(
        unsafe {
            path_link(
                source_dir,
                1,
                b"escape".as_ptr(),
                6,
                target_dir,
                b"escaped".as_ptr(),
                7,
            )
        },
        76
    );
    assert_eq!(
        unsafe {
            path_link(
                source_dir,
                0,
                b"escape".as_ptr(),
                6,
                target_dir,
                b"symbolic-copy".as_ptr(),
                13,
            )
        },
        0
    );
    assert_eq!(unsafe { fd_close(source_dir) }, 0);
    assert_eq!(unsafe { fd_close(target_dir) }, 0);
    println!("shared inode descriptors survived");
    Ok(())
}
