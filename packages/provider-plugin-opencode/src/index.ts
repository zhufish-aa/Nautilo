/**
 * AgentHub provider plugin for OpenCode.
 *
 * Wraps `opencode run --format json`: one run = one spawned CLI process whose
 * stdout is a JSONL event stream. Behavior mirrors the daemon's built-in
 * OpenCode adapter — installing this plugin overrides the built-in, and
 * disabling/uninstalling it restores the built-in.
 *
 * The SDK is imported type-only: the compiled plugin is fully self-contained
 * and resolves nothing from the host at runtime.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { platform } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AdapterDetectionResult,
  AdapterDiscoveryContext,
  AdapterEvent,
  AdapterResumeRequest,
  AdapterRun,
  AdapterStartRequest,
  AgentCliAdapter,
  AgentInstance,
  ProcessEvent,
  ProcessHandle,
  ProviderDescriptor,
  InteractionOption,
  InteractionPlan,
  InteractionQuestion,
  ProviderModel,
  ProviderModelCatalog,
  ProviderPluginFactory
} from "@agenthub/provider-sdk";

// Keep in sync with agenthub-plugin.json (the descriptor is duplicated there
// so the host can render the catalog entry without loading plugin code).
const descriptor: ProviderDescriptor = {
  providerId: "opencode",
  name: "OpenCode",
  vendor: "OpenCode",
  capabilities: ["headless_text", "provider_server"],
  defaultExecutable: "opencode",
  credentialEnv: ["OPENCODE_API_KEY"],
  permissionModes: [
    {
      value: "build",
      name: { "zh-CN": "执行模式", "en-US": "Build mode" },
      description: { "zh-CN": "正常执行，可修改文件", "en-US": "Normal execution with file edits" }
    },
    {
      value: "plan",
      name: { "zh-CN": "计划模式", "en-US": "Plan mode" },
      description: { "zh-CN": "只读探索，批准计划后再执行", "en-US": "Read-only planning until the plan is approved" }
    }
  ]
};

/**
 * Native commands this plugin can execute headlessly; reported to the host at
 * the start of every run (provider.commands_updated). `compact` opts into the
 * daemon's dedicated-transport flow, which this adapter honors via the
 * server's summarize endpoint instead of a chat prompt.
 */
const NATIVE_COMMANDS = [
  { name: "compact", description: "压缩当前会话上下文（OpenCode summarize）", providerCommand: "compact" as const }
];

class OpenCodePluginAdapter implements AgentCliAdapter {
  readonly providerId = "opencode";
  readonly descriptor = descriptor;
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;
  readonly capabilities = {
    structuredOutput: true,
    textOutput: true,
    interactiveStdin: false,
    nativeResume: true,
    pty: false
  };

  async detect(instance: { executable: string }): Promise<AdapterDetectionResult> {
    const executable = instance.executable || descriptor.defaultExecutable || "opencode";
    try {
      const version = await capture(executable, ["--version"]);
      if (version.exitCode !== 0) {
        return { installed: false, executable, error: version.text || `exit ${version.exitCode ?? "unknown"}` };
      }
      const help = await capture(executable, ["--help"]);
      return {
        installed: true,
        compatible: help.exitCode === 0,
        executable,
        version: version.text.trim(),
        help: help.text.slice(0, 16_384),
        error: help.exitCode === 0 ? undefined : help.text || `help exited with ${help.exitCode ?? "unknown"}`
      };
    } catch (error) {
      return { installed: false, executable, error: error instanceof Error ? error.message : String(error) };
    }
  }

  start(request: AdapterStartRequest): AdapterRun {
    if (request.providerCommand === "compact") {
      throw new Error("OpenCode context compaction requires an existing provider session");
    }
    return request.instance.baseArgs.length
      ? this.spawnRun(request, startArgs(request.instance, request))
      : this.serverRun(request, false);
  }

  resume(request: AdapterResumeRequest): AdapterRun {
    // Provider commands (compact) always use the server transport: `run`
    // has no headless summarize surface.
    if (!request.instance.baseArgs.length || request.providerCommand) return this.serverRun(request, true);
    return this.spawnRun(
      request,
      [...request.instance.baseArgs, "--session", request.providerSessionId, request.prompt]
    );
  }

