use std::path::Path;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::var("OUT_DIR")?;
    let library = Path::new(&root).join("bootstrap");
    if library.exists() {
        std::fs::remove_dir_all(&library)?;
    }
    std::fs::create_dir_all(library.join("encodings"))?;
    let source = Path::new(rustpython_pylib::LIB_PATH);
    for entry in std::fs::read_dir(source.join("encodings"))? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            std::fs::copy(
                entry.path(),
                library.join("encodings").join(entry.file_name()),
            )?;
        }
    }
    for module in [
        "abc.py",
        "bisect.py",
        "contextlib.py",
        "copy.py",
        "copyreg.py",
        "heapq.py",
        "io.py",
        "_pyio.py",
        "stat.py",
        "_collections_abc.py",
        "enum.py",
        "functools.py",
        "fnmatch.py",
        "glob.py",
        "genericpath.py",
        "keyword.py",
        "operator.py",
        "posixpath.py",
        "reprlib.py",
        "types.py",
        "weakref.py",
        "_weakrefset.py",
        "collections/__init__.py",
        "json/__init__.py",
        "json/decoder.py",
        "json/encoder.py",
        "json/scanner.py",
        "re/__init__.py",
        "re/_compiler.py",
        "re/_parser.py",
        "re/_constants.py",
        "re/_casefix.py",
    ] {
        let target = library.join(module);
        std::fs::create_dir_all(target.parent().ok_or("Invalid Python library path")?)?;
        std::fs::copy(source.join(module), target)?;
    }
    let module = format!(
        "pub const BOOTSTRAP: &rustpython_vm::frozen::FrozenLib = rustpython_vm::py_freeze!(dir = {:?});",
        Path::new(&root).join("bootstrap")
    );
    std::fs::write(Path::new(&root).join("bootstrap.rs"), module)?;
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
