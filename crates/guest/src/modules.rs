use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::{Ctx, Error, Function, Module, Result};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Program {
    pub language: String,
    pub env: BTreeMap<String, String>,
    pub entry: String,
    pub mode: Mode,
    pub modules: Vec<Source>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    name: String,
    source: String,
    imports: Vec<Import>,
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Import {
    specifier: String,
    target: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Batch {
    entry: String,
    modules: Vec<Source>,
}

pub(crate) struct Registry {
    program: Program,
    indices: BTreeMap<String, usize>,
    aliases: BTreeMap<(String, String), String>,
    bytes: usize,
    pub revision: usize,
}

fn validate(source: &Source, names: &BTreeSet<&str>) -> std::result::Result<(), String> {
    if !source.name.starts_with('/')
        || source.name.len() > 4096
        || source.source.len() > 1_048_576
        || source.imports.len() > 128
    {
        return Err("Module graph budget exceeded".into());
    }
    let mut seen = BTreeSet::new();
    for edge in &source.imports {
        if edge.specifier.len() > 4096
            || !names.contains(edge.target.as_str())
            || !seen.insert(edge.specifier.as_str())
        {
            return Err("Invalid module edge".into());
        }
    }
    Ok(())
}

impl Registry {
    pub(crate) fn environment(&self) -> &BTreeMap<String, String> {
        &self.program.env
    }
    pub(crate) fn new(program: Program) -> std::result::Result<Self, String> {
        if program.env.len() > 128
            || program.env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.encode_utf16().count() > 128
                    || key.contains(['=', '\0'])
                    || value.len() > 4096
                    || value.contains('\0')
            })
        {
            return Err("Invalid guest environment".into());
        }
        if serde_json::to_string(&program.env)
            .map_err(|error| error.to_string())?
            .len()
            > 65_536
        {
            return Err("Guest environment exceeds its byte limit".into());
        }
        if !matches!(program.language.as_str(), "javascript" | "typescript")
            || program.modules.is_empty()
            || program.modules.len() > 128
        {
            return Err("Invalid module graph".into());
        }
        let names: BTreeSet<_> = program
            .modules
            .iter()
            .map(|source| source.name.as_str())
            .collect();
        if names.len() != program.modules.len() || !names.contains(program.entry.as_str()) {
            return Err("Missing or duplicate module names".into());
        }
        let bytes = serde_json::to_string(&program)
            .map_err(|error| error.to_string())?
            .len();
        if bytes > 8_388_608 {
            return Err("Serialized module graph byte budget exceeded".into());
        }
        let mut aliases = BTreeMap::new();
        let mut indices = BTreeMap::new();
        for (index, source) in program.modules.iter().enumerate() {
            validate(source, &names)?;
            indices.insert(source.name.clone(), index);
            for edge in &source.imports {
                aliases.insert(
                    (source.name.clone(), edge.specifier.clone()),
                    edge.target.clone(),
                );
            }
        }
        Ok(Self {
            program,
            indices,
            aliases,
            bytes,
            revision: 0,
        })
    }

    pub(crate) fn cached(&self, base: &str, specifier: &str) -> Option<String> {
        self.aliases
            .get(&(base.to_string(), specifier.to_string()))
            .cloned()
    }

    pub(crate) fn begin(&mut self, program: Program) -> std::result::Result<(), String> {
        let incoming = Self::new(program)?;
        if self.indices.contains_key(&incoming.program.entry) {
            return Err("A retained execution requires a new entry module identity".into());
        }
        let mut modules = self.program.modules.clone();
        for source in incoming.program.modules {
            if let Some(index) = self.indices.get(&source.name) {
                let cached = &self.program.modules[*index];
                if cached.source != source.source
                    || source
                        .imports
                        .iter()
                        .any(|edge| !cached.imports.contains(edge))
                {
                    return Err(
                        "A cached module changed; reset the context before replacing it".into(),
                    );
                }
            } else {
                modules.push(source);
            }
        }
        let mut updated = Self::new(Program {
            language: incoming.program.language,
            env: incoming.program.env,
            entry: incoming.program.entry,
            mode: incoming.program.mode,
            modules,
        })?;
        updated.revision = self
            .revision
            .checked_add(1)
            .ok_or("Module revision exhausted")?;
        *self = updated;
        Ok(())
    }

    pub(crate) fn names(&self) -> Vec<&str> {
        self.indices.keys().map(String::as_str).collect()
    }
    pub(crate) fn mode(&self) -> Mode {
        self.program.mode
    }
    pub(crate) fn program(&self) -> std::result::Result<String, String> {
        serde_json::to_string(&self.program).map_err(|error| error.to_string())
    }

    pub(crate) fn install(
        &mut self,
        base: &str,
        specifier: &str,
        batch: Batch,
    ) -> std::result::Result<String, String> {
        let index = *self.indices.get(base).ok_or("Unknown importing module")?;
        if specifier.len() > 4096
            || self.program.modules[index].imports.len() >= 128
            || self.cached(base, specifier).is_some()
        {
            return Err("Module edge budget exceeded or duplicate response".into());
        }
        let names: BTreeSet<_> = self
            .indices
            .keys()
            .map(String::as_str)
            .chain(batch.modules.iter().map(|source| source.name.as_str()))
            .collect();
        if names.len() != self.indices.len() + batch.modules.len()
            || names.len() > 128
            || !names.contains(batch.entry.as_str())
        {
            return Err("Module budget exceeded or duplicate module".into());
        }
        let edge = Import {
            specifier: specifier.to_string(),
            target: batch.entry.clone(),
        };
        let mut bytes = self.bytes
            + serde_json::to_string(&edge)
                .map_err(|error| error.to_string())?
                .len();
        if !self.program.modules[index].imports.is_empty() {
            bytes += 1;
        }
        for source in &batch.modules {
            validate(source, &names)?;
            bytes += serde_json::to_string(source)
                .map_err(|error| error.to_string())?
                .len()
                + 1;
        }
        if bytes > 8_388_608 {
            return Err("Serialized module graph byte budget exceeded".into());
        }
        self.aliases.insert(
            (base.to_string(), specifier.to_string()),
            batch.entry.clone(),
        );
        self.program.modules[index].imports.push(edge);
        for source in batch.modules {
            for edge in &source.imports {
                self.aliases.insert(
                    (source.name.clone(), edge.specifier.clone()),
                    edge.target.clone(),
                );
            }
            self.indices
                .insert(source.name.clone(), self.program.modules.len());
            self.program.modules.push(source);
        }
        self.bytes = bytes;
        self.revision += 1;
        Ok(batch.entry)
    }
}

