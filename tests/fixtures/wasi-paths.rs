use std::io::{Read, Seek, SeekFrom, Write};

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn path_symlink(
        target: *const u8,
        target_len: usize,
        fd: u32,
        path: *const u8,
        path_len: usize,
    ) -> i32;
}

fn main() -> std::io::Result<()> {
    std::fs::create_dir("/tmp/paths")?;
    std::fs::write("/tmp/paths/source", b"source bytes")?;
    std::fs::write("/tmp/paths/target", b"target bytes")?;
    const LINK: &[u8] = b"tmp/paths/link";
    const TARGET: &[u8] = b"source";
    let errno =
        unsafe { path_symlink(TARGET.as_ptr(), TARGET.len(), 3, LINK.as_ptr(), LINK.len()) };
    if errno != 0 {
        return Err(std::io::Error::from_raw_os_error(errno));
    }
    println!("link={}", std::fs::read_link("/tmp/paths/link")?.display());
    let mut names = std::fs::read_dir("/tmp/paths")?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().to_string()))
        .collect::<std::io::Result<Vec<_>>>()?;
    names.sort();
    println!("names={names:?}");
    let mut source = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/paths/source")?;
    let mut target = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/paths/target")?;
    std::fs::rename("/tmp/paths/source", "/tmp/paths/target")?;
    source.write_all(b"updated")?;
    let mut old = String::new();
    target.read_to_string(&mut old)?;
    println!("old={old}");
    target.seek(SeekFrom::Start(0))?;
    target.write_all(b"detached")?;
    println!("current={}", std::fs::read_to_string("/tmp/paths/target")?);
    std::fs::remove_file("/tmp/paths/target")?;
    source.seek(SeekFrom::Start(0))?;
    source.write_all(b"unlinked")?;
    println!(
        "missing={}",
        std::fs::File::open("/tmp/paths/target").is_err()
    );
    std::fs::remove_file("/tmp/paths/link")?;
    std::fs::remove_dir("/tmp/paths")?;
    println!("paths removed");
    Ok(())
}
