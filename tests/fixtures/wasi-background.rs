fn main() {
    #[cfg(ready)]
    println!("continuation entered");
    std::thread::sleep(std::time::Duration::from_millis(31_000));
    println!("continued beyond the HTTP continuation");
}
