use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ExportAllDeclaration, ExportFromDeclaration, ImportDeclaration, ImportExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;

#[derive(Default)]
struct Imports {
    names: BTreeSet<String>,
    dynamic: Vec<usize>,
}

impl<'a> Visit<'a> for Imports {
    fn visit_import_declaration(&mut self, node: &ImportDeclaration<'a>) {
        self.names.insert(node.source.value.to_string());
    }

    fn visit_export_from_declaration(&mut self, node: &ExportFromDeclaration<'a>) {
        self.names.insert(node.source.value.to_string());
    }

    fn visit_export_all_declaration(&mut self, node: &ExportAllDeclaration<'a>) {
        self.names.insert(node.source.value.to_string());
    }

    fn visit_import_expression(&mut self, node: &ImportExpression<'a>) {
        self.dynamic.push(node.span.start as usize);
        walk::walk_import_expression(self, node);
    }
}

fn scan(source: &str, name: &str) -> Result<String, String> {
    if source.len() > 1_048_576 {
        return Err("Module source byte budget exceeded".into());
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut imports = Imports::default();
    imports.visit_program(&parsed.program);
    if imports.names.len() > 128 {
        return Err("Module import budget exceeded".into());
    }
    let base = serde_json::to_string(name).map_err(|error| error.to_string())?;
    let replacement = format!("import.meta.__cirroImport.bind(undefined,{base})");
    let mut rewritten = source.to_string();
    imports.dynamic.sort_unstable();
    for start in imports.dynamic.into_iter().rev() {
        rewritten.replace_range(start..start + 6, &replacement);
    }
    if rewritten.len() > 1_048_576 {
        return Err("Compiled module source byte budget exceeded".into());
    }
    serde_json::to_string(&serde_json::json!({"source":rewritten,"imports":imports.names}))
        .map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn compile_module(source: &str, name: &str) -> Result<String, JsValue> {
    scan(source, name).map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    use super::scan;

    #[test]
    fn collects_imports_and_reexports_without_matching_text() {
        let source = "import {answer} from './answer.js'; export * from './all.js'; export {value} from './other.js'; const text=\"import './fake.js'\"; export default () => import('./dynamic.js');";
        let compiled: serde_json::Value =
            serde_json::from_str(&scan(source, "/main.js").unwrap()).unwrap();
        assert_eq!(
            compiled["imports"],
            serde_json::json!(["./all.js", "./answer.js", "./other.js"])
        );
        assert!(
            compiled["source"]
                .as_str()
                .unwrap()
                .contains("import.meta.__cirroImport.bind")
        );
    }

    #[test]
    fn rewrites_computed_and_nested_imports_without_capturing_shadowed_globals() {
        let compiled = scan("const globalThis=0; export default name => import(import('./pick.js').then(module=>module.name));", "/main.js").unwrap();
        assert_eq!(compiled.matches("__cirroImport").count(), 2);
        assert!(scan("export default (", "/main.js").is_err());
    }
}