pub(crate) struct Modules(pub Rc<RefCell<Registry>>);

impl Resolver for Modules {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<String> {
        let registry = self.0.borrow();
        if base == "entry" && name == "program" {
            return Ok(registry.program.entry.clone());
        }
        if name.starts_with('/') && registry.indices.contains_key(name) {
            return Ok(name.to_string());
        }
        registry
            .cached(base, name)
            .ok_or_else(|| Error::new_resolving(base, name))
    }
}

impl Loader for Modules {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> Result<Module<'js, Declared>> {
        let source = {
            let registry = self.0.borrow();
            let index = registry
                .indices
                .get(name)
                .ok_or_else(|| Error::new_loading(name))?;
            registry.program.modules[*index].source.clone()
        };
        let module = Module::declare(ctx.clone(), name, source)?;
        let meta = module.meta()?;
        let mut url = url::Url::parse("file:///").map_err(|_| Error::new_loading(name))?;
        url.path_segments_mut()
            .map_err(|_| Error::new_loading(name))?
            .clear()
            .extend(name.split('/').skip(1));
        meta.set("url", url.as_str())?;
        meta.set("filename", name)?;
        let helper: Function = ctx.globals().get("__cirroImport")?;
        meta.set("__cirroImport", helper)?;
        Ok(module)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(name: &str) -> Source {
        Source {
            name: name.to_string(),
            source: "export const value=42;".into(),
            imports: vec![],
        }
    }

    #[test]
    fn installed_sources_preserve_exact_byte_budget_and_alias_identity() {
        let mut registry = Registry::new(Program {
            env: BTreeMap::new(),
            language: "javascript".into(),
            entry: "/main.mjs".into(),
            mode: Mode::Module,
            modules: vec![source("/main.mjs")],
        })
        .unwrap();
        registry
            .install(
                "/main.mjs",
                "./child.mjs",
                Batch {
                    entry: "/child.mjs".into(),
                    modules: vec![source("/child.mjs")],
                },
            )
            .unwrap();
        assert_eq!(
            registry.cached("/main.mjs", "./child.mjs"),
            Some("/child.mjs".into())
        );
        assert_eq!(registry.bytes, registry.program().unwrap().len());
        let before = registry.program().unwrap();
        assert!(
            registry
                .install(
                    "/main.mjs",
                    "./child.mjs",
                    Batch {
                        entry: "/child.mjs".into(),
                        modules: vec![]
                    }
                )
                .is_err()
        );
        assert_eq!(registry.program().unwrap(), before);
    }

    #[test]
    fn cumulative_module_limit_rejects_without_mutating_the_registry() {
        let modules = (0..128)
            .map(|index| source(&format!("/{index}.mjs")))
            .collect();
        let mut registry = Registry::new(Program {
            env: BTreeMap::new(),
            language: "javascript".into(),
            entry: "/0.mjs".into(),
            mode: Mode::Module,
            modules,
        })
        .unwrap();
        assert!(
            registry
                .install(
                    "/0.mjs",
                    "./new.mjs",
                    Batch {
                        entry: "/new.mjs".into(),
                        modules: vec![source("/new.mjs")]
                    }
                )
                .is_err()
        );
        assert_eq!(registry.revision, 0);
        assert_eq!(registry.names().len(), 128);
    }
}
