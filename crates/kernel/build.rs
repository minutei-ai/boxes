fn main() -> Result<(), Box<dyn std::error::Error>> {
    vbare_compiler::process_schemas(std::path::Path::new("package-format"))
}
