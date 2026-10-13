use std::io::Read;

fn main() -> std::io::Result<()> {
    println!("argv={:?}", std::env::args().collect::<Vec<_>>());
    println!(
        "marker={}",
        std::env::var("CIRRO_MARKER").unwrap_or("unset".into())
    );
    println!(
        "private={}",
        std::env::var("API_KEY").unwrap_or("unset".into())
    );
    println!(
        "proto={}",
        std::env::var("__proto__").unwrap_or("unset".into())
    );
    let mut data = Vec::new();
    std::io::stdin().read_to_end(&mut data)?;
    println!("stdin={data:?}");
    println!("eof={}", std::io::stdin().read(&mut [0u8; 1])?);
    Ok(())
}
