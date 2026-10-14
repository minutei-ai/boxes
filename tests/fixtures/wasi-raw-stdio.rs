use std::io::{Read, Write};

fn main() -> std::io::Result<()> {
    const LENGTH: usize = 70_003;
    let bytes: Vec<u8> = (0..LENGTH).map(|index| (index % 256) as u8).collect();
    std::io::stdout().write_all(&bytes)?;
    std::io::stdout().flush()?;
    std::io::stderr().write_all(&[0xff, 0x00, 0x80, 0xc3, 0x28, 0xfe])?;
    std::io::stderr().flush()?;
    if std::env::args().any(|value| value == "wait") {
        std::io::stdin().read_exact(&mut [0])?;
    }
    if std::env::args().any(|value| value == "failure") {
        std::process::exit(7);
    }
    Ok(())
}
