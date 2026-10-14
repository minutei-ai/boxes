use std::{env, fs, path::PathBuf};

#[path = "../compiler/src/transpile.rs"]
mod transpile;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=src/bootstrap.ts");
    println!("cargo:rerun-if-changed=../compiler/src/transpile.rs");
    let source = fs::read_to_string("src/bootstrap.ts")?;
    let code = transpile::compile(&source).map_err(std::io::Error::other)?;
    let output = PathBuf::from(env::var("OUT_DIR")?).join("bootstrap.js");
    fs::write(output, code)?;
    Ok(())
}
