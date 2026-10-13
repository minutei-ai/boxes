use wasm_bindgen::prelude::*;
use wasmi::{Config, Engine, Linker, Module, Store, StoreLimitsBuilder};

fn execute(bytes: &[u8], memory: usize, fuel: u64) -> Result<i32, String> {
    if bytes.len() > 1_048_576
        || !(4_194_304..=33_554_432).contains(&memory)
        || fuel == 0
        || fuel > 100_000_000
    {
        return Err("Invalid Wasm execution limits".into());
    }
    let mut config = Config::default();
    config.consume_fuel(true);
    let engine = Engine::new(&config);
    let module = Module::new(&engine, bytes).map_err(|error| error.to_string())?;
    let limits = StoreLimitsBuilder::new()
        .memory_size(memory)
        .table_elements(4096)
        .instances(1)
        .tables(1)
        .memories(1)
        .trap_on_grow_failure(true)
        .build();
    let mut store = Store::new(&engine, limits);
    store.limiter(|limits| limits);
    store.set_fuel(fuel).map_err(|error| error.to_string())?;
    let instance = Linker::new(&engine)
        .instantiate_and_start(&mut store, &module)
        .map_err(|error| error.to_string())?;
    let run = instance
        .get_typed_func::<(), i32>(&store, "run")
        .map_err(|error| error.to_string())?;
    run.call(&mut store, ()).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn run_wasm(bytes: &[u8], memory: usize, fuel: u64) -> Result<i32, JsValue> {
    execute(bytes, memory, fuel).map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_binary() {
        assert!(execute(b"invalid", 8_388_608, 1000).is_err());
    }
}
