use sha2::{Digest, Sha256};
use std::time::Instant;
use wasmi::{CompilationMode, Config, Engine, Module};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Expected Wasm artifact path")?;
    let bytes = std::fs::read(path)?;
    let mut measurements = Vec::new();
    for (name, mode) in [
        ("eager", CompilationMode::Eager),
        ("lazyTranslation", CompilationMode::LazyTranslation),
    ] {
        let mut samples = Vec::new();
        for _ in 0..12 {
            let mut config = Config::default();
            config.consume_fuel(true);
            config.compilation_mode(mode);
            config.wasm_tail_call(false);
            let engine = Engine::new(&config);
            let start = Instant::now();
            let module = Module::new(&engine, bytes.as_slice())?;
            std::hint::black_box(&module);
            samples.push(start.elapsed().as_micros());
        }
        samples.sort_unstable();
        measurements.push(serde_json::json!({"mode": name, "samples": samples.len(), "p50Us": samples[samples.len() / 2], "p95Us": samples[samples.len() - 1]}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "runtime": "native Rust/Wasmi; validation and translation only",
            "production": false,
            "artifactBytes": bytes.len(),
            "artifactSha256": format!("{:x}", Sha256::digest(&bytes)),
            "measurements": measurements,
        }))?
    );
    Ok(())
}
