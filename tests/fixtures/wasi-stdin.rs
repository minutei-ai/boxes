use std::io::{Read, Write};
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_close(fd: u32) -> u32;
}
fn main() -> std::io::Result<()> {
    println!("ready");
    if cfg!(case = "close") {
        unsafe {
            fd_close(0);
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
        println!("closed");
        return Ok(());
    }
    let mut total = 0;
    let mut buffer = [0u8; 8192];
    loop {
        let count = std::io::stdin().read(&mut buffer)?;
        if count == 0 {
            break;
        }
        std::io::stdout().write_all(&buffer[..count])?;
        total += count;
    }
    println!("\nbytes={total}");
    Ok(())
}
