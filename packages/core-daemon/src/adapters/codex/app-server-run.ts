import type { AgentInstance } from "@agenthub/domain";
import { ProcessRuntime, type ProcessEvent } from "../../process-runtime.js";
import { JsonRpcProcessClient } from "../json-rpc-process.js";
import type { AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";
import { parseCodexAppServerNotification } from "./app-server-events.js";
import { resolveCodexInvocation } from "./executable.js";
import { buildCodexProviderConfigArgs } from "./provider-config.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};

export const CODEX_APP_SERVER_INITIALIZE_PARAMS = {
  clientInfo: { name: "AgentHub", version: "0.1.0" },
  capabilities: { experimentalApi: true }
} as const;

function transportEvent(event: ProcessEvent): AdapterEvent | undefined {
  if (event.kind === "stdout") return { kind: "raw", stream: "stdout", text: event.text };
  if (event.kind === "stderr") return { kind: "raw", stream: "stderr", text: event.text };
  return event;
}

function threadOptions(request: AdapterStartRequest | AdapterResumeRequest): RecordValue {
  return {
    cwd: request.cwd,
    model: request.model || undefined,
    serviceTier: request.serviceTier || undefined,
    approvalPolicy: "never",
    sandbox: "workspace-write"
  };
}

export function buildCodexTurnInput(prompt: string, localImagePaths: string[] = []): RecordValue[] {
  return [
    { type: "text", text: prompt },
    ...localImagePaths.map((path) => ({ type: "localImage", path, detail: "auto" }))
  ];
}

export function buildCodexAppServerArgs(
  instance: AgentInstance,
  environment: Record<string, string | undefined> | undefined
): string[] {
  const profileArgs = instance.profile ? ["--profile", instance.profile] : [];
  return [...profileArgs, "app-server", "--stdio", ...buildCodexProviderConfigArgs(instance, environment)];
}

export function startCodexAppServer(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
  const runtime = new ProcessRuntime();
  const invocation = resolveCodexInvocation(
    request.instance.executable,
    buildCodexAppServerArgs(request.instance, request.env)
  );
  const process = runtime.start({
    command: invocation.command,
    args: invocation.args,
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    idleTimeoutMs: request.idleTimeoutMs,
    maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
  });
  const rpc = new JsonRpcProcessClient(process);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let finished = false;

  async function* events(): AsyncGenerator<AdapterEvent> {
    try {
      await rpc.request("initialize", CODEX_APP_SERVER_INITIALIZE_PARAMS);
      rpc.notify("initialized", {});
      const threadResponse = record(await rpc.request(resume ? "thread/resume" : "thread/start", resume
        ? { threadId: (request as AdapterResumeRequest).providerSessionId, ...threadOptions(request) }
        : threadOptions(request)));
      const thread = record(threadResponse.thread);
      threadId = String(thread.id ?? (resume ? (request as AdapterResumeRequest).providerSessionId : ""));
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      yield { kind: "session", providerSessionId: threadId };
      const turnResponse = record(await rpc.request("turn/start", {
        threadId,
        input: buildCodexTurnInput(request.prompt, request.localImagePaths),
        cwd: request.cwd,
        model: request.model || undefined,
        serviceTier: request.serviceTier || undefined,
        effort: request.reasoningEffort || undefined,
        summary: "auto"
      }));
      turnId = String(record(turnResponse.turn).id ?? "");

      for await (const event of rpc) {
        if (event.kind === "notification") {
          yield* parseCodexAppServerNotification(event.method, event.params);
          if (event.method === "turn/completed") {
            finished = true;
            await process.cancel();
            yield { kind: "exit", exitCode: 0 };
            return;
          }
        } else if (event.kind === "request") {
          rpc.respondError(event.id, -32601, `AgentHub does not support app-server request ${event.method}`);
        } else if (event.kind === "transport") {
          const mapped = transportEvent(event.event);
          if (mapped && !(finished && mapped.kind === "exit")) yield mapped;
        }
      }
    } catch (error) {
      yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
      if (!finished) await process.cancel().catch(() => undefined);
    }
  }

  return {
    process,
    events: { [Symbol.asyncIterator]: events },
    write: process.write,
    cancel: async () => {
      if (threadId && turnId) rpc.notify("turn/interrupt", { threadId, turnId });
      await process.cancel();
    }
  };
}
