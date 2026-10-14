fn main() {
    println!("WASI before suspension");
    eprintln!("WASI error stream");
    std::thread::sleep(std::time::Duration::from_secs(6));
    println!("WASI after suspension");
}
