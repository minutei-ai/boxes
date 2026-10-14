fn main() {
    let path = "../../src/wasm-module-bytes.json";
    let source = std::fs::read(path).expect("Wasm module byte budget exists");
    let bytes: usize =
        serde_json::from_slice(&source).expect("Wasm module byte budget is an integer");
    let output =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output directory"));
    std::fs::write(
        output.join("module_limit.rs"),
        format!("const MAX_MODULE_BYTES: usize = {bytes};\n"),
    )
    .expect("write module byte budget");
    println!("cargo:rerun-if-changed={path}");
}
