use rquickjs::loader::{BuiltinLoader, ImportAttributes, Resolver};
use rquickjs::{Ctx, Error, Result};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Program {
    pub language: String,
    pub entry: String,
    pub mode: Mode,
    pub modules: Vec<Source>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    Function,
    Module,
    Evaluate,
}

impl Mode {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Module => "module",
            Self::Evaluate => "evaluate",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    name: String,
    source: String,
    imports: Vec<Import>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    specifier: String,
    target: String,
}

pub(crate) struct Modules {
    entry: String,
    aliases: BTreeMap<(String, String), String>,
}

impl Program {
    pub(crate) fn loaders(&self) -> std::result::Result<(Modules, BuiltinLoader), String> {
        if !matches!(self.language.as_str(), "javascript" | "typescript")
            || self.modules.is_empty()
            || self.modules.len() > 128
        {
            return Err("Invalid module graph".into());
        }
        let names: BTreeSet<_> = self
            .modules
            .iter()
            .map(|module| module.name.as_str())
            .collect();
        if names.len() != self.modules.len() || !names.contains(self.entry.as_str()) {
            return Err("Missing or duplicate module names".into());
        }
        let mut bytes = 0usize;
        let mut loader = BuiltinLoader::default();
        let mut aliases = BTreeMap::new();
        for module in &self.modules {
            bytes = bytes
                .checked_add(module.source.len())
                .ok_or("Module byte budget overflow")?;
            if !module.name.starts_with('/')
                || module.name.len() > 4096
                || module.source.len() > 1_048_576
                || bytes > 8_388_608
                || module.imports.len() > 128
            {
                return Err("Module graph budget exceeded".into());
            }
            loader.add_module(module.name.clone(), module.source.clone());
            for import in &module.imports {
                if import.specifier.len() > 4096
                    || !names.contains(import.target.as_str())
                    || aliases
                        .insert(
                            (module.name.clone(), import.specifier.clone()),
                            import.target.clone(),
                        )
                        .is_some()
                {
                    return Err("Invalid module edge".into());
                }
            }
        }
        Ok((
            Modules {
                entry: self.entry.clone(),
                aliases,
            },
            loader,
        ))
    }
}

impl Resolver for Modules {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        if base == "entry" && name == "program" {
            return Ok(self.entry.clone());
        }
        self.aliases
            .get(&(base.to_string(), name.to_string()))
            .cloned()
            .ok_or_else(|| Error::new_resolving(base, name))
    }
}
