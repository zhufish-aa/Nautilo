import type { SlashCommandDefinition } from "@agenthub/domain";

export const KIMI_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { id: "kimi-code.model", name: "/model", aliases: [], title: "模型", description: "AgentHub 本地设置：选择下一轮 Kimi ACP 会话使用的模型", icon: "model", availability: "always", execution: "agenthub" },
  { id: "kimi-code.thinking", name: "/thinking", aliases: [], title: "思考强度", description: "AgentHub 本地设置：选择下一轮使用的 Thinking 等级", icon: "reasoning", availability: "always", execution: "agenthub" },
  { id: "kimi-code.rename", name: "/title", aliases: ["/rename"], title: "重命名会话", description: "AgentHub 本地设置：修改当前工作台会话标题", icon: "rename", availability: "always", execution: "agenthub", argumentHint: "新标题", argumentRequired: true },
  { id: "kimi-code.native.compact", name: "/compact", aliases: [], title: "压缩上下文", description: "压缩当前会话上下文，可附加保留内容说明", icon: "usage", availability: "idle", execution: "provider", argumentHint: "可选的压缩说明" },
  { id: "kimi-code.native.status", name: "/status", aliases: [], title: "会话状态", description: "由 Kimi ACP 返回当前会话状态", icon: "status", availability: "always", execution: "provider" },
  { id: "kimi-code.native.usage", name: "/usage", aliases: [], title: "上下文用量", description: "由 Kimi ACP 返回会话 Token 用量", icon: "usage", availability: "always", execution: "provider" },
  { id: "kimi-code.native.mcp", name: "/mcp", aliases: [], title: "MCP 状态", description: "查看当前会话的 MCP Server 状态", icon: "status", availability: "always", execution: "provider" },
  { id: "kimi-code.native.tasks", name: "/tasks", aliases: ["/task"], title: "后台任务", description: "列出 Kimi Code 后台任务", icon: "status", availability: "always", execution: "provider" },
  { id: "kimi-code.native.help", name: "/help", aliases: [], title: "Kimi ACP 帮助", description: "显示当前 Kimi CLI 实际支持的 ACP 命令", icon: "help", availability: "always", execution: "provider" }
];

const KIMI_TITLES: Readonly<Record<string, string>> = {
  compact: "压缩上下文", status: "会话状态", usage: "上下文用量", mcp: "MCP 状态", tasks: "后台任务", help: "Kimi ACP 帮助"
};

/** Verified against `kimi acp` `/help` on Kimi Code CLI 0.27.0. */
const KIMI_ACP_COMMANDS = new Set(["compact", "status", "usage", "mcp", "tasks", "help"]);

export function kimiProviderCommand(input: { name: string; description: string; inputHint?: string }): SlashCommandDefinition | undefined {
  const name = input.name.replace(/^\//, "");
  if (!KIMI_ACP_COMMANDS.has(name)) return undefined;
  return {
    id: `kimi-code.native.${name}`,
    name: `/${name}`,
    aliases: [],
    title: KIMI_TITLES[name] ?? name,
    description: input.description,
    icon: name === "compact" || name === "usage" ? "usage" : name === "help" ? "help" : "status",
    availability: name === "compact" ? "idle" : "always",
    execution: "provider",
    argumentHint: input.inputHint
  };
}
