use std::io::{Read, Seek, SeekFrom, Write};

fn main() -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open("/tmp/wasi-file")?;
    file.write_all(b"persistent WASI")?;
    file.seek(SeekFrom::Start(0))?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    println!("{text}");
    file.sync_all()?;
    Ok(())
}
