import { randomUUID } from "node:crypto";
import type { AssistantDecision } from "@agenthub/schemas";
import type {
  AssistantLiveOutput,
  AssistantReceipt,
  AssistantSettings,
  AssistantTurn,
  AssistantView,
  AssistantMemory,
  JournalRow,
} from "../../shared/workspace-assistant";
import {
  compactTurn,
  composeStep,
  contextBudget,
  defaults,
  maxTaskLength,
  modelContext,
  records,
  routingPrompt,
  tools,
  type CoreRequest,
  type Evidence,
  type PreparedContext,
} from "./context";
import { deliver, liveSessions, workspace } from "./workers";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1600);
const limitError = (error: unknown) =>
  /context.{0,30}(length|limit|window|large|exceed)|maximum.{0,20}tokens|prompt.{0,15}too long|上下文.{0,12}(超|满)/i.test(
    errText(error),
  );

export class WorkspaceAssistant {
  private settings: AssistantSettings = { ...defaults };
  private pending: JournalRow<AssistantTurn>[] = [];
  private running?: JournalRow<AssistantTurn>;
  private stopped = new Set<string>();
  private stage?: string;
  private liveOutput?: AssistantLiveOutput;
  private flush?: ReturnType<typeof setTimeout>;
  private init?: Promise<void>;
  private admission = Promise.resolve();
  private closing = false;
  constructor(
    private core: CoreRequest,
    private changed: (sessionId?: string) => void,
    private output: (draft: AssistantLiveOutput) => void = () => {},
  ) {}

