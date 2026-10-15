use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    #[serde(skip_serializing)]
    argv: Vec<Word>,
    #[serde(skip_serializing)]
    assignments: Vec<(String, Word)>,
    gate: String,
    pipe: bool,
    negate: bool,
    redirects: Vec<Redirection>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Redirection {
    Input {
        #[serde(skip_serializing)]
        path: Word,
    },
    Output {
        #[serde(skip_serializing)]
        path: Word,
        append: bool,
    },
    Error {
        #[serde(skip_serializing)]
        path: Word,
        append: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Part {
    Literal { value: String, quoted: bool },
    Parameter { name: String, quoted: bool },
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Word(Vec<Part>);

impl Word {
    fn literal(value: &str, quoted: bool) -> Self {
        Self(vec![Part::Literal {
            value: value.into(),
            quoted,
        }])
    }

    fn append(&mut self, value: char, quoted: bool) -> Result<(), String> {
        if let Some(Part::Literal {
            value: text,
            quoted: previous,
        }) = self.0.last_mut()
            && *previous == quoted
        {
            text.push(value);
            return Ok(());
        }
        if self.0.len() >= 8192 {
            return Err("EFBIG: shell word fragment quota exceeded".into());
        }
        self.0.push(Part::Literal {
            value: value.to_string(),
            quoted,
        });
        Ok(())
    }

    fn plain(&self) -> Option<&str> {
        match self.0.as_slice() {
            [
                Part::Literal {
                    value,
                    quoted: false,
                },
            ] => Some(value),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Word(Word),
    Bang,
    Operator(String),
}

fn word_token(word: Word, fragments: &mut usize) -> Result<Token, String> {
    *fragments += word.0.len();
    if *fragments > 8192 {
        return Err("EFBIG: shell word fragment quota exceeded".into());
    }
    if word.plain() == Some("!") {
        return Ok(Token::Bang);
    }
    Ok(Token::Word(word))
}

fn parameter(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
    quoted: bool,
) -> Result<Part, String> {
    let mut name = String::new();
    if chars.peek() == Some(&'{') {
        chars.next();
        loop {
            match chars.next() {
                Some('}') => break,
                Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '?' => name.push(c),
                Some(_) => {
                    return Err("ENOTSUP: shell parameter operators are not implemented".into());
                }
                None => return Err("EINVAL: unterminated shell parameter".into()),
            }
        }
        if name != "?"
            && !name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        {
            return Err("ENOTSUP: positional shell parameters are not implemented".into());
        }
        if name != "?" && name.contains('?') {
            return Err("EINVAL: invalid shell parameter".into());
        }
    } else if chars.peek() == Some(&'?') {
        chars.next();
        name.push('?');
    } else if chars
        .peek()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
    {
        while let Some(&c) = chars.peek() {
            if !c.is_ascii_alphanumeric() && c != '_' {
                break;
            }
            chars.next();
            name.push(c);
        }
    } else if chars
        .peek()
        .is_some_and(|c| c.is_ascii_digit() || matches!(c, '(' | '$' | '!' | '@' | '*' | '#' | '-'))
    {
        return Err(
            "ENOTSUP: command substitution and special shell parameters are not implemented".into(),
        );
    } else {
        return Ok(Part::Literal {
            value: "$".into(),
            quoted,
        });
    }
    Ok(Part::Parameter { name, quoted })
}

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    if source.len() > 1_048_576 {
        return Err("EFBIG: shell source exceeds byte quota".into());
    }
    let mut tokens = Vec::new();
    let mut fragments = 0;
    let mut word = Word::default();
    let mut active = false;
    let mut quote = None;
    let mut escaped = false;
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if tokens.len() >= 8192 || word.0.len() >= 8192 {
            return Err("EFBIG: shell token quota exceeded".into());
        }
        if escaped {
            if c != '\n' {
                if quote == Some('"') && !matches!(c, '$' | '`' | '"' | '\\') {
                    word.append('\\', true)?;
                }
                word.append(c, true)?;
                active = true;
            }
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if c == '$' && quote != Some('\'') {
            word.0.push(parameter(&mut chars, quote == Some('"'))?);
            active = true;
            continue;
        }
        if c == '`' && quote != Some('\'') {
            return Err("ENOTSUP: command substitution is not implemented".into());
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.append(c, true)?;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            active = true;
            word.0.push(Part::Literal {
                value: String::new(),
                quoted: true,
            });
        } else if c == '\n' || matches!(c, ';' | '|' | '&' | '<' | '>') {
            let mut stderr = false;
            if active {
                if matches!(c, '<' | '>')
                    && let Some(digits) = word.plain()
                    && !digits.is_empty()
                    && digits.bytes().all(|byte| byte.is_ascii_digit())
                {
                    let descriptor = digits
                        .parse::<u32>()
                        .map_err(|_| "ENOTSUP: unsupported redirection descriptor")?;
                    if !((descriptor == 0 && c == '<')
                        || ((descriptor == 1 || descriptor == 2) && c == '>'))
                    {
                        return Err("ENOTSUP: only stdin input and stdout/stderr output redirections are implemented".into());
                    }
                    stderr = descriptor == 2;
                    word = Word::default();
                } else {
                    tokens.push(word_token(std::mem::take(&mut word), &mut fragments)?);
                }
                active = false;
            }
            let mut op = c.to_string();
            if matches!(c, '|' | '&' | '>') && chars.peek() == Some(&c) {
                chars.next();
                op.push(c);
            }
            if stderr {
                op.insert(0, '2');
            }
            if op == "&" {
                return Err("ENOTSUP: background jobs require process.spawn".into());
            }
            tokens.push(Token::Operator(op));
        } else if matches!(c, ' ' | '\t') {
            if active {
                tokens.push(word_token(std::mem::take(&mut word), &mut fragments)?);
                active = false;
            }
        } else if c == '#' && !active {
            for next in chars.by_ref() {
                if next == '\n' {
                    tokens.push(Token::Operator("\n".into()));
                    break;
                }
            }
        } else if matches!(c, '(' | ')' | '{' | '}') {
            return Err("ENOTSUP: shell compound syntax is not implemented".into());
        } else {
            active = true;
            word.append(c, false)?;
        }
    }
    if quote.is_some() || escaped {
        return Err("EINVAL: unterminated shell quote or escape".into());
    }
    if active {
        tokens.push(word_token(word, &mut fragments)?);
    }
    Ok(tokens)
}

pub fn expand(
    words: &[Word],
    environment: &BTreeMap<String, String>,
    status: i32,
) -> Result<Vec<String>, String> {
    let mut fields = Vec::new();
    let status_text = status.to_string();
    let mut bytes = 0usize;
    for word in words {
        let mut field = String::new();
        let mut active = false;
        for part in &word.0 {
            let value = match part {
                Part::Literal { value, .. } => value.as_str(),
                Part::Parameter { name, .. } if name == "?" => status_text.as_str(),
                Part::Parameter { name, .. } => {
                    environment.get(name).map(String::as_str).unwrap_or("")
                }
            };
            if matches!(
                part,
                Part::Literal { quoted: false, .. } | Part::Parameter { quoted: false, .. }
            ) && value.contains(['*', '?', '['])
            {
                return Err("ENOTSUP: shell pathname expansion is not implemented".into());
            }
            bytes = bytes
                .checked_add(value.len())
                .ok_or("EFBIG: expanded shell byte quota exceeded")?;
            if bytes > 1_048_576 {
                return Err("EFBIG: expanded shell byte quota exceeded".into());
            }
            match part {
                Part::Parameter { quoted: false, .. } => {
                    for c in value.chars() {
                        if matches!(c, ' ' | '\t' | '\n') {
                            if active {
                                fields.push(std::mem::take(&mut field));
                                active = false;
                            }
                        } else {
                            field.push(c);
                            active = true;
                        }
                        if fields.len() > 4096 {
                            return Err("EFBIG: expanded shell word quota exceeded".into());
                        }
                    }
                }
                _ => {
                    field.push_str(value);
                    active = true;
                }
            }
        }
        if active {
            fields.push(field);
        }
        if fields.len() > 4096 {
            return Err("EFBIG: expanded shell word quota exceeded".into());
        }
    }
    Ok(fields)
}

#[wasm_bindgen]
pub struct Shell {
    commands: Vec<Command>,
    environment: Rc<BTreeMap<String, String>>,
    exported: BTreeSet<String>,
    readonly: BTreeSet<String>,
    prepared: Option<Prepared>,
}

struct Prepared {
    index: usize,
    argv: Vec<String>,
    variables: Rc<BTreeMap<String, String>>,
    assigned: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Builtin {
    stdout: String,
    stderr: String,
    exit_code: i32,
    fatal: bool,
}

fn variable_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn assignment(word: &Word) -> Result<Option<(String, Word)>, String> {
    let Some(Part::Literal {
        value,
        quoted: false,
    }) = word.0.first()
    else {
        return Ok(None);
    };
    let Some((name, value)) = value.split_once('=') else {
        return Ok(None);
    };
    if !variable_name(name) {
        return Ok(None);
    }
    if value.starts_with('~') || value.contains(":~") {
        return Err("ENOTSUP: assignment tilde expansion is not implemented".into());
    }
    let mut parts = vec![Part::Literal {
        value: value.into(),
        quoted: true,
    }];
    for part in &word.0[1..] {
        match part {
            Part::Literal { value, quoted } => {
                if !quoted && value.contains(":~") {
                    return Err("ENOTSUP: assignment tilde expansion is not implemented".into());
                }
                parts.push(Part::Literal {
                    value: value.clone(),
                    quoted: true,
                });
            }
            Part::Parameter { name, .. } => parts.push(Part::Parameter {
                name: name.clone(),
                quoted: true,
            }),
        }
    }
    Ok(Some((name.into(), Word(parts))))
}

fn assignment_value(
    word: &Word,
    environment: &BTreeMap<String, String>,
    status: i32,
) -> Result<String, String> {
    let fields = expand(std::slice::from_ref(word), environment, status)?;
    let value = fields.into_iter().next().unwrap_or_default();
    if value.len() > 4096 || value.contains('\0') {
        return Err("EFBIG: shell variable exceeds value quota".into());
    }
    Ok(value)
}

fn validate_variables(variables: &BTreeMap<String, String>) -> Result<(), String> {
    if variables.iter().any(|(key, value)| {
        key.encode_utf16().count() > 128 || value.len() > 4096 || value.contains('\0')
    }) {
        return Err("EFBIG: shell variable exceeds quota".into());
    }
    if variables.get("IFS").is_some_and(|value| value != " \t\n") {
        return Err("ENOTSUP: custom shell field separators are not implemented".into());
    }
    if variables.len() > 128
        || serde_json::to_vec(variables)
            .map_err(|_| "EIO: serialization failed")?
            .len()
            > 65_536
    {
        return Err("EFBIG: shell environment exceeds quota".into());
    }
    Ok(())
}

#[wasm_bindgen]
impl Shell {
    #[wasm_bindgen(constructor)]
    pub fn new(source: &str, environment: &str) -> Result<Shell, JsValue> {
        if environment.len() > 65_536 {
            return Err(crate::fail("EFBIG: shell environment exceeds byte quota"));
        }
        let environment: BTreeMap<String, String> = serde_json::from_str(environment)
            .map_err(|_| crate::fail("EINVAL: invalid shell environment"))?;
        if environment.len() > 128
            || environment.iter().any(|(key, value)| {
                key.is_empty()
                    || key.encode_utf16().count() > 128
                    || key.contains(['=', '\0'])
                    || value.len() > 4096
                    || value.contains('\0')
            })
        {
            return Err(crate::fail("EINVAL: invalid shell environment"));
        }
        validate_variables(&environment).map_err(|error| crate::fail(&error))?;
        Ok(Self {
            commands: parse(source).map_err(|error| crate::fail(&error))?,
            exported: environment.keys().cloned().collect(),
            readonly: BTreeSet::new(),
            environment: Rc::new(environment),
            prepared: None,
        })
    }

    pub fn plan(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.commands).map_err(|_| crate::fail("EIO: serialization failed"))
    }

    pub fn argv(&mut self, index: usize, status: i32) -> Result<String, JsValue> {
        self.prepared = None;
        let command = self
            .commands
            .get(index)
            .ok_or_else(|| crate::fail("EINVAL: invalid shell command index"))?;
        let declaration = command
            .argv
            .first()
            .is_some_and(|word| matches!(word.plain(), Some("export" | "readonly")));
        let mut argv = Vec::new();
        let mut bytes = 0usize;
        for word in &command.argv {
            let fields = if declaration && !argv.is_empty() {
                if let Some((name, value)) =
                    assignment(word).map_err(|error| crate::fail(&error))?
                {
                    vec![format!(
                        "{name}={}",
                        assignment_value(&value, &self.environment, status)
                            .map_err(|error| crate::fail(&error))?
                    )]
                } else {
                    expand(std::slice::from_ref(word), &self.environment, status)
                        .map_err(|error| crate::fail(&error))?
                }
            } else {
                expand(std::slice::from_ref(word), &self.environment, status)
                    .map_err(|error| crate::fail(&error))?
            };
            for field in fields {
                bytes = bytes
                    .checked_add(field.len())
                    .ok_or_else(|| crate::fail("EFBIG: expanded shell byte quota exceeded"))?;
                if bytes > 1_048_576 {
                    return Err(crate::fail("EFBIG: expanded shell byte quota exceeded"));
                }
                argv.push(field);
                if argv.len() > 4096 {
                    return Err(crate::fail("EFBIG: expanded shell word quota exceeded"));
                }
            }
        }
        let mut variables = self.environment.clone();
        let mut assigned = BTreeSet::new();
        for (name, word) in &command.assignments {
            if self.readonly.contains(name) {
                return Err(crate::fail(&format!("READONLY: {name}: readonly variable")));
            }
            let value =
                assignment_value(word, &variables, status).map_err(|error| crate::fail(&error))?;
            Rc::make_mut(&mut variables).insert(name.clone(), value);
            assigned.insert(name.clone());
            validate_variables(&variables).map_err(|error| crate::fail(&error))?;
        }
        let serialized =
            serde_json::to_string(&argv).map_err(|_| crate::fail("EIO: serialization failed"))?;
        self.prepared = Some(Prepared {
            index,
            argv,
            variables,
            assigned,
        });
        Ok(serialized)
    }

    pub fn path(&self) -> Result<String, JsValue> {
        let prepared = self
            .prepared
            .as_ref()
            .ok_or_else(|| crate::fail("EINVAL: shell command not prepared"))?;
        Ok(prepared
            .variables
            .get("PATH")
            .cloned()
            .unwrap_or_else(|| "/opt/cirro/bin:/usr/local/bin:/usr/bin:/bin".into()))
    }

    pub fn home(&self) -> Result<String, JsValue> {
        let prepared = self
            .prepared
            .as_ref()
            .ok_or_else(|| crate::fail("EINVAL: shell command not prepared"))?;
        Ok(prepared
            .variables
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/home/cirro".into()))
    }

    pub fn environment(&self) -> Result<String, JsValue> {
        let prepared = self
            .prepared
            .as_ref()
            .ok_or_else(|| crate::fail("EINVAL: shell command not prepared"))?;
        let environment: BTreeMap<_, _> = prepared
            .variables
            .iter()
            .filter(|(key, _)| self.exported.contains(*key) || prepared.assigned.contains(*key))
            .collect();
        serde_json::to_string(&environment).map_err(|_| crate::fail("EIO: serialization failed"))
    }

    pub fn commit(&mut self, index: usize) -> Result<String, JsValue> {
        let prepared = self
            .prepared
            .as_mut()
            .filter(|prepared| prepared.index == index)
            .ok_or_else(|| crate::fail("EINVAL: shell command not prepared"))?;
        let command = &self.commands[index];
        let isolated = command.pipe || command.gate == "pipe";
        let name = prepared.argv.first().map(String::as_str).unwrap_or(":");
        if !prepared.argv.is_empty() && !matches!(name, ":" | "export" | "unset" | "readonly") {
            return Ok("null".into());
        }
        let mut exported = self.exported.clone();
        let mut readonly = self.readonly.clone();
        if !prepared.argv.is_empty() && name != "export" {
            exported.extend(prepared.assigned.iter().cloned());
        }
        let mut result = Builtin {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
            fatal: false,
        };
        if matches!(name, "export" | "unset" | "readonly") {
            let mut args = prepared.argv.iter().skip(1).peekable();
            if name != "unset" {
                while args.peek().is_some_and(|arg| arg.as_str() == "-p") {
                    args.next();
                }
            }
            if args.peek().is_some_and(|arg| arg.as_str() == "--") {
                args.next();
            }
            if name != "unset" && args.peek().is_none() {
                let attributes = if name == "readonly" {
                    &readonly
                } else {
                    &exported
                };
                for key in attributes {
                    if !variable_name(key) {
                        continue;
                    }
                    if let Some(value) = prepared.variables.get(key) {
                        result.stdout.push_str(&format!(
                            "{name} {key}='{}'\n",
                            value.replace('\'', "'\\''")
                        ));
                    } else {
                        result.stdout.push_str(&format!("{name} {key}\n"));
                    }
                }
            } else {
                if name == "unset" && args.peek().is_some_and(|arg| arg.as_str() == "-v") {
                    args.next();
                    if args.peek().is_some_and(|arg| arg.as_str() == "--") {
                        args.next();
                    }
                }
                for arg in args {
                    let (key, value) = match (name, arg.split_once('=')) {
                        ("export" | "readonly", Some((key, value))) => (key, Some(value)),
                        _ => (arg.as_str(), None),
                    };
                    if !variable_name(key) {
                        result.stderr = format!("{name}: invalid variable name\n");
                        result.exit_code = 2;
                        result.fatal = !isolated;
                        break;
                    }
                    if readonly.contains(key) && (name == "unset" || value.is_some()) {
                        result.stderr = format!("{name}: {key}: readonly variable\n");
                        result.exit_code = 2;
                        result.fatal = !isolated;
                        break;
                    }
                    if name == "unset" {
                        Rc::make_mut(&mut prepared.variables).remove(key);
                        exported.remove(key);
                    } else {
                        if let Some(value) = value {
                            Rc::make_mut(&mut prepared.variables).insert(key.into(), value.into());
                        }
                        if name == "readonly" {
                            readonly.insert(key.into());
                        } else {
                            exported.insert(key.into());
                        }
                    }
                }
            }
        }
        let validation = validate_variables(&prepared.variables).and_then(|()| {
            if exported.len() > 128 || exported.iter().any(|key| key.encode_utf16().count() > 128) {
                return Err("EFBIG: exported shell variable quota exceeded".into());
            }
            if readonly.len() > 128 || readonly.iter().any(|key| key.encode_utf16().count() > 128) {
                return Err("EFBIG: readonly shell variable quota exceeded".into());
            }
            Ok(())
        });
        if let Err(error) = validation {
            result.stderr = format!("{error}\n");
            result.exit_code = 2;
            result.fatal = !isolated;
            return serde_json::to_string(&result)
                .map_err(|_| crate::fail("EIO: serialization failed"));
        }
        if !isolated {
            self.environment = prepared.variables.clone();
            self.exported = exported;
            self.readonly = readonly;
        }
        serde_json::to_string(&result).map_err(|_| crate::fail("EIO: serialization failed"))
    }

    pub fn redirect(
        &self,
        command: usize,
        redirect: usize,
        status: i32,
    ) -> Result<String, JsValue> {
        let redirect = self
            .commands
            .get(command)
            .and_then(|command| command.redirects.get(redirect))
            .ok_or_else(|| crate::fail("EINVAL: invalid shell redirect index"))?;
        let word = match redirect {
            Redirection::Input { path }
            | Redirection::Output { path, .. }
            | Redirection::Error { path, .. } => path,
        };
        let fields = expand(std::slice::from_ref(word), &self.environment, status)
            .map_err(|error| crate::fail(&error))?;
        serde_json::to_string(&fields).map_err(|_| crate::fail("EIO: serialization failed"))
    }
}

pub fn parse(source: &str) -> Result<Vec<Command>, String> {
    let tokens = tokenize(source)?;
    let mut commands = Vec::new();
    let mut current = Command {
        argv: Vec::new(),
        assignments: Vec::new(),
        gate: "always".into(),
        pipe: false,
        negate: false,
        redirects: Vec::new(),
    };
    let mut prefix = false;
    let mut iter = tokens.into_iter();
    while let Some(token) = iter.next() {
        match token {
            Token::Word(word) => {
                if current.argv.is_empty()
                    && let Some(value) = assignment(&word)?
                {
                    current.assignments.push(value);
                    continue;
                }
                current.argv.push(word);
            }
            Token::Bang
                if current.argv.is_empty()
                    && current.assignments.is_empty()
                    && current.redirects.is_empty() =>
            {
                if current.gate == "pipe" {
                    return Err("EINVAL: negation must begin the pipeline".into());
                }
                current.negate = !current.negate;
                prefix = true;
            }
            Token::Bang => current.argv.push(Word::literal("!", false)),
            Token::Operator(op) if matches!(op.as_str(), "<" | ">" | ">>" | "2>" | "2>>") => {
                let path = match iter.next() {
                    Some(Token::Word(path)) => path,
                    Some(Token::Bang) => Word::literal("!", false),
                    _ => return Err("EINVAL: redirect requires a path".into()),
                };
                if current.redirects.len() >= 128 {
                    return Err("EFBIG: shell redirection quota exceeded".into());
                }
                if op == "<" {
                    current.redirects.push(Redirection::Input { path });
                } else if op.starts_with('2') {
                    current.redirects.push(Redirection::Error {
                        path,
                        append: op == "2>>",
                    });
                } else {
                    current.redirects.push(Redirection::Output {
                        path,
                        append: op == ">>",
                    });
                }
            }
            Token::Operator(op) => {
                if current.argv.is_empty()
                    && current.assignments.is_empty()
                    && current.redirects.is_empty()
                {
                    if prefix {
                        return Err("ENOTSUP: negation requires a nonempty pipeline".into());
                    }
                    if op == "\n" {
                        continue;
                    }
                    return Err("EINVAL: operator requires a command".into());
                }
                current.pipe = op == "|";
                let negate = current.negate && current.pipe;
                commands.push(current);
                let gate = match op.as_str() {
                    "&&" => "success",
                    "||" => "failure",
                    "|" => "pipe",
                    ";" | "\n" => "always",
                    _ => return Err("ENOTSUP: unsupported shell operator".into()),
                };
                current = Command {
                    argv: Vec::new(),
                    assignments: Vec::new(),
                    gate: gate.into(),
                    pipe: false,
                    negate,
                    redirects: Vec::new(),
                };
                prefix = false;
            }
        }
    }
    if !current.argv.is_empty() || !current.assignments.is_empty() || !current.redirects.is_empty()
    {
        commands.push(current);
    } else if prefix {
        return Err("ENOTSUP: negation requires a nonempty pipeline".into());
    } else if current.gate != "always" {
        return Err("EINVAL: trailing shell operator".into());
    }
    if commands.len() > 256 {
        return Err("EFBIG: shell command quota exceeded".into());
    }
    Ok(commands)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(words: &[Word]) -> Vec<String> {
        expand(words, &BTreeMap::new(), 0).unwrap()
    }

    fn path_value(word: &Word) -> String {
        values(std::slice::from_ref(word)).pop().unwrap()
    }

    #[test]
    fn prepared_environment_shares_reads_and_detaches_command_assignments() {
        let mut shell = Shell::new(
            "echo \"$BASE\"; LOCAL=one; echo \"$LOCAL\"; LOCAL=temporary echo \"$LOCAL\"; export LOCAL; unset LOCAL",
            r#"{"BASE":"retained"}"#,
        ).unwrap();
        assert_eq!(shell.argv(0, 0).unwrap(), r#"["echo","retained"]"#);
        assert!(Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
        assert_eq!(shell.commit(0).unwrap(), "null");
        shell.argv(1, 0).unwrap();
        assert!(!Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
        assert!(!shell.environment.contains_key("LOCAL"));
        shell.commit(1).unwrap();
        assert_eq!(
            shell.environment.get("LOCAL").map(String::as_str),
            Some("one")
        );
        assert!(Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
        assert_eq!(shell.argv(2, 0).unwrap(), r#"["echo","one"]"#);
        assert!(Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
        assert_eq!(shell.argv(3, 0).unwrap(), r#"["echo","one"]"#);
        assert_eq!(
            shell.environment.get("LOCAL").map(String::as_str),
            Some("one")
        );
        assert!(!Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
        assert_eq!(
            shell.environment().unwrap(),
            r#"{"BASE":"retained","LOCAL":"temporary"}"#
        );
        shell.argv(4, 0).unwrap();
        shell.commit(4).unwrap();
        assert!(shell.exported.contains("LOCAL"));
        shell.argv(5, 0).unwrap();
        let previous = shell.environment.clone();
        shell.commit(5).unwrap();
        assert_eq!(previous.get("LOCAL").map(String::as_str), Some("one"));
        assert!(!shell.environment.contains_key("LOCAL"));
        assert!(!shell.exported.contains("LOCAL"));
        assert_eq!(
            shell.environment.get("BASE").map(String::as_str),
            Some("retained")
        );
    }

    #[test]
    fn shared_environment_isolates_pipeline_special_builtins() {
        let mut shell = Shell::new(
            "export A=child | echo \"$A\"; unset A | echo \"$A\"; echo \"$A\"",
            r#"{"A":"parent"}"#,
        )
        .unwrap();
        shell.argv(0, 0).unwrap();
        shell.commit(0).unwrap();
        assert_eq!(
            shell.environment.get("A").map(String::as_str),
            Some("parent")
        );
        assert_eq!(
            shell
                .prepared
                .as_ref()
                .unwrap()
                .variables
                .get("A")
                .map(String::as_str),
            Some("child")
        );
        assert_eq!(shell.argv(1, 0).unwrap(), r#"["echo","parent"]"#);
        shell.argv(2, 0).unwrap();
        shell.commit(2).unwrap();
        assert_eq!(
            shell.environment.get("A").map(String::as_str),
            Some("parent")
        );
        assert!(!shell.prepared.as_ref().unwrap().variables.contains_key("A"));
        assert_eq!(shell.argv(3, 0).unwrap(), r#"["echo","parent"]"#);
        assert_eq!(shell.argv(4, 0).unwrap(), r#"["echo","parent"]"#);
    }

    #[test]
    fn rejected_export_preserves_shared_parent_environment() {
        let mut environment: BTreeMap<String, String> = (0..127)
            .map(|index| (format!("K{index}"), "retained".into()))
            .collect();
        environment.insert("A".into(), "parent".into());
        let mut shell = Shell::new(
            "export A=child EXTRA=overflow",
            &serde_json::to_string(&environment).unwrap(),
        )
        .unwrap();
        shell.argv(0, 0).unwrap();
        assert!(Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
        let result: serde_json::Value = serde_json::from_str(&shell.commit(0).unwrap()).unwrap();
        assert_eq!(result["exitCode"], 2);
        assert_eq!(result["fatal"], true);
        assert_eq!(
            shell.environment.get("A").map(String::as_str),
            Some("parent")
        );
        assert!(!Rc::ptr_eq(
            &shell.environment,
            &shell.prepared.as_ref().unwrap().variables
        ));
    }

    #[test]
    fn readonly_attributes_preserve_export_and_parent_values() {
        let mut shell = Shell::new("readonly A=one; export A; export A=two", "{}").unwrap();
        shell.argv(0, 0).unwrap();
        shell.commit(0).unwrap();
        assert!(shell.readonly.contains("A"));
        assert!(!shell.exported.contains("A"));
        shell.argv(1, 0).unwrap();
        shell.commit(1).unwrap();
        assert!(shell.exported.contains("A"));
        shell.argv(2, 0).unwrap();
        let result: serde_json::Value = serde_json::from_str(&shell.commit(2).unwrap()).unwrap();
        assert_eq!(result["exitCode"], 2);
        assert_eq!(result["fatal"], true);
        assert_eq!(shell.environment.get("A").map(String::as_str), Some("one"));
    }

    #[test]
    fn readonly_pipeline_attributes_and_failures_are_isolated() {
        let mut shell = Shell::new(
            "readonly A=one | cat; readonly B=parent; unset B | cat",
            "{}",
        )
        .unwrap();
        shell.argv(0, 0).unwrap();
        shell.commit(0).unwrap();
        assert!(shell.readonly.is_empty());
        assert!(!shell.environment.contains_key("A"));
        shell.argv(2, 0).unwrap();
        shell.commit(2).unwrap();
        shell.argv(3, 0).unwrap();
        let result: serde_json::Value = serde_json::from_str(&shell.commit(3).unwrap()).unwrap();
        assert_eq!(result["exitCode"], 2);
        assert_eq!(result["fatal"], false);
        assert!(shell.readonly.contains("B"));
        assert_eq!(
            shell.environment.get("B").map(String::as_str),
            Some("parent")
        );
    }

    #[test]
    fn readonly_declarations_have_a_bounded_attribute_set() {
        for count in [128, 129] {
            let source = format!(
                "readonly {}",
                (0..count)
                    .map(|index| format!("V{index}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let mut shell = Shell::new(&source, "{}").unwrap();
            shell.argv(0, 0).unwrap();
            let result: serde_json::Value =
                serde_json::from_str(&shell.commit(0).unwrap()).unwrap();
            if count == 128 {
                assert_eq!(result["exitCode"], 0);
                assert_eq!(shell.readonly.len(), 128);
            } else {
                assert_eq!(result["exitCode"], 2);
                assert_eq!(result["fatal"], true);
                assert!(shell.readonly.is_empty());
            }
            assert!(shell.environment.is_empty());
        }
        for length in [128, 129] {
            let mut shell = Shell::new(&format!("readonly {}", "A".repeat(length)), "{}").unwrap();
            shell.argv(0, 0).unwrap();
            let result: serde_json::Value =
                serde_json::from_str(&shell.commit(0).unwrap()).unwrap();
            if length == 128 {
                assert_eq!(result["exitCode"], 0);
                assert_eq!(shell.readonly.len(), 1);
            } else {
                assert_eq!(result["exitCode"], 2);
                assert!(shell.readonly.is_empty());
            }
        }
    }

    #[test]
    fn assignment_values_match_native_shell_without_field_splitting() -> Result<(), String> {
        for value in [
            "",
            " a b ",
            "\tfirst\nsecond",
            "*",
            "a?b[0]",
            "~",
            "é 字",
            "$OTHER; echo injected",
        ] {
            let environment = BTreeMap::from([("VALUE".into(), value.into())]);
            for word in [
                "A=$VALUE",
                "A=pre${VALUE}post",
                "A=''",
                "A='~'",
                "A='*'",
                r#"A="$VALUE""#,
                r"A=escaped\ space",
                "A='$VALUE'",
            ] {
                let command = parse(word)?.remove(0);
                assert!(command.argv.is_empty(), "{word}");
                let (name, rhs) = &command.assignments[0];
                assert_eq!(name, "A");
                let actual = assignment_value(rhs, &environment, 0)?;
                let oracle = std::process::Command::new("sh")
                    .args(["-c", &format!("{word}; printf '%s' \"$A\"")])
                    .env("VALUE", value)
                    .output()
                    .map_err(|error| error.to_string())?;
                assert!(oracle.status.success(), "{word}");
                assert_eq!(
                    actual.as_bytes(),
                    oracle.stdout,
                    "word={word:?}, value={value:?}"
                );
            }
        }
        assert!(parse("A=~").is_err());
        assert!(parse("A=prefix:~").is_err());
        for word in [r"A\=value", r#"A"B"=value"#, "1A=value"] {
            let command = parse(word)?.remove(0);
            assert!(command.assignments.is_empty());
            assert_eq!(command.argv.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn shell_variable_limits_cover_count_names_values_and_field_separators() {
        assert!(
            validate_variables(
                &(0..129)
                    .map(|index| (format!("V{index}"), "x".into()))
                    .collect()
            )
            .is_err()
        );
        assert!(validate_variables(&BTreeMap::from([("A".into(), "x".repeat(4097))])).is_err());
        assert!(validate_variables(&BTreeMap::from([("A".repeat(129), "x".into())])).is_err());
        assert!(validate_variables(&BTreeMap::from([("IFS".into(), ":".into())])).is_err());
        assert!(validate_variables(&BTreeMap::from([("IFS".into(), " \t\n".into())])).is_ok());
        assert!(
            validate_variables(
                &(0..16)
                    .map(|index| (format!("V{index}"), "x".repeat(4096)))
                    .collect()
            )
            .is_err()
        );
    }

    #[test]
    fn environment_expansion_matches_native_shell_word_boundaries() -> Result<(), String> {
        let words = [
            "$VALUE",
            r#""$VALUE""#,
            "'${VALUE}'",
            "pre${VALUE}post",
            r#"""$VALUE"#,
            r#"$VALUE"""#,
            r#""a"$VALUE"b""#,
            r#"'$VALUE'"$VALUE""#,
            r"\$VALUE",
            r#""$MISSING""#,
            "$MISSING",
            "''",
            "one${MISSING}two",
        ];
        for value in [
            "",
            " a b ",
            "\talpha\nbeta\t",
            "$OTHER; echo injected",
            " a",
            "a ",
            "a  b",
            " \t\n",
            "é  字",
        ] {
            let environment = BTreeMap::from([("VALUE".into(), value.into())]);
            for word in words {
                let command = parse(&format!("echo {word}"))?.remove(0);
                let actual = expand(&command.argv, &environment, 0)?;
                let oracle = std::process::Command::new("sh")
                    .args([
                        "-c",
                        &format!(
                            r#"set -- {word}; for value in "$@"; do printf '%s\000' "$value"; done"#
                        ),
                    ])
                    .env("VALUE", value)
                    .env_remove("MISSING")
                    .output()
                    .map_err(|error| error.to_string())?;
                assert!(oracle.status.success(), "{word}");
                let expected = if oracle.stdout.is_empty() {
                    Vec::new()
                } else {
                    assert_eq!(oracle.stdout.last(), Some(&0));
                    oracle.stdout[..oracle.stdout.len() - 1]
                        .split(|byte| *byte == 0)
                        .map(|bytes| String::from_utf8(bytes.to_vec()).unwrap())
                        .collect::<Vec<_>>()
                };
                assert_eq!(&actual[1..], expected, "word={word:?}, value={value:?}");
            }
        }
        Ok(())
    }

    #[test]
    fn status_and_expansion_limits_are_explicit() -> Result<(), String> {
        let command = parse(r#"echo $? "${?}" '$?' "\$?""#)?.remove(0);
        assert_eq!(
            expand(&command.argv, &BTreeMap::new(), 17)?,
            ["echo", "17", "17", "$?", "$?"]
        );
        for source in [
            r#"echo "$(true)""#,
            r#"echo "`true`""#,
            "echo ${VALUE:-x}",
            "echo $1",
        ] {
            assert!(parse(source).is_err(), "{source}");
        }
        let environment = BTreeMap::from([("VALUE".into(), "x".repeat(4096))]);
        let command = parse(&format!("echo {}", "$VALUE".repeat(257)))?.remove(0);
        assert!(
            expand(&command.argv, &environment, 0)
                .unwrap_err()
                .starts_with("EFBIG:")
        );
        assert!(parse(&format!("echo {}", "a ".repeat(8193))).is_err());
        let command = parse("echo *")?.remove(0);
        assert!(
            expand(&command.argv, &environment, 0)
                .unwrap_err()
                .starts_with("ENOTSUP:")
        );
        Ok(())
    }

    #[test]
    fn preserves_quotes_pipes_and_redirection() -> Result<(), String> {
        let result = parse("echo 'a && b' | cat > /tmp/x && cat /tmp/x")?;
        assert_eq!(result.len(), 3);
        assert_eq!(values(&result[0].argv), vec!["echo", "a && b"]);
        assert!(result[0].pipe);
        assert!(
            matches!(&result[1].redirects[0], Redirection::Output { path, append: false } if path_value(path) == "/tmp/x")
        );
        assert_eq!(result[2].gate, "success");
        Ok(())
    }

    #[test]
    fn negation_applies_to_the_whole_pipeline_and_resets_at_list_boundaries() -> Result<(), String>
    {
        let commands = parse("! false | true && ! ! echo yes; ! true || echo recovered")?;
        assert_eq!(commands.len(), 5);
        assert!(commands[0].negate);
        assert!(commands[1].negate);
        assert!(commands[0].pipe);
        assert!(!commands[1].pipe);
        assert_eq!(commands[2].gate, "success");
        assert!(!commands[2].negate);
        assert!(commands[3].negate);
        assert!(!commands[4].negate);
        assert_eq!(commands[4].gate, "failure");
        for source in ["!", "! !", "!\ntrue", "true | ! false", "! | true"] {
            assert!(parse(source).is_err(), "{source}");
        }
        Ok(())
    }

    #[test]
    fn literal_bang_and_escaped_line_breaks_retain_shell_word_boundaries() -> Result<(), String> {
        for source in ["'!' true", "\"!\" true", "\\! true", "!'' true"] {
            let commands = parse(source)?;
            assert_eq!(values(&commands[0].argv), vec!["!", "true"]);
            assert!(!commands[0].negate);
        }
        assert!(
            matches!(&parse("echo ! > !")?[0].redirects[0], Redirection::Output { path, append: false } if path_value(path) == "!")
        );
        assert!(
            matches!(&parse("cat < !")?[0].redirects[0], Redirection::Input { path } if path_value(path) == "!")
        );
        assert_eq!(
            values(&parse("echo \"a\\qb\"")?[0].argv),
            vec!["echo", "a\\qb"]
        );
        assert_eq!(
            values(&parse("echo before \\\n after")?[0].argv),
            vec!["echo", "before", "after"]
        );
        assert!(parse("!\\\n false")?[0].negate);
        Ok(())
    }

    #[test]
    fn redirects_preserve_order_descriptor_spelling_and_bounded_empty_commands()
    -> Result<(), String> {
        let commands = parse("cat 0< first 1> second >> third < fourth; > empty")?;
        assert_eq!(values(&commands[0].argv), vec!["cat"]);
        assert!(
            matches!(&commands[0].redirects[0], Redirection::Input { path } if path_value(path) == "first")
        );
        assert!(
            matches!(&commands[0].redirects[1], Redirection::Output { path, append: false } if path_value(path) == "second")
        );
        assert!(
            matches!(&commands[0].redirects[2], Redirection::Output { path, append: true } if path_value(path) == "third")
        );
        assert!(
            matches!(&commands[0].redirects[3], Redirection::Input { path } if path_value(path) == "fourth")
        );
        assert!(values(&commands[1].argv).is_empty());
        let errors = parse("echo 2> first 2>> second")?;
        assert!(
            matches!(&errors[0].redirects[0], Redirection::Error { path, append: false } if path_value(path) == "first")
        );
        assert!(
            matches!(&errors[0].redirects[1], Redirection::Error { path, append: true } if path_value(path) == "second")
        );
        assert_eq!(values(&parse("echo '2'> file")?[0].argv), vec!["echo", "2"]);

        assert_eq!(
            values(&parse("echo 1\"\"> file")?[0].argv),
            vec!["echo", "1"]
        );
        assert_eq!(values(&parse("echo 2 > file")?[0].argv), vec!["echo", "2"]);
        for source in [
            "echo 3> file",
            "echo 0> file",
            "cat 1< file",
            "cat 2< file",
            "true 2>&1",
        ] {
            assert!(parse(source).is_err(), "{source}");
        }
        assert!(parse(&format!("true{}", " > file".repeat(128))).is_ok());
        assert!(parse(&format!("true{}", " > file".repeat(129))).is_err());
        Ok(())
    }

    #[test]
    fn rejects_partial_or_unsupported_syntax() {
        for source in [
            "echo '",
            "echo x &&",
            "echo x >",
            "echo $(whoami)",
            "echo x &",
        ] {
            assert!(parse(source).is_err(), "{source}");
        }
    }
    #[test]
    fn separates_line_breaks_from_list_terminators() -> Result<(), String> {
        for source in [
            "; echo x",
            "echo x;; echo y",
            "echo x && ; echo y",
            "echo x | ; cat",
            "echo x || ; echo y",
        ] {
            assert!(parse(source).is_err(), "{source}");
        }
        let commands = parse("\ntrue &&\n# continued condition\necho x |\ncat;\n\necho done\n")?;
        assert_eq!(commands.len(), 4);
        assert_eq!(commands[1].gate, "success");
        assert!(commands[1].pipe);
        assert_eq!(commands[2].gate, "pipe");
        assert_eq!(commands[3].gate, "always");
        Ok(())
    }

    #[test]
    fn empty_and_unterminated_byte_filters_preserve_boundaries() {
        for name in ["head", "tail", "sort", "uniq"] {
            assert!(byte_command(name, &[], b"").stdout.is_empty());
        }
        let args = vec!["-n".into(), "1".into()];
        assert_eq!(byte_command("tail", &args, b"a\n\xff\0").stdout, b"\xff\0");
        assert_eq!(
            byte_command("tail", &args, b"a\n\xff\0\n").stdout,
            b"\xff\0\n"
        );
        assert_eq!(
            byte_command("head", &args, b"\xff\0\nlast").stdout,
            b"\xff\0\n"
        );
    }

    #[test]
    fn byte_counts_use_ascii_word_boundaries_without_utf8_replacement() {
        let input = b"\xff\0 \xc3\xa9\n";
        assert_eq!(byte_command("wc", &["-c".into()], input).stdout, b"6\n");
        assert_eq!(byte_command("wc", &["-w".into()], input).stdout, b"2\n");
        assert_eq!(byte_command("wc", &["-l".into()], input).stdout, b"1\n");
        assert_eq!(byte_command("wc", &["-w".into()], b"a\x0bb").stdout, b"2\n");
        assert_eq!(
            byte_command("wc", &["-c".into(), "ignored".into()], input).exit_code,
            2
        );
    }

    #[test]
    fn invalid_filter_arguments_do_not_produce_partial_stdout() {
        for args in [
            vec!["-n".into(), "invalid".into()],
            vec!["-n".into(), "+1".into()],
            vec!["-c".into(), "1000001".into()],
            vec!["-n".into(), "1".into(), "extra".into()],
        ] {
            for name in ["head", "tail"] {
                let result = byte_command(name, &args, b"\xff\n");
                assert_eq!(result.exit_code, 2);
                assert!(result.stdout.is_empty());
            }
        }
        assert_eq!(byte_command("grep", &["[".into()], b"x\n").exit_code, 2);
        assert_eq!(
            byte_command("grep", &["unmatched".into()], b"\xff\n").exit_code,
            1
        );
    }
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

fn error(message: &str, exit_code: i32) -> Output {
    Output {
        stdout: Vec::new(),
        stderr: message.as_bytes().to_vec(),
        exit_code,
    }
}

pub fn byte_command(name: &str, args: &[String], stdin: &[u8]) -> Output {
    let success = |stdout: Vec<u8>| Output {
        stdout,
        stderr: Vec::new(),
        exit_code: 0,
    };
    match name {
        "true" => success(Vec::new()),
        "false" => error("", 1),
        "echo" => {
            if args.first().is_some_and(|a| a == "-n") {
                success(args.get(1..).unwrap_or_default().join(" ").into_bytes())
            } else {
                success(format!("{}\n", args.join(" ")).into_bytes())
            }
        }
        "cat" => success(stdin.to_vec()),
        "head" | "tail" => {
            if !args.is_empty() && !(args.len() == 2 && matches!(args[0].as_str(), "-n" | "-c")) {
                return error("unsupported line filter arguments\n", 2);
            }
            let count = if args.is_empty() {
                10
            } else {
                if args[1].is_empty() || !args[1].bytes().all(|byte| byte.is_ascii_digit()) {
                    return error("invalid filter count\n", 2);
                }
                match args[1].parse::<usize>() {
                    Ok(n) if n <= 1_000_000 => n,
                    _ => return error("invalid filter count\n", 2),
                }
            };
            if args.first().is_some_and(|a| a == "-c") {
                return if name == "head" {
                    success(stdin[..count.min(stdin.len())].to_vec())
                } else {
                    success(stdin[stdin.len().saturating_sub(count)..].to_vec())
                };
            }
            if count == 0 {
                return success(Vec::new());
            }
            if name == "head" {
                let end = stdin
                    .iter()
                    .enumerate()
                    .filter(|(_, byte)| **byte == b'\n')
                    .nth(count - 1)
                    .map(|(index, _)| index + 1)
                    .unwrap_or(stdin.len());
                return success(stdin[..end].to_vec());
            }
            let end = stdin
                .len()
                .saturating_sub(usize::from(stdin.last() == Some(&b'\n')));
            let start = stdin[..end]
                .iter()
                .enumerate()
                .rev()
                .filter(|(_, byte)| **byte == b'\n')
                .nth(count - 1)
                .map(|(index, _)| index + 1)
                .unwrap_or(0);
            success(stdin[start..].to_vec())
        }
        "wc" => {
            if args.len() > 1 {
                return error("unsupported wc arguments\n", 2);
            }
            let lines = stdin.iter().filter(|b| **b == b'\n').count();
            let words = stdin
                .split(|b| b.is_ascii_whitespace() || *b == 0x0b)
                .filter(|word| !word.is_empty())
                .count();
            let bytes = stdin.len();
            let output = match args.first().map(String::as_str) {
                Some("-l") => format!("{lines}\n"),
                Some("-w") => format!("{words}\n"),
                Some("-c") => format!("{bytes}\n"),
                None => format!("{lines} {words} {bytes}\n"),
                _ => return error("unsupported wc option\n", 2),
            };
            success(output.into_bytes())
        }
        "sort" | "uniq" => {
            if !args.is_empty() {
                return error("unsupported sort or uniq option\n", 2);
            }
            let mut lines: Vec<&[u8]> = stdin
                .split_inclusive(|b| *b == b'\n')
                .map(|line| line.strip_suffix(b"\n").unwrap_or(line))
                .collect();
            if name == "sort" {
                lines.sort_unstable();
            } else {
                lines.dedup();
            }
            let mut output = Vec::with_capacity(stdin.len().saturating_add(1));
            for line in lines {
                output.extend_from_slice(line);
                output.push(b'\n');
            }
            success(output)
        }
        "grep" => {
            if args.len() != 1 {
                return error("grep requires one pattern\n", 2);
            }
            let pattern = match regex::bytes::RegexBuilder::new(&args[0])
                .size_limit(1_048_576)
                .build()
            {
                Ok(regex) => regex,
                Err(_) => return error("invalid or oversized grep pattern\n", 2),
            };
            let mut output = Vec::new();
            for line in stdin.split_inclusive(|b| *b == b'\n') {
                let text = line.strip_suffix(b"\n").unwrap_or(line);
                if pattern.is_match(text) {
                    output.extend_from_slice(text);
                    output.push(b'\n');
                }
            }
            if output.is_empty() {
                error("", 1)
            } else {
                success(output)
            }
        }
        _ => error(&format!("{name}: command not found\n"), 127),
    }
}
