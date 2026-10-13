use std::path::Path;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var("OUT_DIR")?;
    let bootstrap = Path::new(&root).join("bootstrap/encodings");
    std::fs::create_dir_all(&bootstrap)?;
    for entry in std::fs::read_dir(Path::new(rustpython_pylib::LIB_PATH).join("encodings"))? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            std::fs::copy(entry.path(), bootstrap.join(entry.file_name()))?;
        }
    }
    let module = format!(
        "pub const BOOTSTRAP: &rustpython_vm::frozen::FrozenLib = rustpython_vm::py_freeze!(dir = {:?});",
        Path::new(&root).join("bootstrap")
    );
    std::fs::write(Path::new(&root).join("bootstrap.rs"), module)?;
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
