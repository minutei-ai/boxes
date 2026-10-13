use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ExportAllDeclaration, ExportFromDeclaration, Expression, ImportDeclaration, ImportExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;

#[derive(Default)]
struct Imports {
    names: BTreeSet<String>,
    computed: bool,
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
        match &node.source {
            Expression::StringLiteral(source) => {
                self.names.insert(source.value.to_string());
            }
            _ => self.computed = true,
        }
        walk::walk_import_expression(self, node);
    }
}

fn scan(source: &str) -> Result<String, String> {
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
    if imports.computed {
        return Err("Computed dynamic imports require the asynchronous module loader".into());
    }
    if imports.names.len() > 128 {
        return Err("Module import budget exceeded".into());
    }
    serde_json::to_string(&imports.names).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn imports(source: &str) -> Result<String, JsValue> {
    scan(source).map_err(|error| JsValue::from_str(&error))
}

#[cfg(test)]
mod tests {
    use super::scan;

    #[test]
    fn collects_imports_and_reexports_without_matching_text() {
        let source = "import {answer} from './answer.js'; export * from './all.js'; export {value} from './other.js'; const text=\"import './fake.js'\"; export default () => import('./dynamic.js');";
        let names: Vec<String> = serde_json::from_str(&scan(source).unwrap()).unwrap();
        assert_eq!(
            names,
            vec!["./all.js", "./answer.js", "./dynamic.js", "./other.js"]
        );
    }

    #[test]
    fn rejects_computed_imports_and_invalid_syntax_explicitly() {
        assert!(scan("export default name => import(name)").is_err());
        assert!(scan("export default (").is_err());
    }
}
