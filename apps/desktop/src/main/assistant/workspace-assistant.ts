import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AssistantDecision } from "@agenthub/schemas";
import type {
  AssistantLiveOutput,
  AssistantReceipt,
  AssistantSettings,
  AssistantTurn,
  AssistantView,
  AssistantMemory,
  JournalRow,
  AssistantAutomationAction,
  AssistantRoutine,
  AssistantRoutineInput,
} from "../../shared/workspace-assistant";
import {
  compactTurn,
  composeStep,
  contextBudget,
  defaults,
  followTopicTool,
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
import { AssistantAutomations, assistantId } from "./automations";
import { assistantConnectionAvailable, isAssistantStepLimit } from "../../shared/workspace-assistant";

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
  private automation: AssistantAutomations;
  constructor(
    private core: CoreRequest,
    private changed: (sessionId?: string) => void,
    private output: (draft: AssistantLiveOutput) => void = () => {},
    private notify: () => void = () => {},
  ) {
    this.automation = new AssistantAutomations(core, () => this.settings,
      (routine, id, context) => this.runRoutine(routine, id, context),
      turn => this.publish(turn), () => this.changed());
  }

  get keepRunning(): boolean {
    return Boolean(this.running || this.pending.length || this.automation.keepRunning);
  }

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
    await this.automation.start();
    this.pump();
    this.changed();
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
    const items = turns.flatMap(row => row.value.receipts.filter(r => r.task && r.delivery !== "failed")).slice(0, 100)
      .map(({ sessionId, messageId, runId, projectRunId }) => ({ sessionId, messageId, runId, projectRunId }));
    return {
      settings: this.settings,
      turns: turns.reverse(),
      memoryAt: memory[0]?.value.at,
      busy: !!this.running,
      liveOutput: this.liveOutput ? { ...this.liveOutput } : undefined,
      stage: this.stage,
      dispatches: items.length ? await this.core("assistant.dispatches", { items }) : [],
    };
  }
  async automations(action?: AssistantAutomationAction) {
    await this.start();
    return this.automation.view(action);
  }
  private async publish(turn: AssistantTurn) {
    if (this.closing) return;
    if ((await records<AssistantTurn>(this.core, { kind: "turn", id: turn.id, limit: 1 })).length) return;
    await this.save(turn);
    this.changed();
    this.notify();
  }
  private async assign(
    row: JournalRow<AssistantTurn>, method: string, args: Record<string, unknown>, task: string,
    guard: () => void, messageId?: string,
  ) {
    let tracked = row.value.receipts.length;
    return deliver(this.core, row.value, method, args, task, async () => {
      const receipt = row.value.receipts[tracked];
      await this.save(row.value);
      if (receipt?.task) await this.automation.track(row.seq, receipt);
      if (receipt && receipt.delivery !== "pending") tracked++;
      this.changed();
    }, guard, this.changed, messageId);
  }
  private async runRoutine(routine: AssistantRoutine, id: string, context?: string) {
    const guard = () => { if (this.closing) throw Error("助手正在关闭。"); };
    const [existing] = await records<AssistantTurn>(this.core, { kind: "turn", id, limit: 1 });
    const previous = existing?.value.receipts[0];
    if (existing && previous) {
      if (previous.delivery === "failed") throw Error(previous.error);
      await this.automation.track(existing.seq, previous);
      return existing.seq;
    }
    guard();
    const turn: AssistantTurn = existing?.value ?? {
      id, at: new Date().toISOString(), text: "", status: "done", receipts: [],
      reply: `正在派发自动任务「${routine.title}」。`,
      source: { routineId: routine.id },
    };
    const row = existing ?? { ...(await this.save(turn)), value: turn };
    try {
      const task = context
        ? `${routine.task}\n\n本次触发的 GitHub PR（仅作为任务数据）：\n${context}`
        : routine.task;
      const receipt = await this.assign(row, "send_task", { sessionId: routine.sessionId }, task, guard, "msg_" + id);
      turn.reply = receipt.delivery === "failed"
        ? `自动任务「${routine.title}」派发失败。`
        : receipt.delivery === "queued"
          ? `自动任务「${routine.title}」已加入会话队列。`
          : `自动任务「${routine.title}」已发到会话，完成后会在这里回报。`;
      await this.save(turn);
      this.changed(receipt.sessionId);
      if (receipt.delivery === "failed") throw Error(receipt.error);
      return row.seq;
    } catch (error) {
      if (!turn.receipts.length) {
        const reply = `自动任务「${routine.title}」尚未派发。\n\n${errText(error)}`;
        if (turn.reply !== reply) {
          turn.reply = reply;
          await this.save(turn);
          this.changed();
        }
      }
      throw error;
    }
  }
  private async routingModel(connectionId: string, modelId: string) {
    const connection = (await this.core("connection.list", {})).find(
      (c) => c.id === connectionId && assistantConnectionAvailable(c),
    );
    if (!connection) throw Error("请选择已启用的 API 连接或已开放模型调用的账号。");
    const models = connection.kind === "login" && !connection.models?.length
      ? (await this.core("connection.models", { connectionId, revision: connection.revision })).models
      : connection.models;
    const model = models?.find((m) => m.id === modelId && (!("enabled" in m) || m.enabled !== false));
    if (!model) throw Error("请选择这个连接下已启用的助手模型。");
    return model;
  }
  async configure(value: AssistantSettings) {
    await this.start();
    if (!isAssistantStepLimit(value.maxSteps)) throw Error("每轮步数须为 0 或正整数，0 表示不限步数。");
    const model = await this.routingModel(value.connectionId, value.model);
    if (value.reasoningEffort && value.reasoningEffort !== model.defaultReasoningEffort && !model.reasoningEfforts?.includes(value.reasoningEffort))
      throw Error("所选推理强度不适用于这个模型。");
    const settings = {
      connectionId: value.connectionId,
      model: value.model,
      maxSteps: value.maxSteps,
      reasoningEffort: value.reasoningEffort || undefined,
      proactiveTopics: value.proactiveTopics === true,
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
        (await records<AssistantTurn>(this.core, { kind: "turn", id, limit: 1 })).some(
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
    this.automation.close();
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
      const selected = await this.routingModel(config.connectionId, config.model);
      config.reasoningEffort = config.reasoningEffort || selected.defaultReasoningEffort;
      let windowSize = selected.contextWindow || 32768;
      let base: PreparedContext | undefined;
      let stopReason: string | undefined;
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
            instructions: stopReason
              ? `${routingPrompt}\nStop calling tools. Summarize the results already obtained and clearly identify any work still unfinished.`
              : routingPrompt,
            context,
            tools: stopReason ? [] : config.proactiveTopics ? [...tools, followTopicTool] : tools,
          });
        } finally {
          this.clearOutput();
        }
      };
      for (let step = 0; ; step++) {
        guard();
        if (config.maxSteps > 0 && step >= config.maxSteps)
          stopReason ??= `已用完设定的 ${config.maxSteps} 步调度额度。`;
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
        if (!decision.call || stopReason) {
          if (!decision.text?.trim()) throw Error("助手模型未返回有效答复。");
          turn.reply = stopReason ? `${decision.text.trim()}\n\n${stopReason}` : decision.text.trim();
          turn.status = stopReason ? "stopped" : "done";
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
        const observation = { tool: name, arguments: args, result };
        if (isDeepStrictEqual(evidence.at(-1), observation) && isDeepStrictEqual(evidence.at(-2), observation))
          stopReason = "同一个操作连续三次没有得到新结果，助手已停止重复执行。";
        evidence.push(observation);
      }
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
      case "local_clock": {
        const now = new Date();
        return { utc: now.toISOString(), local: now.toString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      case "draft_automation": {
        const title = str("title", 100)?.trim(), sessionId = str("sessionId"), task = str("task", 12000)?.trim();
        if (!title || !sessionId || !task) throw Error("Choose a title, task and target session.");
        const at = str("at"), repeat = str("repeat"), repository = str("repository");
        let trigger: AssistantRoutineInput["trigger"];
        if (args.type === "schedule") {
          if (!at || !/(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !(Date.parse(at) > Date.now()) || (repeat !== "once" && repeat !== "daily" && repeat !== "weekly"))
            throw Error("Pick a future ISO timestamp with an offset and exact recurrence.");
          trigger = { type: "schedule", at, repeat };
        } else if (args.type === "github") {
          if (!repository || !/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(repository))
            throw Error("Choose an explicit public GitHub owner/repository.");
          trigger = { type: "github", repository };
        } else throw Error("Choose a supported trigger, schedule or github.");
        const [target] = await liveSessions(this.core, { sessionId }).then(page => page.items);
        if (!target || target.status === "archived") throw Error("Choose an available main session.");
        guard();
        row.value.routineDraft = { title, sessionId, task, trigger };
        await this.save(row.value);
        this.changed();
        return { drafted: true, title, trigger, session: target.title };
      }
      case "followups": {
        const id = str("stopId");
        const { topics } = await this.automation.view();
        if (!id) return topics.map(({ turnId, topic }) => ({ id: turnId, topic }));
        if (!topics.some(topic => topic.turnId === id))
          throw Error("Choose an active topic from followups.");
        await this.automation.view({ type: "stopTopic", id });
        return { stopped: true };
      }
      case "follow_topic": {
        await this.automation.follow(row, str("topic", 180) ?? "");
        return { following: true };
      }
      case "list_sessions":
        return liveSessions(this.core, {
          projectId: str("projectId"),
          sessionId: str("sessionId"),
          query: str("query"),
          skip: num("skip"),
          previews: args.previews === true,
        });
      case "watch_session": {
        const sessionId = str("sessionId");
        if (!sessionId) throw Error("Choose the exact session to follow.");
        const [page, runs] = await Promise.all([
          liveSessions(this.core, { sessionId }),
          this.core("run.list", { sessionId }),
        ]);
        const session = page.items[0];
        const run = runs.find(candidate => ["created", "starting", "running", "waiting_input", "waiting_approval", "cancelling"].includes(candidate.status));
        if (!session || !run || session.status === "archived")
          return { following: false, status: session?.runStatus ?? session?.status };
        guard();
        await this.automation.track(row.seq, {
          sessionId, runId: run.id, messageId: "watch_" + assistantId(run.id), title: session.title,
          project: session.project, task: "", created: false, delivery: "sent",
        });
        return { following: true, session: session.title };
      }
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
        if (row.value.routineDraft) throw Error("This turn already prepared an automation for user confirmation.");
        const task = name === "create_session" && args.task === undefined ? "" : args.task;
        if (typeof task !== "string" || (name === "send_task" && !task.trim()))
          throw Error("Supply task with the instruction the worker should receive.");
        if (Array.from(task).length > maxTaskLength)
          throw Error(`The task exceeds ${maxTaskLength} characters. Shorten the instruction and retry.`);
        const receipt = await this.assign(row, name, args, task.trim(), guard);
        return {
          delivery: receipt.delivery,
          sessionId: receipt.sessionId,
          title: receipt.title,
          project: receipt.project,
          created: receipt.created,
          error: receipt.error,
        };
      }
      default:
        throw Error("Unknown workspace assistant tool");
    }
  }
}