  receiveText(stepId: string, delta: string) {
    const draft = this.liveOutput;
    if (!draft || draft.stepId !== stepId || this.stopped.has(draft.turnId) || this.closing) return;
    draft.text += delta;
    this.flush ??= setTimeout(() => {
      this.flush = undefined;
      if (this.liveOutput === draft) this.output({ ...draft });
    }, 40);
  }
  private clearOutput() {
    clearTimeout(this.flush);
    this.flush = undefined;
    this.liveOutput = undefined;
  }
  start(): Promise<void> {
    return (this.init ??= this.restore().catch((error) => {
      this.init = undefined;
      throw error;
    }));
  }
  private async restore() {
    const [saved, recent] = await Promise.all([
      records<AssistantSettings>(this.core, { kind: "settings", limit: 1 }),
      records<AssistantTurn>(this.core, { kind: "turn", limit: 40 }),
    ]);
    this.settings = saved[0]?.value ?? { ...defaults };
    for (const row of recent.reverse()) {
      if (row.value.status === "running") {
        row.value.status = "stopped";
        row.value.reply = "助手运行已中断。可从派发记录打开会话，查看任务是否已送达。";
        await this.save(row.value);
      } else if (row.value.status === "queued") this.pending.push(row);
    }
    this.pump();
  }
  private save(turn: AssistantTurn) {
    return this.core("assistant.save", { kind: "turn", id: turn.id, value: turn });
  }
  async view(before?: number): Promise<AssistantView> {
    await this.start();
    const [turns, memory] = await Promise.all([
      records<AssistantTurn>(this.core, { kind: "turn", before, limit: 20 }),
      records<AssistantMemory>(this.core, { kind: "memory", limit: 1 }),
    ]);
    return {
      settings: this.settings,
      turns: turns.reverse(),
      memoryAt: memory[0]?.value.at,
      busy: !!this.running,
      liveOutput: this.liveOutput ? { ...this.liveOutput } : undefined,
      stage: this.stage,
    };
  }
  async configure(value: AssistantSettings) {
    await this.start();
    const connection = (await this.core("connection.list", {})).find(
      (c) => c.id === value.connectionId && c.kind === "api" && c.enabled && c.hasCredential !== false,
    );
    const model = connection?.models?.find((m) => m.enabled !== false && m.id === value.model);
    if (!connection || !model) throw Error("请选择已保存密钥的 API 连接和已启用的模型。");
    if (!Number.isInteger(value.maxSteps) || value.maxSteps < 2 || value.maxSteps > 24)
      throw Error("每轮步数应为 2 至 24。");
    if (value.reasoningEffort && !model.reasoningEfforts?.includes(value.reasoningEffort))
      throw Error("所选推理强度不适用于这个模型。");
    const settings = {
      connectionId: connection.id,
      model: value.model,
      maxSteps: value.maxSteps,
      reasoningEffort: value.reasoningEffort || undefined,
    };
    await this.core("assistant.save", { kind: "settings", id: "settings", value: settings });
    this.settings = settings;
    this.changed();
  }
  submit(id: string, input: string): Promise<void> {
    const accept = async () => {
      await this.start();
      const text = input.trim();
      if (!/^turn_[a-zA-Z0-9-]{12,80}$/.test(id) || !text || text.length > 16000)
        throw Error("请输入 1 至 16000 字的指令。");
      if (
        (await records<AssistantTurn>(this.core, { kind: "turn", query: id, limit: 40 })).some(
          (r) => r.value.id === id,
        )
      )
        return;
      if (!this.settings.model) throw Error("请先在设置中配置助手模型。");
      if (this.pending.length >= 12) throw Error("待处理的指令已满。");
      const turn: AssistantTurn = { id, text, at: new Date().toISOString(), status: "queued", receipts: [] };
      const { seq } = await this.save(turn);
      this.pending.push({ seq, value: turn });
      this.changed();
      this.pump();
    };
    const next = this.admission.then(accept);
    this.admission = next.catch(() => {});
    return next;
  }
  async stop(id: string) {
    await this.start();
    if (this.running?.value.id === id) {
      this.stopped.add(id);
      this.setStage("stopping");
      return;
    }
    const index = this.pending.findIndex((t) => t.value.id === id);
    if (index < 0) return;
    const [row] = this.pending.splice(index, 1);
    row!.value.status = "stopped";
    await this.save(row!.value);
    this.changed();
  }
  close() {
    this.closing = true;
  }
  private setStage(value: string) {
    if (this.stage !== value) {
      this.stage = value;
      this.changed();
    }
  }
  private pump() {
    if (this.running || this.closing) return;
    const row = this.pending.shift();
    if (!row) return;
    this.running = row;
    void this.run(row)
      .catch((error) => console.error("Assistant journal:", errText(error)))
      .finally(() => {
        this.stopped.delete(row.value.id);
        this.running = undefined;
        this.stage = undefined;
        this.changed();
        this.pump();
      });
  }
  private async run(row: JournalRow<AssistantTurn>) {
    const turn = row.value;
    const config = { ...this.settings };
    const guard = () => {
      if (this.closing || this.stopped.has(turn.id)) throw Error("已停止");
    };
    turn.status = "running";
    await this.save(turn);
    this.setStage("thinking");
    const evidence: Evidence[] = [];
    try {
      const selected = (await this.core("connection.list", {}))
        .find((c) => c.id === config.connectionId && c.enabled)
        ?.models?.find((m) => m.id === config.model && m.enabled !== false);
      if (!selected) throw Error("助手模型已停用，请重新配置。");
      config.reasoningEffort = config.reasoningEffort || selected.defaultReasoningEffort;
      let windowSize = selected.contextWindow || 32768;
      let base: PreparedContext | undefined;
      for (let step = 0; step < config.maxSteps; step++) {
        guard();
        const decide = async (force: boolean) => {
          if (!base || force)
            base = await modelContext(
              this.core,
              config,
              windowSize,
              row,
              guard,
              () => this.setStage("compacting"),
              force,
            );
          const context = composeStep(base, evidence, contextBudget(windowSize));
          guard();
          this.clearOutput();
          const streamId = randomUUID();
          this.liveOutput = { turnId: turn.id, stepId: streamId, text: "" };
          this.setStage("thinking");
          try {
            return await this.core("assistant.modelStep", {
              ...config,
              streamId,
              instructions: routingPrompt,
              context,
              tools,
            });
          } finally {
            this.clearOutput();
          }
        };
        let decision: AssistantDecision;
        try {
          decision = await decide(false);
        } catch (error) {
          if (!limitError(error)) throw error;
          windowSize = Math.max(2048, Math.floor(windowSize / 2));
          decision = await decide(true);
        }
        guard();
        if (typeof decision.inputTokens === "number") {
          const usage = (turn.usage ??= { input: 0 });
          usage.input += decision.inputTokens;
          if (typeof decision.cacheReadTokens === "number")
            usage.cached = (usage.cached ?? 0) + decision.cacheReadTokens;
        }
        if (!decision.call) {
          if (!decision.text?.trim()) throw Error("助手模型未返回有效答复。");
          turn.reply = decision.text.trim();
          turn.status = "done";
          return;
        }
        const { name, arguments: args } = decision.call;
        this.setStage(name);
        let result: unknown;
        try {
          result = await this.execute(name, args, row, guard);
        } catch (error) {
          guard();
          result = { error: errText(error) };
        }
        evidence.push({ tool: name, arguments: args, result });
      }
      turn.reply = "已达到本轮步数上限。派发结果见下方记录，可继续给助手下达指令。";
      turn.status = "stopped";
    } catch (error) {
      turn.status = this.stopped.has(turn.id) || this.closing ? "stopped" : "error";
      turn.reply = errText(error);
    } finally {
      await this.save(turn);
    }
  }
  private async execute(
    name: string,
    args: Record<string, unknown>,
    row: JournalRow<AssistantTurn>,
    guard: () => void,
  ): Promise<unknown> {
    const str = (key: string, max = 200) =>
      typeof args[key] === "string" ? (args[key] as string).slice(0, max) : undefined;
    const num = (key: string) =>
      typeof args[key] === "number" && Number.isSafeInteger(args[key]) && (args[key] as number) >= 0
        ? (args[key] as number)
        : undefined;
    switch (name) {
      case "list_workspace":
        return workspace(this.core);
      case "list_sessions":
        return liveSessions(this.core, {
          projectId: str("projectId"),
          sessionId: str("sessionId"),
          query: str("query"),
          skip: num("skip"),
          previews: args.previews === true,
        });
      case "read_session":
        return this.core("assistant.excerpts", {
          sessionId: str("sessionId") ?? "",
          query: str("query"),
          before: num("before"),
          messageId: str("messageId"),
          offset: num("offset"),
        });
      case "find_history": {
        const seq = num("seq");
        if (seq !== undefined) {
          if (!seq || seq >= row.seq) throw Error("Choose an earlier exchange from the history results.");
          const [entry] = await records<AssistantTurn>(this.core, {
            kind: "turn",
            after: seq - 1,
            before: seq + 1,
            limit: 1,
          });
          if (!entry) throw Error("That assistant exchange is unavailable.");
          const offset = num("offset") ?? 0;
          const end = offset + 1200;
          const user = Array.from(entry.value.text);
          const answer = Array.from(entry.value.reply ?? "");
          return {
            ...compactTurn(entry),
            user: user.slice(offset, end).join(""),
            answer: answer.slice(offset, end).join(""),
            offset,
            nextOffset: end < Math.max(user.length, answer.length) ? end : null,
          };
        }
        const items = await records<AssistantTurn>(this.core, {
          kind: "turn",
          before: Math.min(num("before") ?? row.seq, row.seq),
          query: str("query"),
          limit: 6,
        });
        return {
          items: items.map((entry) => {
            const v = compactTurn(entry);
            return { ...v, user: v.user.slice(0, 500), answer: v.answer?.slice(0, 450) };
          }),
          next: items.length === 6 ? items[5]!.seq : null,
        };
      }
      case "send_task":
      case "create_session": {
        const task = args.task;
        if (typeof task !== "string" || !task.trim())
          throw Error("Supply task with the instruction the worker should receive.");
        if (Array.from(task).length > maxTaskLength)
          throw Error(`The task exceeds ${maxTaskLength} characters. Shorten the instruction and retry.`);
        const receipt: AssistantReceipt = await deliver(
          this.core,
          row.value,
          name,
          args,
          task,
          async () => {
            await this.save(row.value);
            this.changed();
          },
          guard,
          this.changed,
        );
        return {
          delivery: receipt.delivery,
          sessionId: receipt.sessionId,
          title: receipt.title,
          project: receipt.project,
          error: receipt.error,
        };
      }
      default:
        throw Error("Unknown workspace assistant tool");
    }
  }
}
