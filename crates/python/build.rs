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
        "ntpath.py",
        "pathlib/__init__.py",
        "pathlib/_local.py",
        "pathlib/_os.py",
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
    let os = std::fs::read_to_string(source.join("os.py"))?;
    let pathlike = os
        .split_once("class PathLike(abc.ABC):")
        .and_then(|(_, body)| body.split_once("\n\nif name == 'nt':"))
        .map(|(body, _)| body)
        .ok_or("Pinned os.PathLike declaration is unavailable")?;
    let walk = os
        .split_once("_walk_symlinks_as_files = object()")
        .and_then(|(_, body)| body.split_once("\n__all__.append(\"walk\")"))
        .map(|(body, _)| body)
        .ok_or("Pinned os.walk declaration is unavailable")?;
    std::fs::write(
        library.join("_boxes_paths.py"),
        format!(
            "import abc\nimport sys\nfrom _collections_abc import _check_methods\nfrom types import GenericAlias\nfrom os import path,scandir,fspath\nclass PathLike(abc.ABC):{pathlike}\n_walk_symlinks_as_files = object(){walk}\n"
        ),
    )?;
    let module = format!(
        "pub const BOOTSTRAP: &rustpython_vm::frozen::FrozenLib = rustpython_vm::py_freeze!(dir = {:?});",
        Path::new(&root).join("bootstrap")
    );
    std::fs::write(Path::new(&root).join("bootstrap.rs"), module)?;
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
