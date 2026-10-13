use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    argv: Vec<String>,
    gate: String,
    pipe: bool,
    input: Option<String>,
    output: Option<String>,
    append: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Word(String),
    Operator(String),
}

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    if source.len() > 1_048_576 {
        return Err("EFBIG: shell source exceeds byte quota".into());
    }
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut active = false;
    let mut quote = None;
    let mut escaped = false;
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if escaped {
            if c != '\n' {
                word.push(c);
            }
            active = true;
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            active = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            active = true;
        } else if c == '\n' || matches!(c, ';' | '|' | '&' | '<' | '>') {
            if active {
                tokens.push(Token::Word(std::mem::take(&mut word)));
                active = false;
            }
            let mut op = c.to_string();
            if matches!(c, '|' | '&' | '>') && chars.peek() == Some(&c) {
                chars.next();
                op.push(c);
            }
            if c == '\n' {
                op = ";".into();
            }
            if op == "&" {
                return Err("ENOTSUP: background jobs require process.spawn".into());
            }
            tokens.push(Token::Operator(op));
        } else if c.is_whitespace() {
            if active {
                tokens.push(Token::Word(std::mem::take(&mut word)));
                active = false;
            }
        } else if c == '#' && !active {
            for next in chars.by_ref() {
                if next == '\n' {
                    tokens.push(Token::Operator(";".into()));
                    break;
                }
            }
        } else if matches!(c, '$' | '`' | '(' | ')' | '{' | '}') {
            return Err("ENOTSUP: shell expansions and compound syntax are not implemented".into());
        } else {
            active = true;
            word.push(c);
        }
    }
    if quote.is_some() || escaped {
        return Err("EINVAL: unterminated shell quote or escape".into());
    }
    if active {
        tokens.push(Token::Word(word));
    }
    Ok(tokens)
}

