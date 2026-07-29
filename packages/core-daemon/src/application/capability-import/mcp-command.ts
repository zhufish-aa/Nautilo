import type { McpCandidate } from "@agenthub/schemas";

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Splits a shell-ish command line into tokens, honouring single/double quotes
 * so paths with spaces survive. Backslashes are left alone because Windows
 * paths are the common case here.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Derives a readable server name from the package or binary being launched. */
function inferName(command: string, args: string[]): string {
  // `npx -y @scope/server-github` reads better as "server-github" than "npx".
  const packageArg = args.find((arg) => !arg.startsWith("-"));
  const basis = /^(npx|bunx|pnpm|yarn|uvx|uv|pipx|deno|node|python|python3)(\.\w+)?$/i.test(command)
    ? (packageArg ?? command)
    : command;
  const withoutVersion = basis.replace(/@[^@/]+$/, "");
  const last = withoutVersion.split(/[\\/]/).pop() ?? withoutVersion;
  return last.replace(/\.(exe|cmd|js|mjs|py)$/i, "").replace(/^@/, "") || command;
}

/**
 * Parses a copy-pasted launch command such as
 * `npx -y @modelcontextprotocol/server-filesystem D:/work` into a stdio server,
 * so users no longer have to split command/args by hand.
 */
export function parseMcpCommandLine(input: string): { servers: McpCandidate[]; errors: string[] } {
  // Strip a leading shell prompt and any `$ ` copied along with the snippet.
  let line = input.trim().replace(/^[$>#]\s+/, "");
  if (!line) return { servers: [], errors: [] };
  if (line.includes("\n")) line = line.split("\n").map((part) => part.trim()).filter(Boolean).join(" ");

  const warnings: string[] = [];
  const tokens = tokenize(line);
  const env: Record<string, string> = {};
  // `env KEY=value cmd` — drop the wrapper before reading the assignments.
  if (tokens.length > 0 && tokens[0].toLowerCase() === "env") tokens.shift();
  // Leading `KEY=value` pairs are environment, not the command itself.
  while (tokens.length > 0) {
    const match = ENV_ASSIGNMENT.exec(tokens[0]);
    if (!match) break;
    env[match[1]] = match[2];
    tokens.shift();
  }

  const command = tokens.shift();
  if (!command) return { servers: [], errors: ["未解析出可执行命令"] };
  if (Object.keys(env).length > 0) warnings.push("已识别命令前的环境变量赋值");

  return {
    servers: [
      {
        name: inferName(command, tokens),
        description: "",
        tags: [],
        mcp: {
          transport: "stdio",
          command,
          ...(tokens.length > 0 ? { args: tokens } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {})
        },
        enabled: true,
        warnings
      }
    ],
    errors: []
  };
}
