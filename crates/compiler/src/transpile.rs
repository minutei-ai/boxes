use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;

pub fn compile(source: &str) -> Result<String, String> {
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