pub fn parse(source: &str) -> Result<Vec<Command>, String> {
    let tokens = tokenize(source)?;
    let mut commands = Vec::new();
    let mut current = Command {
        argv: Vec::new(),
        gate: "always".into(),
        pipe: false,
        input: None,
        output: None,
        append: false,
    };
    let mut iter = tokens.into_iter();
    while let Some(token) = iter.next() {
        match token {
            Token::Word(word) => current.argv.push(word),
            Token::Operator(op) if matches!(op.as_str(), "<" | ">" | ">>") => {
                let Some(Token::Word(path)) = iter.next() else {
                    return Err("EINVAL: redirect requires a path".into());
                };
                if op == "<" {
                    if current.input.is_some() {
                        return Err("ENOTSUP: duplicate input redirect".into());
                    }
                    current.input = Some(path);
                } else {
                    if current.output.is_some() {
                        return Err("ENOTSUP: duplicate output redirect".into());
                    }
                    current.output = Some(path);
                    current.append = op == ">>";
                }
            }
            Token::Operator(op) => {
                if current.argv.is_empty() {
                    if op == ";" {
                        continue;
                    }
                    return Err("EINVAL: operator requires a command".into());
                }
                current.pipe = op == "|";
                commands.push(current);
                let gate = match op.as_str() {
                    "&&" => "success",
                    "||" => "failure",
                    "|" => "pipe",
                    ";" => "always",
                    _ => return Err("ENOTSUP: unsupported shell operator".into()),
                };
                current = Command {
                    argv: Vec::new(),
                    gate: gate.into(),
                    pipe: false,
                    input: None,
                    output: None,
                    append: false,
                };
            }
        }
    }
    if !current.argv.is_empty() {
        commands.push(current);
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

    #[test]
    fn preserves_quotes_pipes_and_redirection() -> Result<(), String> {
        let result = parse("echo 'a && b' | cat > /tmp/x && cat /tmp/x")?;
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].argv, vec!["echo", "a && b"]);
        assert!(result[0].pipe);
        assert_eq!(result[1].output.as_deref(), Some("/tmp/x"));
        assert_eq!(result[2].gate, "success");
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
            "echo x > a > b",
        ] {
            assert!(parse(source).is_err(), "{source}");
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

pub fn text_command(name: &str, args: &[String], stdin: &str) -> Output {
    let success = |stdout: String| Output {
        stdout,
        stderr: String::new(),
        exit_code: 0,
    };
    match name {
        "true" => success(String::new()),
        "false" => Output {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
        },
        "echo" => {
            if args.first().is_some_and(|a| a == "-n") {
                success(args.get(1..).unwrap_or_default().join(" "))
            } else {
                success(format!("{}\n", args.join(" ")))
            }
        }
        "cat" => success(stdin.into()),
        "head" | "tail" => {
            if !args.is_empty() && !(args.len() == 2 && args[0] == "-n") {
                return Output {
                    stdout: String::new(),
                    stderr: "unsupported line filter arguments\n".into(),
                    exit_code: 2,
                };
            }
            let count = if args.first().is_some_and(|a| a == "-n") {
                match args.get(1).and_then(|n| n.parse::<usize>().ok()) {
                    Some(n) if n <= 1_000_000 => n,
                    _ => {
                        return Output {
                            stdout: String::new(),
                            stderr: "invalid line count\n".into(),
                            exit_code: 2,
                        };
                    }
                }
            } else {
                10
            };
            let lines: Vec<_> = stdin.split_inclusive('\n').collect();
            let output = if name == "head" {
                lines.iter().take(count).copied().collect::<String>()
            } else {
                lines
                    .iter()
                    .skip(lines.len().saturating_sub(count))
                    .copied()
                    .collect::<String>()
            };
            success(output)
        }
        "wc" => {
            let lines = stdin.bytes().filter(|b| *b == b'\n').count();
            let words = stdin.split_whitespace().count();
            let bytes = stdin.len();
            match args.first().map(String::as_str) {
                Some("-l") => success(format!("{lines}\n")),
                Some("-w") => success(format!("{words}\n")),
                Some("-c") => success(format!("{bytes}\n")),
                None => success(format!("{lines} {words} {bytes}\n")),
                _ => Output {
                    stdout: String::new(),
                    stderr: "unsupported wc option\n".into(),
                    exit_code: 2,
                },
            }
        }
        "sort" => {
            if !args.is_empty() {
                return Output {
                    stdout: String::new(),
                    stderr: "unsupported sort option\n".into(),
                    exit_code: 2,
                };
            }
            let mut lines: Vec<_> = stdin.lines().collect();
            lines.sort_unstable();
            if lines.is_empty() {
                success(String::new())
            } else {
                success(format!("{}\n", lines.join("\n")))
            }
        }
        "uniq" => {
            if !args.is_empty() {
                return Output {
                    stdout: String::new(),
                    stderr: "unsupported uniq option\n".into(),
                    exit_code: 2,
                };
            }
            let mut lines: Vec<_> = stdin.lines().collect();
            lines.dedup();
            if lines.is_empty() {
                success(String::new())
            } else {
                success(format!("{}\n", lines.join("\n")))
            }
        }
        "grep" => {
            if args.len() != 1 {
                return Output {
                    stdout: String::new(),
                    stderr: "grep requires one pattern\n".into(),
                    exit_code: 2,
                };
            }
            let pattern = match regex::RegexBuilder::new(&args[0])
                .size_limit(1_048_576)
                .build()
            {
                Ok(regex) => regex,
                Err(_) => {
                    return Output {
                        stdout: String::new(),
                        stderr: "invalid or oversized grep pattern\n".into(),
                        exit_code: 2,
                    };
                }
            };
            let lines: Vec<_> = stdin
                .lines()
                .filter(|line| pattern.is_match(line))
                .collect();
            if lines.is_empty() {
                Output {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 1,
                }
            } else {
                success(format!("{}\n", lines.join("\n")))
            }
        }
        _ => Output {
            stdout: String::new(),
            stderr: format!("{name}: command not found\n"),
            exit_code: 127,
        },
    }
}
