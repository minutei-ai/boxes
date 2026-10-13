use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;
use wasm_bindgen::prelude::*;

mod imports;

fn compile(source: &str) -> Result<String, String> {
    if source.len() > 1_048_576 {
        return Err("TypeScript source exceeds its byte budget".into());
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::ts()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut program = parsed.program;
    let semantic = SemanticBuilder::new().with_enum_eval(true).build(&program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let transformed = Transformer::new(
        &allocator,
        Path::new("program.ts"),
        &TransformOptions::default(),
    )
    .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    if !transformed.diagnostics.is_empty() {
        return Err(transformed
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    Ok(Codegen::new().build(&program).code)
}

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