  async listModels(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog> {
    const executable = instance.executable || descriptor.defaultExecutable || "opencode";
    const result = await capture(executable, ["models", "--verbose"], context?.env);
    if (result.exitCode !== 0) throw new Error(result.text.trim() || `opencode models --verbose exited with ${result.exitCode ?? "unknown"}`);
    return parseOpenCodeModels(result.text);
  }

  private spawnRun(request: AdapterStartRequest, args: string[]): AdapterRun {
    const env = (request.env ?? {}) as Record<string, string>;
    const resolved = resolveSpawnCommand(request.instance.executable || descriptor.defaultExecutable || "opencode", args, env);
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim ?? false
    });
    const process = new PluginProcessHandle(child, {
      timeoutMs: request.timeoutMs,
      idleTimeoutMs: request.idleTimeoutMs,
      maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
    });
    // OpenCode runs non-interactively here; close stdin so it never waits on it.
    child.stdin.end();
    return {
      process,
      events: streamEvents(process),
      cancel: () => process.cancel(),
      write: (input) => process.write(input)
    };
  }

  /**
   * OpenCode's `run --format json` command explicitly denies question and
   * plan_exit requests. Use its documented headless server API instead so the
   * plugin can bridge question.asked to AgentHub and reply over HTTP.
   */
  private serverRun(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
    let handle: PluginProcessHandle | undefined;
    let baseUrl: string | undefined;
    let sessionId = resume ? (request as AdapterResumeRequest).providerSessionId : undefined;
    let finished = false;

    const events = async function* (): AsyncGenerator<AdapterEvent> {
      try {
        yield { kind: "commands", commands: NATIVE_COMMANDS };
        const port = await availablePort();
        const env = (request.env ?? {}) as Record<string, string>;
        const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
        const resolvedCommand = resolveSpawnCommand(request.instance.executable || descriptor.defaultExecutable || "opencode", args, env);
        const child = spawn(resolvedCommand.command, resolvedCommand.args, {
          cwd: request.cwd,
          env,
          windowsHide: true,
          windowsVerbatimArguments: resolvedCommand.verbatim ?? false
        });
        handle = new PluginProcessHandle(child, {
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
        });
        baseUrl = `http://127.0.0.1:${port}`;
        await waitForServer(baseUrl, request.cwd, child);

        const stream = await openEventStream(baseUrl, request.cwd);
        if (!sessionId) {
          const created = await apiJson(baseUrl, request.cwd, "/session", {
            method: "POST",
            body: { title: request.prompt.slice(0, 80) }
          });
          sessionId = String(asRecord(created).id ?? "");
          if (!sessionId) throw new Error("OpenCode server did not return a session id");
        }
        yield { kind: "session", providerSessionId: sessionId };
        yield { kind: "status", phase: "turn_started" };

        if (request.providerCommand === "compact") {
          // Native compaction: POST /session/:id/summarize (requires the model
          // to summarize with). The summary streams over the same event bus,
          // and session.status → idle ends the run like a normal turn.
          const model = await resolveSummarizeModel(baseUrl, request.cwd, sessionId, request.model);
          await apiJson(baseUrl, request.cwd, `/session/${encodeURIComponent(sessionId)}/summarize`, {
            method: "POST",
            body: model
          });
        } else {
          const mode = request.permissionMode
            ?? (typeof request.instance.providerOptions?.permissionMode === "string"
              ? request.instance.providerOptions.permissionMode
              : undefined);
          await apiJson(baseUrl, request.cwd, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
            method: "POST",
            body: {
              ...(openCodeModel(request.model) ? { model: openCodeModel(request.model) } : {}),
              ...(mode === "plan" || mode === "build" ? { agent: mode } : {}),
              parts: [
                { type: "text", text: request.prompt },
                ...(request.localImagePaths ?? []).map((path) => ({
                  type: "file",
                  url: pathToFileURL(path).href,
                  filename: path.split(/[\\/]/).at(-1) ?? "image",
                  mime: "application/octet-stream"
                }))
              ]
            }
          });
        }

        // Sub-agent (task tool) child sessions also publish on the event bus.
        // Forward their activity tagged with the dispatching task part's call
        // id instead of dropping it: pending task parts are matched FIFO to
        // newly confirmed child sessions (verified via the session's parentID).
        const pendingTaskParts: string[] = [];
        const childSessions = new Map<string, string>();
        const rejectedSessions = new Set<string>();

        for await (const raw of stream) {
          const event = unwrapServerEvent(raw);
          const properties = asRecord(event.properties);
          const eventSessionId = String(properties.sessionID ?? "");
          const knownChild = eventSessionId ? childSessions.has(eventSessionId) : false;
          if (
            eventSessionId
            && eventSessionId !== sessionId
            && !knownChild
            && String(event.type ?? "") !== "message.part.updated"
          ) continue;
          switch (String(event.type ?? "")) {
            case "message.part.updated": {
              const part = asRecord(properties.part);
              const partSessionId = String(part.sessionID ?? "");
              const isMain = !partSessionId || partSessionId === sessionId;
              if (isMain && String(part.type ?? "") === "tool" && String(part.tool ?? "") === "task") {
                const callId = String(part.callID ?? part.id ?? "");
                if (callId && !pendingTaskParts.includes(callId)) pendingTaskParts.push(callId);
                // Exact pairing: opencode puts the child session id into the
                // task part's metadata (state.metadata.sessionId) before the
                // child starts, so parallel dispatches never rely on FIFO
                // order. The pending queue stays as a fallback for older
                // servers without that metadata.
                const childId = String(asRecord(asRecord(part.state).metadata).sessionId ?? "");
                if (callId && childId && !childSessions.has(childId)) {
                  childSessions.set(childId, callId);
                  const pendingIndex = pendingTaskParts.indexOf(callId);
                  if (pendingIndex >= 0) pendingTaskParts.splice(pendingIndex, 1);
                }
              }
              let subagentDispatchId: string | undefined;
              if (!isMain) {
                subagentDispatchId = childSessions.get(partSessionId);
                if (!subagentDispatchId && !rejectedSessions.has(partSessionId)) {
                  const parentId = await fetchOpenCodeSessionParent(baseUrl, request.cwd, partSessionId);
                  const dispatch = parentId && parentId === sessionId ? pendingTaskParts.shift() : undefined;
                  if (dispatch) {
                    childSessions.set(partSessionId, dispatch);
                    subagentDispatchId = dispatch;
                  } else {
                    rejectedSessions.add(partSessionId);
                  }
                }
                // Unknown or unrelated session: drop, exactly as before.
                if (!subagentDispatchId) break;
              }
              const events = parseOpenCodePart(
                part,
                raw,
                typeof properties.delta === "string" ? properties.delta : undefined
              );
              yield* (subagentDispatchId ? withOpenCodeSubagentDispatch(events, subagentDispatchId) : events);
              break;
            }
            case "question.asked":
              if (eventSessionId && eventSessionId !== sessionId) break;
              await handleOpenCodeQuestion(baseUrl, request, properties);
              break;
            case "permission.asked":
              if (eventSessionId && eventSessionId !== sessionId) break;
              await handleOpenCodePermission(baseUrl, request, properties);
              break;
            case "session.status": {
              // Only the main session drives the run lifecycle; a child
              // sub-agent session going idle must not end the turn.
              if (eventSessionId && eventSessionId !== sessionId) break;
              const status = asRecord(properties.status);
              if (String(status.type ?? properties.status ?? "") !== "idle") break;
              finished = true;
              yield { kind: "status", phase: "turn_completed", raw };
              await handle.cancel();
              yield { kind: "exit", exitCode: 0 };
              return;
            }
            case "session.error": {
              if (eventSessionId && eventSessionId !== sessionId) break;
              const error = asRecord(properties.error);
              const message = String(asRecord(error.data).message ?? error.message ?? "OpenCode session failed");
              finished = true;
              yield { kind: "status", phase: "turn_failed", raw };
              yield { kind: "error", error: new Error(message) };
              await handle.cancel();
              return;
            }
            default:
              break;
          }
        }
      } catch (error) {
        yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
        if (!finished) await handle?.cancel().catch(() => undefined);
      }
    };

    const deferred = deferredProcess(() => handle);
    return {
      process: deferred,
      events: { [Symbol.asyncIterator]: events },
      cancel: async () => {
        if (baseUrl && sessionId) {
          await apiJson(baseUrl, request.cwd, `/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }).catch(() => undefined);
        }
        await handle?.cancel();
      },
      write: (input) => handle?.write(input)
    };
  }
}

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null ? value as RecordValue : {};

function deferredProcess(current: () => PluginProcessHandle | undefined): ProcessHandle {
  return {
    get pid() { return current()?.pid; },
    get child() {
      const handle = current();
      if (!handle) throw new Error("OpenCode server process has not started yet");
      return handle.child;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        const handle = current();
        if (handle) yield* handle.events;
      }
    },
    write: (input) => current()?.write(input),
    cancel: async () => { await current()?.cancel(); },
    wait: () => current()?.wait() ?? Promise.resolve({ exitCode: null })
  };
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function directoryUrl(baseUrl: string, cwd: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.searchParams.set("directory", cwd);
  return url.href;
}

async function apiJson(
  baseUrl: string,
  cwd: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const response = await fetch(directoryUrl(baseUrl, cwd, path), {
    method: init.method,
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenCode server ${init.method ?? "GET"} ${path} failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : undefined;
}

async function waitForServer(baseUrl: string, cwd: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(directoryUrl(baseUrl, cwd, "/session/status"));
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error("Timed out waiting for OpenCode server");
}

async function openEventStream(baseUrl: string, cwd: string): Promise<AsyncGenerator<unknown>> {
  const response = await fetch(directoryUrl(baseUrl, cwd, "/event"), {
    headers: { accept: "text/event-stream" }
  });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status})`);
  return readSse(response.body);
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try { yield JSON.parse(data) as unknown; } catch { /* ignore keepalives and malformed frames */ }
    }
  }
}

