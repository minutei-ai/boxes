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
                    tokens.push(Token::Operator("\n".into()));
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
                    if op == "\n" {
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
                    ";" | "\n" => "always",
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
