import type {
  AgentInstance,
  ProviderModel,
  ProviderModelCatalog,
  Session,
  SlashCommandDefinition,
  SlashCommandOption,
  SlashCommandResult
} from "@agenthub/domain";
import type { RuntimeEvent } from "@agenthub/event-protocol";
import { Database } from "../../database/index.js";
import { CoreError } from "../../errors.js";
import { AuditService } from "../../runtime/observability/audit-service.js";
import { MemberRouter } from "../../runtime/orchestration/member-router.js";
import { AgentService } from "../agent-service.js";
import { RunService } from "../../runtime/run-service.js";
import { slashCommandCatalog } from "./catalog.js";

interface CommandContext {
  session: Session;
  agent: AgentInstance;
  catalog: ProviderModelCatalog;
  model?: ProviderModel;
}

export class SlashCommandService {
  private readonly members: MemberRouter;

  constructor(
    private readonly database: Database,
    private readonly agents: AgentService,
    private readonly audit: AuditService,
    private readonly runs?: RunService
  ) {
    this.members = new MemberRouter(database);
  }

  list(sessionId: string): SlashCommandDefinition[] {
    const { agent } = this.resolveBase(sessionId);
    return slashCommandCatalog(agent.providerId, this.latestProviderCommands(sessionId, agent.providerId));
  }

  async execute(sessionId: string, commandId: string, argument?: string): Promise<SlashCommandResult> {
    const context = await this.resolve(sessionId);
    const command = this.assertCommand(sessionId, commandId);
    if (command.execution === "provider") return this.executeProviderCommand(context, command, argument);
    const action = commandId.split(".").at(-1);
    let result: SlashCommandResult;
    if (action === "help") result = this.help(context.session.id, context.agent.providerId);
    else if (action === "model") result = this.modelPicker(context);
    else if (action === "reasoning" || action === "thinking") result = this.reasoningPicker(context, commandId);
    else if (action === "fast") result = this.speedPicker(context);
    else if (action === "status") result = this.status(context);
    else if (action === "usage") result = this.usage(context);
    else if (action === "rename") result = this.rename(context, argument);
    else throw new CoreError("IPC_INVALID_REQUEST", { commandId });
    this.record(sessionId, commandId, "opened");
    return result;
  }

  async continue(input: { sessionId: string; commandId: string; actionId: string; selectedOptionIds?: string[] }): Promise<SlashCommandResult> {
    const context = await this.resolve(input.sessionId);
    this.assertCommand(input.sessionId, input.commandId);
    if (input.actionId === "close") return this.closed(input.commandId);
    if (input.actionId !== "apply") throw new CoreError("IPC_INVALID_REQUEST", { actionId: input.actionId });
    const selected = input.selectedOptionIds ?? [];
    if (selected.length !== 1) throw new CoreError("IPC_INVALID_REQUEST", { reason: "exactly_one_selection_required" });
    const value = selected[0]!;
    const action = input.commandId.split(".").at(-1);
    let patch: NonNullable<SlashCommandResult["sessionPatch"]>;
    if (action === "model") {
      const model = context.catalog.models.find((item) => item.id === value);
      if (!model) throw new CoreError("IPC_INVALID_REQUEST", { model: value });
      patch = {
        model: model.id,
        reasoningEffort: model.defaultReasoningEffort ?? model.reasoningEfforts[0] ?? "",
        serviceTier: model.defaultServiceTier ?? ""
      };
    } else if (action === "reasoning" || action === "thinking") {
      if (!context.model?.reasoningEfforts.includes(value)) throw new CoreError("IPC_INVALID_REQUEST", { reasoningEffort: value });
      patch = { reasoningEffort: value };
    } else if (action === "fast") {
      patch = this.speedPatch(context, value);
    } else {
      throw new CoreError("IPC_INVALID_REQUEST", { commandId: input.commandId });
    }
    const session = this.savePatch(context.session, patch);
    this.record(input.sessionId, input.commandId, "applied", { selected: value });
    return {
      commandId: input.commandId,
      title: "设置已更新",
      sections: [{ kind: "text", text: "新设置将在下一条消息开始时传给当前 CLI。" }],
      actions: [{ id: "close", label: "完成", kind: "primary" }],
      completed: true,
      sessionPatch: {
        title: session.title,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        serviceTier: session.serviceTier
      }
    };
  }