function unwrapServerEvent(value: unknown): RecordValue {
  const event = asRecord(value);
  return asRecord(event.payload).type ? asRecord(event.payload) : event;
}

function parseOpenCodePart(part: RecordValue, raw: unknown, delta?: string): AdapterEvent[] {
  const type = String(part.type ?? "");
  if (type === "text" || type === "reasoning") {
    const kind = type === "text" ? "message" : "thinking";
    const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
    if (delta) return [{ kind, phase: "delta", messageId, text: delta, raw } as AdapterEvent];
    if (!asRecord(part.time).end) return [];
  }
  const mappedType = type === "tool" ? "tool_use" : type.replace("-", "_");
  return parseOpenCodeEvent({ type: mappedType, sessionID: part.sessionID, part, raw });
}

function openCodeModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0
    ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    : undefined;
}

/**
 * The summarize endpoint requires an explicit providerID/modelID. Prefer the
 * session's configured model; otherwise reuse the model of the session's last
 * assistant message (the model that produced the context being compacted).
 */
async function resolveSummarizeModel(
  baseUrl: string,
  cwd: string,
  sessionId: string,
  model: string | undefined
): Promise<{ providerID: string; modelID: string }> {
  const configured = openCodeModel(model);
  if (configured) return configured;
  const messages = await apiJson(baseUrl, cwd, `/session/${encodeURIComponent(sessionId)}/message`);
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const info = asRecord(asRecord(list[index]).info);
    if (String(info.role ?? "") !== "assistant") continue;
    const providerID = typeof info.providerID === "string" ? info.providerID : undefined;
    const modelID = typeof info.modelID === "string" ? info.modelID : undefined;
    if (providerID && modelID) return { providerID, modelID };
  }
  throw new Error("OpenCode summarize needs a model; pick a session model first");
}

