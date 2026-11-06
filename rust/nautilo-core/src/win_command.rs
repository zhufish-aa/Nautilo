//! Windows spawn resolution — port of win-command.ts.

use std::collections::HashMap;

// ---------------------------------------------------------------- win-command

pub struct ResolvedSpawnCommand {
    pub command: String,
    pub args: Vec<String>,
    pub verbatim: bool,
}

/// Port of resolveSpawnCommand: Windows cannot spawn .cmd/.bat shims
/// directly, so they are wrapped in `cmd.exe /d /s /c "<line>"` (verbatim).
/// Everywhere else (or when the command cannot be resolved) the invocation is
/// returned unchanged so the caller's error handling still applies.
pub fn resolve_spawn_command(
    command: &str,
    args: &[String],
    env: Option<&HashMap<String, String>>,
) -> ResolvedSpawnCommand {
    if !cfg!(windows) {
        return ResolvedSpawnCommand { command: command.to_string(), args: args.to_vec(), verbatim: false };
    }
    let path_env = env_value(env, "PATH").unwrap_or_default();
    let pathext_env = env_value(env, "PATHEXT");
    let Some(resolved) = find_on_path(command, &path_env, pathext_env.as_deref()) else {
        return ResolvedSpawnCommand { command: command.to_string(), args: args.to_vec(), verbatim: false };
    };
    if !resolved.to_lowercase().ends_with(".cmd") && !resolved.to_lowercase().ends_with(".bat") {
        return ResolvedSpawnCommand { command: resolved, args: args.to_vec(), verbatim: false };
    }
    let line = format!(
        "\"{}\"",
        std::iter::once(quote_cmd_arg(&resolved))
            .chain(args.iter().map(|arg| quote_cmd_arg(arg)))
            .collect::<Vec<_>>()
            .join(" ")
    );
    ResolvedSpawnCommand { command: "cmd.exe".to_string(), args: vec![line], verbatim: true }
}

/// Case-insensitive env lookup: Windows typically spells it "Path".
fn env_value(env: Option<&HashMap<String, String>>, key: &str) -> Option<String> {
    if let Some(value) = env.and_then(|values|values.get(key)) { return Some(value.clone()); }
    let merged_process: HashMap<String, String> = std::env::vars().collect();
    for (name, value) in env.into_iter().flatten().chain(merged_process.iter()) {
        if name.eq_ignore_ascii_case(key) {
            return Some(value.clone());
        }
    }
    None
}

fn find_on_path(command: &str, path_env: &str, pathext_env: Option<&str>) -> Option<String> {
    let has_directory = command.contains(['/', '\\']) || command.len() >= 2 && command.as_bytes()[1] == b':';
    let extensions: Vec<String> = if has_directory {
        vec![String::new()]
    } else {
        pathext_env
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(str::to_string)
            .chain(std::iter::once(String::new()))
            .collect()
    };
    let directories: Vec<String> = if has_directory {
        vec![String::new()]
    } else {
        path_env.split(';').filter(|dir| !dir.is_empty()).map(str::to_string).collect()
    };
    for dir in &directories {
        for extension in &extensions {
            let candidate = if dir.is_empty() {
                format!("{command}{extension}")
            } else {
                format!("{dir}\\{command}{extension}")
            };
            if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                return Some(candidate);
            }
        }
    }
    None
}

fn quote_cmd_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| " \"&|<>^()%!".contains(c)) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\"\""))
}