  private resolveBase(sessionId: string): { session: Session; agent: AgentInstance } {
    const session = this.database.sessions.get(sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: sessionId });
    return { session, agent: this.members.resolveSession(session) };
  }

  private async resolve(sessionId: string): Promise<CommandContext> {
    const { session, agent } = this.resolveBase(sessionId);
    const catalog = await this.agents.listModels(agent.providerId, agent.executable, agent.id);
    const modelId = session.model || catalog.defaultModel;
    return { session, agent, catalog, model: catalog.models.find((item) => item.id === modelId) };
  }

  private assertCommand(sessionId: string, commandId: string): SlashCommandDefinition {
    const { agent } = this.resolveBase(sessionId);
    const command = this.list(sessionId).find((item) => item.id === commandId);
    if (!command) {
      throw new CoreError("IPC_INVALID_REQUEST", { providerId: agent.providerId, commandId });
    }
    return command;
  }

  private async executeProviderCommand(
    context: CommandContext,
    command: SlashCommandDefinition,
    argument?: string
  ): Promise<SlashCommandResult> {
    if (!this.runs) throw new CoreError("IPC_INVALID_REQUEST", { reason: "provider_command_runtime_unavailable" });
    if (command.availability === "idle" && ["running", "starting", "cancelling"].includes(context.session.status)) {
      throw new CoreError("IPC_INVALID_REQUEST", { reason: "provider_command_requires_idle", commandId: command.id });
    }
    const nativeCommand = [command.name, argument?.trim()].filter(Boolean).join(" ");
    const handle = await this.runs.launch(context.session, context.agent, nativeCommand, { presentation: "provider_command" });
    const completion = await handle.completion;
    const failed = ["failed", "timed_out", "crashed"].includes(completion.run.status);
    this.record(context.session.id, command.id, failed ? "failed" : "completed", { runId: handle.runId });
    if (failed) {
      throw new CoreError("RUN_START_FAILED", {
        commandId: command.id,
        failureCode: completion.run.failureCode ?? "PROVIDER_COMMAND_FAILED"
      });
    }
    const output = completion.finalMessage?.trim();
    return {
      commandId: command.id,
      title: command.title,
      description: `${command.name} 已由 Kimi Code CLI 处理，未作为普通聊天消息发送。`,
      sections: [{
        kind: "text",
        text: output || (completion.run.status === "cancelled"
          ? "Kimi Code 已结束该控制命令。"
          : "Kimi Code 已执行该控制命令，没有返回额外文本。")
      }],
      actions: [{ id: "close", label: "关闭", kind: "primary" }],
      completed: true
    };
  }

  private help(sessionId: string, providerId: string): SlashCommandResult {
    return {
      commandId: `${providerId}.help`,
      title: providerId === "codex" ? "Codex 指令" : "Kimi Code 指令",
      description: "这里只展示 AgentHub 已接入并可执行的 Provider 指令。",
      sections: [{ kind: "list", items: this.list(sessionId).map((command) => ({
        label: command.name,
        description: command.description
      })) }],
      actions: [{ id: "close", label: "关闭", kind: "primary" }],
      completed: true
    };
  }

  private modelPicker(context: CommandContext): SlashCommandResult {
    return this.selectionResult(`${context.agent.providerId}.model`, "选择模型", "模型将在下一条消息开始时生效。", context.catalog.models.map((model) => ({
      id: model.id,
      label: model.displayName,
      description: model.description ?? model.id,
      selected: model.id === (context.session.model || context.catalog.defaultModel)
    })));
  }

  private reasoningPicker(context: CommandContext, commandId: string): SlashCommandResult {
    const efforts = context.model?.reasoningEfforts ?? [];
    if (efforts.length === 0) {
      return {
        commandId,
        title: "当前模型没有可选推理等级",
        sections: [{ kind: "text", text: "Provider 的模型目录没有返回可切换的推理/思考强度。" }],
        actions: [{ id: "close", label: "关闭", kind: "primary" }],
        completed: true
      };
    }
    const current = context.session.reasoningEffort || context.model?.defaultReasoningEffort;
    return this.selectionResult(commandId, commandId.endsWith("thinking") ? "选择思考强度" : "选择推理深度", "该设置将在下一条消息开始时生效。", efforts.map((effort) => ({
      id: effort,
      label: effortLabel(effort),
      selected: effort === current
    })));
  }

  private speedPicker(context: CommandContext): SlashCommandResult {
    const highspeed = context.catalog.models.find((item) => /high[-_ ]?speed/i.test(`${item.id} ${item.displayName}`));
    const options: SlashCommandOption[] = [{
      id: "standard",
      label: "标准",
      selected: !context.session.serviceTier && context.model?.id !== highspeed?.id
    }];
    for (const tier of context.model?.serviceTiers ?? []) options.push({
      id: `tier:${tier.id}`,
      label: tier.name,
      description: tier.description,
      selected: context.session.serviceTier === tier.id
    });
    if (highspeed && options.length === 1) options.push({
      id: `model:${highspeed.id}`,
      label: highspeed.displayName,
      description: highspeed.description,
      selected: context.model?.id === highspeed.id
    });
    return this.selectionResult("codex.fast", "选择运行速度", "仅显示当前 Provider 模型目录真实提供的速度选项。", options);
  }

  private status(context: CommandContext): SlashCommandResult {
    return {
      commandId: `${context.agent.providerId}.status`,
      title: "当前会话状态",
      sections: [{ kind: "key_value", items: [
        { label: "Provider", value: context.agent.providerId },
        { label: "Agent 实例", value: context.agent.displayName },
        { label: "模型", value: context.model?.displayName ?? context.session.model ?? "Provider 默认" },
        { label: "推理深度", value: context.session.reasoningEffort ?? context.model?.defaultReasoningEffort ?? "Provider 默认" },
        { label: "Provider 会话", value: context.session.providerSessionId ?? "尚未建立" },
        { label: "状态", value: context.session.status }
      ] }],
      actions: [{ id: "close", label: "关闭", kind: "primary" }],
      completed: true
    };
  }

  private usage(context: CommandContext): SlashCommandResult {
    const usage = this.latestUsage(context.session.id);
    const used = numberValue(usage?.payload.contextUsed);
    const window = numberValue(usage?.payload.contextWindow) ?? context.model?.contextWindow;
    const percent = used !== undefined && window ? `${Math.round(used / window * 100)}%` : "等待 Provider 返回";
    return {
      commandId: `${context.agent.providerId}.usage`,
      title: "上下文用量",
      sections: [{ kind: "key_value", items: [
        { label: "已使用", value: used === undefined ? "尚未返回" : tokenLabel(used) },
        { label: "上下文上限", value: window === undefined ? "未知" : tokenLabel(window) },
        { label: "占用比例", value: percent }
      ] }],
      actions: [{ id: "close", label: "关闭", kind: "primary" }],
      completed: true
    };
  }

  private rename(context: CommandContext, argument?: string): SlashCommandResult {
    const title = argument?.trim();
    if (!title) {
      return {
        commandId: `${context.agent.providerId}.rename`,
        title: "重命名会话",
        description: "请在指令后输入新标题，例如 /rename 登录功能调试。",
        sections: [{ kind: "key_value", items: [{ label: "当前标题", value: context.session.title }] }],
        actions: [{ id: "close", label: "关闭", kind: "primary" }],
        completed: true
      };
    }
    const session = this.savePatch(context.session, { title: title.slice(0, 200) });
    this.record(session.id, `${context.agent.providerId}.rename`, "applied");
    return {
      commandId: `${context.agent.providerId}.rename`,
      title: "会话已重命名",
      sections: [{ kind: "key_value", items: [{ label: "新标题", value: session.title }] }],
      actions: [{ id: "close", label: "完成", kind: "primary" }],
      completed: true,
      sessionPatch: { title: session.title }
    };
  }

  private selectionResult(commandId: string, title: string, description: string, options: SlashCommandOption[]): SlashCommandResult {
    return {
      commandId,
      title,
      description,
      sections: [],
      selection: { mode: "single", options, minimum: 1, maximum: 1 },
      actions: [
        { id: "close", label: "取消", kind: "secondary" },
        { id: "apply", label: "应用", kind: "primary", requiresSelection: true }
      ],
      completed: false
    };
  }

  private speedPatch(context: CommandContext, value: string): NonNullable<SlashCommandResult["sessionPatch"]> {
    if (value === "standard") return { serviceTier: "" };
    if (value.startsWith("tier:")) {
      const id = value.slice(5);
      if (!context.model?.serviceTiers.some((item) => item.id === id)) throw new CoreError("IPC_INVALID_REQUEST", { serviceTier: id });
      return { serviceTier: id };
    }
    if (value.startsWith("model:")) {
      const id = value.slice(6);
      const model = context.catalog.models.find((item) => item.id === id && /high[-_ ]?speed/i.test(`${item.id} ${item.displayName}`));
      if (!model) throw new CoreError("IPC_INVALID_REQUEST", { model: id });
      return { model: model.id, reasoningEffort: model.defaultReasoningEffort ?? model.reasoningEfforts[0] ?? "", serviceTier: "" };
    }
    throw new CoreError("IPC_INVALID_REQUEST", { speed: value });
  }

  private savePatch(session: Session, patch: NonNullable<SlashCommandResult["sessionPatch"]>): Session {
    const updated = { ...session, ...patch, updatedAt: new Date().toISOString() };
    this.database.sessions.save(updated);
    return updated;
  }

  private latestUsage(sessionId: string): Extract<RuntimeEvent, { type: "usage.updated" }> | undefined {
    return this.database.events.replay({ sessionId }).filter((event): event is Extract<RuntimeEvent, { type: "usage.updated" }> => event.type === "usage.updated").at(-1);
  }

  private latestProviderCommands(sessionId: string, providerId: string): Array<{ name: string; description: string; inputHint?: string }> {
    return this.database.events.replay({ sessionId })
      .filter((event): event is Extract<RuntimeEvent, { type: "provider.commands_updated" }> => event.type === "provider.commands_updated" && event.payload.providerId === providerId)
      .at(-1)?.payload.commands ?? [];
  }

  private closed(commandId: string): SlashCommandResult {
    return { commandId, title: "已关闭", sections: [], actions: [], completed: true };
  }

  private record(sessionId: string, commandId: string, outcome: string, details?: Record<string, unknown>): void {
    this.audit.record({ actorType: "user", actorId: "desktop-user", action: `slash_command.${outcome}`, resourceType: "session", resourceId: sessionId, outcome: "success", details: { commandId, ...details } });
  }
}

function effortLabel(value: string): string {
  return ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" } as Record<string, string>)[value.toLowerCase()] ?? value;
}

function tokenLabel(value: number): string {
  return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)} tokens`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
