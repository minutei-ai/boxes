fn main() {
    println!("WASI before suspension");
    eprintln!("WASI error stream");
    let seconds = std::env::args()
        .nth(1)
        .map(|value| value.parse::<u64>().expect("valid suspension seconds"))
        .unwrap_or(6);
    std::thread::sleep(std::time::Duration::from_secs(seconds));
    println!("WASI after suspension");
}