function optionIntent(option: InteractionOption): InteractionOption["intent"] | undefined {
  const text = `${option.id} ${option.label} ${option.description ?? ""}`;
  if (/(^|\b)(yes|approve|implement|build|proceed)(\b|$)|批准|执行|开始实现/i.test(text)) return "approve";
  if (/(^|\b)(no|revise|refine|keep planning|stay)(\b|$)|修改|继续计划/i.test(text)) return "revise";
  if (/(reject|deny|cancel|拒绝|取消)/i.test(text)) return "reject";
  return undefined;
}

function normalizeQuestion(value: unknown, index: number): InteractionQuestion {
  const question = asRecord(value);
  return {
    id: String(question.id ?? `question-${index + 1}`),
    header: typeof question.header === "string" ? question.header : undefined,
    question: String(question.question ?? ""),
    multiSelect: question.multiple === true || question.multiSelect === true || undefined,
    isOther: question.custom === true || undefined,
    options: Array.isArray(question.options)
      ? question.options.map((value, optionIndex) => {
          const option = asRecord(value);
          const label = String(option.label ?? option.value ?? `option-${optionIndex + 1}`);
          return {
            id: label,
            label,
            description: typeof option.description === "string" ? option.description : undefined
          };
        })
      : undefined
  };
}

function isOpenCodePlanQuestion(question: InteractionQuestion, properties: RecordValue): boolean {
  const tool = asRecord(properties.tool);
  const text = [
    String(tool.name ?? tool.tool ?? ""),
    question.header ?? "",
    question.question,
    ...(question.options ?? []).flatMap((option) => [option.label, option.description ?? ""])
  ].join(" ");
  return /(plan_exit|plan exit|plan|计划)/i.test(text)
    && /(build agent|implement|switch|start|执行|开始实现|切换)/i.test(text);
}

