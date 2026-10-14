use wasm_bindgen::prelude::*;

mod imports;
mod transpile;
use transpile::compile;

#[wasm_bindgen]
pub fn transpile(source: &str) -> Result<String, JsValue> {
    compile(source).map_err(|message| JsValue::from_str(&message))
}

#[cfg(test)]
mod tests {
    use super::compile;

    #[test]
    fn removes_types_without_erasing_runtime_values() -> Result<(), String> {
        let source = "interface Answer { value: number } enum Choice { First, Second } export default (): Answer => ({ value: 41 + Choice.Second });";
        let output = compile(source)?;
        assert!(!output.contains("interface Answer"));
        assert!(output.contains("Choice"));
        assert!(output.contains("41"));
        Ok(())
    }

    #[test]
    fn syntax_and_source_budgets_are_enforced() {
        assert!(compile("export default (: number => 42;").is_err());
        assert!(compile(&"x".repeat(1_048_577)).is_err());
    }
}
