import type { SlashCommandDefinition } from "@agenthub/domain";

export const CODEX_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { id: "codex.help", name: "/help", aliases: ["/?"], title: "帮助", description: "查看 AgentHub 当前支持的 Codex 会话指令", icon: "help", availability: "always" },
  { id: "codex.model", name: "/model", aliases: [], title: "模型", description: "选择当前 Codex 会话使用的模型", icon: "model", availability: "always" },
  { id: "codex.reasoning", name: "/reasoning", aliases: [], title: "推理深度", description: "选择当前模型支持的 reasoning effort", icon: "reasoning", availability: "always" },
  { id: "codex.fast", name: "/fast", aliases: [], title: "速度", description: "选择标准或 Provider 提供的快速服务层", icon: "speed", availability: "always" },
  { id: "codex.status", name: "/status", aliases: [], title: "会话状态", description: "查看模型、推理深度和 Provider 会话状态", icon: "status", availability: "always" },
  { id: "codex.usage", name: "/usage", aliases: [], title: "上下文用量", description: "查看当前上下文窗口和已用 Token", icon: "usage", availability: "always" },
  { id: "codex.rename", name: "/rename", aliases: ["/title"], title: "重命名会话", description: "修改当前 AgentHub 与 Codex 会话标题", icon: "rename", availability: "always", argumentHint: "新标题" }
];