function planPathFromQuestion(question: InteractionQuestion): string | undefined {
  return question.question.match(/Plan at (.+?) is complete/i)?.[1]?.trim();
}

async function readOpenCodePlan(cwd: string, question: InteractionQuestion): Promise<InteractionPlan> {
  const path = planPathFromQuestion(question);
  if (!path) return { content: "" };
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (!/\.md(?:own)?$/i.test(absolute)) return { content: "", sourcePath: path };
  const content = await readFile(absolute, "utf8").catch(() => "");
  return { content, sourcePath: path };
}

export function classifyOpenCodeQuestion(value: unknown): {
  kind: "question" | "plan_approval";
  questions: InteractionQuestion[];
  options?: InteractionOption[];
} {
  const properties = asRecord(value);
  const questions = (Array.isArray(properties.questions) ? properties.questions : []).map(normalizeQuestion);
  const plan = questions[0] && questions.length === 1 && isOpenCodePlanQuestion(questions[0], properties);
  return {
    kind: plan ? "plan_approval" : "question",
    questions,
    options: plan
      ? (questions[0]?.options ?? []).map((option) => ({ ...option, intent: optionIntent(option) }))
      : undefined
  };
}

async function handleOpenCodeQuestion(
  baseUrl: string,
  request: AdapterStartRequest | AdapterResumeRequest,
  properties: RecordValue
): Promise<void> {
  const requestId = String(properties.id ?? properties.requestID ?? "");
  if (!requestId) return;
  if (!request.requestInteraction) {
    await apiJson(baseUrl, request.cwd, `/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
    return;
  }
  const classified = classifyOpenCodeQuestion(properties);
  try {
    if (classified.kind === "plan_approval") {
      const question = classified.questions[0]!;
      const response = await request.requestInteraction({
        kind: "plan_approval",
        title: "计划已就绪",
        plan: await readOpenCodePlan(request.cwd, question),
        options: classified.options
      });
      const selected = classified.options?.find((option) => option.id === response.optionId);
      if (response.outcome === "selected" && selected) {
        await apiJson(baseUrl, request.cwd, `/question/${encodeURIComponent(requestId)}/reply`, {
          method: "POST",
          body: { answers: [[selected.label]] }
        });
      } else {
        await apiJson(baseUrl, request.cwd, `/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
      }
      return;
    }
    const response = await request.requestInteraction({
      kind: "question",
      title: "OpenCode question",
      questions: classified.questions
    });
    if (response.outcome !== "selected") {
      await apiJson(baseUrl, request.cwd, `/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
      return;
    }
    await apiJson(baseUrl, request.cwd, `/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: { answers: classified.questions.map((question) => response.answers?.[question.id] ?? []) }
    });
  } catch {
    await apiJson(baseUrl, request.cwd, `/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }).catch(() => undefined);
  }
}

async function handleOpenCodePermission(
  baseUrl: string,
  request: AdapterStartRequest | AdapterResumeRequest,
  properties: RecordValue
): Promise<void> {
  const requestId = String(properties.id ?? properties.requestID ?? "");
  if (!requestId) return;
  let reply = "reject";
  if (request.requestInteraction) {
    const response = await request.requestInteraction({
      kind: "approval",
      title: String(properties.permission ?? "OpenCode permission"),
      detail: [
        ...(Array.isArray(properties.patterns) ? properties.patterns.map(String) : []),
        properties.metadata ? JSON.stringify(properties.metadata, null, 2) : ""
      ].filter(Boolean).join("\n"),
      options: [
        { id: "once", label: "Allow once" },
        { id: "always", label: "Always allow" },
        { id: "reject", label: "Reject" }
      ]
    }).catch(() => ({ outcome: "cancelled" as const }));
    if (response.outcome === "selected" && response.optionId) reply = response.optionId;
  }
  await apiJson(baseUrl, request.cwd, `/permission/${encodeURIComponent(requestId)}/reply`, {
    method: "POST",
    body: { reply }
  });
}

/**
 * Parses one `opencode run --format json` event. Payloads nest under `part`;
 * every event also carries the top-level sessionID (surfaced so the host can
 * offer native resume). Verified against opencode 1.18.7.
 * (Named-exported for host-side tests; the host only uses the default factory.)
 */
export function parseOpenCodeEvent(value: unknown): AdapterEvent[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const part = (record.part && typeof record.part === "object" ? record.part : {}) as Record<string, unknown>;
  const events: AdapterEvent[] = [];
  if (typeof record.sessionID === "string" && record.sessionID) {
    events.push({ kind: "session", providerSessionId: record.sessionID, raw: value });
  }
  const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
  switch (String(record.type ?? "")) {
    case "text":
      // opencode emits each text part once, complete — not as streaming
      // deltas — so every part maps to a completed message.
      if (typeof part.text === "string" && part.text) {
        events.push({ kind: "message", phase: "completed", messageId, text: part.text, raw: value });
      }
      break;
    case "reasoning":
      if (typeof part.text === "string" && part.text) {
        events.push({ kind: "thinking", phase: "completed", messageId, text: part.text, raw: value });
      }
      break;
    case "tool_use": {
      const state = (part.state && typeof part.state === "object" ? part.state : {}) as Record<string, unknown>;
      const status = String(state.status ?? "");
      events.push({
        kind: "tool",
        callId: typeof part.callID === "string" ? part.callID : undefined,
        name: String(part.tool ?? "tool"),
        phase: status === "completed" || status === "error" ? "completed" : "started",
        input: state.input,
        output: state.output ?? state.error,
        success: status === "completed" ? true : status === "error" ? false : undefined,
        raw: value
      });
      break;
    }
    case "step_finish": {
      const tokens = (part.tokens && typeof part.tokens === "object" ? part.tokens : undefined) as Record<string, unknown> | undefined;
      if (tokens) {
        const cache = (tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {}) as Record<string, unknown>;
        const input = numberOrUndefined(tokens.input);
        const cacheRead = numberOrUndefined(cache.read);
        const cacheWrite = numberOrUndefined(cache.write);
        // Prompt-side footprint of the latest request, mirroring the Claude
        // adapter: uncached input + cache reads/writes. Output tokens are
        // already history inside that prompt, so they are not added again.
        const contextUsed = input !== undefined || cacheRead !== undefined || cacheWrite !== undefined
          ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
          : undefined;
        events.push({
          kind: "usage",
          inputTokens: input,
          outputTokens: numberOrUndefined(tokens.output),
          reasoningOutputTokens: numberOrUndefined(tokens.reasoning),
          cachedInputTokens: cacheRead,
          contextUsed,
          raw: value
        });
      }
      break;
    }
    case "error": {
      const error = (record.error && typeof record.error === "object" ? record.error : {}) as Record<string, unknown>;
      const data = (error.data && typeof error.data === "object" ? error.data : {}) as Record<string, unknown>;
      const message = typeof data.message === "string" && data.message.trim()
        ? data.message
        : String(error.name ?? "opencode run failed");
      events.push({ kind: "status", phase: "turn_failed", raw: value }, { kind: "error", error: new Error(message) });
      break;
    }
    default:
      // step_start and friends carry no user-facing payload.
      break;
  }
  return events;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Returns the parent session id for a (possibly child) opencode session, if any. */
async function fetchOpenCodeSessionParent(baseUrl: string, cwd: string, childSessionId: string): Promise<string | undefined> {
  const info = await apiJson(baseUrl, cwd, `/session/${encodeURIComponent(childSessionId)}`).catch(() => undefined);
  const parentId = asRecord(info).parentID;
  return typeof parentId === "string" && parentId ? parentId : undefined;
}

/** Tags activity from a task-tool child session with the dispatching call id. */
function withOpenCodeSubagentDispatch(events: AdapterEvent[], subagentDispatchId: string): AdapterEvent[] {
  return events.map((event) => {
    switch (event.kind) {
      case "message":
      case "thinking":
      case "tool":
      case "command":
        return { ...event, subagentDispatchId };
      default:
        return event;
    }
  });
}

/** Splits the process output into JSONL lines and normalizes each line. */
async function* streamEvents(process: ProcessHandle): AsyncGenerator<AdapterEvent> {
  yield { kind: "commands", commands: NATIVE_COMMANDS };
  const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  for await (const event of process.events) {
    if (event.kind === "stdout" || event.kind === "stderr") {
      pending[event.kind] += event.text;
      const lines = pending[event.kind].split(/\r?\n/);
      pending[event.kind] = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = parseOpenCodeEvent(JSON.parse(line) as unknown);
          yield* (parsed.length ? parsed : [{ kind: "raw", stream: event.kind, text: line }]);
        } catch {
          yield { kind: "raw", stream: event.kind, text: line };
        }
      }
    } else if (event.kind === "exit" || event.kind === "timeout" || event.kind === "error") {
      yield event;
    }
  }
  for (const stream of ["stdout", "stderr"] as const) {
    if (pending[stream].trim()) yield { kind: "raw", stream, text: pending[stream] };
  }
}

/**
 * CLI args for one `opencode run`. Custom baseArgs take over the whole CLI
 * surface (model/variant flags only apply to the default path).
 * (Named-exported for host-side tests; the host only uses the default factory.)
 */
export function startArgs(instance: AgentInstance, request: AdapterStartRequest): string[] {
  if (instance.baseArgs.length) return [...instance.baseArgs, request.prompt];
  return [
    "run", "--format", "json",
    ...(request.model ? ["--model", request.model] : []),
    // OpenCode's reasoning effort is a model "variant" (run --variant).
    ...(request.reasoningEffort ? ["--variant", request.reasoningEffort] : []),
    request.prompt
  ];
}

/**
 * Parses `opencode models --verbose`: one `provider/model` id line per model,
 * each followed by a pretty-printed JSON block carrying name/status/limits.
 * The id line is the exact value accepted by `opencode run --model`.
 * (Named-exported for host-side tests; the host only uses the default factory.)
 */
export function parseOpenCodeModels(text: string): ProviderModelCatalog {
  const models: ProviderModel[] = [];
  let jsonLines: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (jsonLines) {
      jsonLines.push(line);
      // Only a brace at column 0 closes the model's block — nested objects
      // (cost/cache/limit) end with indented braces.
      if (line === "}") {
        enrichLastModel(models.at(-1), jsonLines.join("\n"));
        jsonLines = undefined;
      }
      continue;
    }
    const trimmed = line.trim();
    if (line === "{") {
      jsonLines = [line];
    } else if (/^[\w.-]+\/[\w.:-]+$/.test(trimmed)) {
      models.push({ id: trimmed, displayName: trimmed, isDefault: false, capabilities: [], reasoningEfforts: [], serviceTiers: [] });
    }
  }
  return { providerId: "opencode", models, source: "provider_cli", fetchedAt: new Date().toISOString() };
}

/** Fills display name / context window / reasoning efforts from the verbose JSON block. */
function enrichLastModel(model: ProviderModel | undefined, json: string): void {
  if (!model) return;
  try {
    const meta = JSON.parse(json) as {
      name?: unknown;
      status?: unknown;
      limit?: { context?: unknown };
      variants?: unknown;
    };
    if (typeof meta.name === "string" && meta.name.trim()) model.displayName = meta.name;
    const context = meta.limit?.context;
    if (typeof context === "number" && Number.isFinite(context)) model.contextWindow = context;
    if (typeof meta.status === "string" && meta.status !== "active") model.description = `status: ${meta.status}`;
    // Reasoning efforts are the model's variant keys (run --variant <key>).
    if (meta.variants && typeof meta.variants === "object") {
      model.reasoningEfforts = Object.keys(meta.variants as Record<string, unknown>);
    }
  } catch { /* keep the plain id entry */ }
}

/** Runs a short-lived command (detect probes) and captures its output. */
function capture(command: string, args: string[], env?: Record<string, string | undefined>): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const resolved = resolveSpawnCommand(command, args, env);
    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim ?? false,
      env: env ? { ...process.env, ...env } as Record<string, string> : undefined
    });
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ text, exitCode: null });
    }, 8_000);
    child.stdout.on("data", (chunk) => { text += String(chunk); });
    child.stderr.on("data", (chunk) => { text += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ text, exitCode });
    });
  });
}

/** SIGTERM does not kill a Windows process tree; taskkill /T does. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (platform() === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * Windows cannot spawn npm-style CLI shims (`opencode.cmd`) directly:
 * CreateProcess needs the real file, and .cmd/.bat must run through cmd.exe.
 * On win32 this resolves the command against PATH/PATHEXT and wraps script
 * shims in `cmd.exe /d /s /c`; elsewhere the invocation is unchanged.
 * (Kept in sync with the daemon's win-command.ts — plugins are self-contained.)
 */
function resolveSpawnCommand(command: string, args: string[], env?: Record<string, string | undefined>): { command: string; args: string[]; verbatim?: boolean } {
  if (platform() !== "win32") return { command, args };
  const merged = { ...process.env, ...env };
  const envValue = (key: string): string | undefined => {
    for (const [name, value] of Object.entries(merged)) {
      if (name.toLowerCase() === key.toLowerCase()) return value as string | undefined;
    }
    return undefined;
  };
  const hasDirectory = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
  // Try executable extensions first: an extensionless file next to a .cmd
  // shim (npm's git-bash wrapper) exists but cannot be spawned on win32.
  const extensions = hasDirectory ? [""] : [...(envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""];
  const directories = hasDirectory ? [""] : (envValue("PATH") ?? "").split(delimiter).filter(Boolean);
  let resolved: string | undefined;
  for (const dir of directories) {
    for (const extension of extensions) {
      const candidate = dir ? join(dir, command + extension) : command + extension;
      try {
        if (statSync(candidate).isFile()) { resolved = candidate; break; }
      } catch { /* keep searching */ }
    }
    if (resolved) break;
  }
  if (!resolved) return { command, args };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
  const quote = (value: string): string => (value.length && !/[\s"&|<>^()%!]/.test(value) ? value : `"${value.replaceAll('"', '""')}"`);
  // cmd /s /c strips exactly one outer quote pair before running the line,
  // so the whole line is wrapped once; inside, the shim path and unsafe args
  // carry their own quotes. Callers must spawn with
  // windowsVerbatimArguments — Node's default escaping injects backslashes
  // that cmd does not understand.
  const line = `"${[quote(resolved), ...args.map(quote)].join(" ")}"`;
  return { command: "cmd.exe", args: ["/d", "/s", "/c", line], verbatim: true };
}

interface HandleLimits {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes: number;
}

/** ProcessHandle over a spawned child, with overall/idle/output limits. */
class PluginProcessHandle implements ProcessHandle {
  readonly events: AsyncIterable<ProcessEvent>;
  private readonly queue: ProcessEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProcessEvent>) => void> = [];
  private closed = false;
  private outputBytes = 0;
  private readonly exitPromise: Promise<{ exitCode: number | null; signal?: string }>;
  private overallTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;

  constructor(readonly child: ChildProcessWithoutNullStreams, limits: HandleLimits) {
    this.events = { [Symbol.asyncIterator]: () => this.iterate() };
    const onOutput = (kind: "stdout" | "stderr", chunk: unknown): void => {
      const text = String(chunk);
      this.outputBytes += text.length;
      if (this.outputBytes > limits.maxOutputBytes) {
        this.timeout("max_output");
        return;
      }
      this.push({ kind, text });
      this.resetIdleTimer(limits.idleTimeoutMs);
    };
    child.stdout.on("data", (chunk) => onOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk));
    child.on("error", (error) => this.push({ kind: "error", error }));
    this.exitPromise = new Promise((resolve) => {
      child.on("close", (exitCode, signal) => {
        this.push({ kind: "exit", exitCode, signal: signal ?? undefined });
        this.finish();
        resolve({ exitCode, signal: signal ?? undefined });
      });
    });
    if (limits.timeoutMs) {
      this.overallTimer = setTimeout(() => this.timeout("timeout"), limits.timeoutMs);
    }
    this.resetIdleTimer(limits.idleTimeoutMs);
  }

  get pid(): number | undefined { return this.child.pid; }
  write(input: string): void { this.child.stdin.write(input); }
  wait(): Promise<{ exitCode: number | null; signal?: string }> { return this.exitPromise; }

  async cancel(): Promise<void> {
    killTree(this.child);
    await this.exitPromise.catch(() => undefined);
  }

  private timeout(reason: "timeout" | "idle" | "max_output"): void {
    if (this.closed) return;
    this.push({ kind: "timeout", reason });
    killTree(this.child);
  }

  private resetIdleTimer(idleTimeoutMs?: number): void {
    if (!idleTimeoutMs || this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.timeout("idle"), idleTimeoutMs);
  }

  private push(event: ProcessEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  private finish(): void {
    this.closed = true;
    if (this.overallTimer) clearTimeout(this.overallTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  private async *iterate(): AsyncGenerator<ProcessEvent> {
    for (;;) {
      const event = this.queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<ProcessEvent>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

const factory: ProviderPluginFactory = () => new OpenCodePluginAdapter();
export default factory;
