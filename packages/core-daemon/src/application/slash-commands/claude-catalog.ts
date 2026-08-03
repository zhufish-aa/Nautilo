import type { SlashCommandDefinition } from "@agenthub/domain";

export const CLAUDE_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { id: "claude-code.help", name: "/help", aliases: ["/?"], title: "帮助", description: "查看 Nautilo 当前支持的 Claude Code 会话指令", icon: "help", availability: "always" },
  { id: "claude-code.model", name: "/model", aliases: [], title: "模型", description: "Nautilo 本地设置：选择下一轮 Claude Code 会话使用的模型", icon: "model", availability: "always" },
  { id: "claude-code.reasoning", name: "/effort", aliases: ["/thinking"], title: "思考强度", description: "Nautilo 本地设置：选择下一轮使用的 effort 等级（low / medium / high / max）", icon: "reasoning", availability: "always" },
  { id: "claude-code.status", name: "/status", aliases: [], title: "会话状态", description: "查看模型、思考强度和 Provider 会话状态", icon: "status", availability: "always" },
  { id: "claude-code.usage", name: "/usage", aliases: [], title: "上下文用量", description: "查看当前上下文窗口和已用 Token", icon: "usage", availability: "always" },
  { id: "claude-code.rename", name: "/title", aliases: ["/rename"], title: "重命名会话", description: "Nautilo 本地设置：修改当前工作台会话标题", icon: "rename", availability: "always", argumentHint: "新标题", argumentRequired: true }
];

const CLAUDE_NATIVE_TITLES: Readonly<Record<string, string>> = {
  compact: "压缩上下文",
  cost: "用量与费用",
  doctor: "环境诊断",
  export: "导出会话",
  init: "初始化 CLAUDE.md",
  mcp: "MCP 状态",
  review: "代码审查",
  "security-review": "安全审查"
};

/**
 * Slash commands that run non-interactively under `claude -p` (verified
 * against Claude Code CLI 2.1). Interactive-only commands (/login, /config,
 * /model UI, /clear …) are deliberately excluded.
 */
const CLAUDE_PRINT_COMMANDS = new Set(["compact", "cost", "doctor", "export", "init", "mcp", "review", "security-review"]);

export function claudeProviderCommand(input: { name: string; description: string; inputHint?: string }): SlashCommandDefinition | undefined {
  const name = input.name.replace(/^\//, "");
  if (!CLAUDE_PRINT_COMMANDS.has(name)) return undefined;
  return {
    id: `claude-code.native.${name}`,
    name: `/${name}`,
    aliases: [],
    title: CLAUDE_NATIVE_TITLES[name] ?? name,
    description: input.description === name ? `由 Claude Code CLI 执行 /${name}` : input.description,
    icon: name === "compact" || name === "cost" ? "usage" : "status",
    // Every native command spawns a fresh headless process, so it must wait for a quiet session.
    availability: "idle",
    execution: "provider",
    argumentHint: input.inputHint
  };
}
