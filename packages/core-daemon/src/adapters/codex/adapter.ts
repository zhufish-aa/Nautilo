import type { AgentInstance } from "@agenthub/domain";
import { ProcessAdapter, type AdapterInvocation } from "../process-adapter.js";
import type { AdapterDiscoveryContext, AdapterEvent, AdapterStartRequest } from "../types.js";
import { buildCodexResumeArgs, buildCodexStartArgs } from "./commands.js";
import { parseCodexJsonEvent } from "./events.js";
import { resolveCodexInvocation } from "./executable.js";
import { discoverCodexModels } from "./models.js";
import type { AdapterResumeRequest, AdapterRun } from "../types.js";
import { startCodexAppServer } from "./app-server-run.js";

export class CodexAdapter extends ProcessAdapter {
  readonly providerId = "codex";
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;

  protected helpArgs(): string[] { return ["exec", "--help"]; }
  protected validateHelp(help: string): string | undefined {
    return help.includes("--json") && help.includes("resume") ? undefined : "Installed Codex CLI does not expose exec JSONL and resume support";
  }
  protected invocation(instance: AgentInstance, args: string[]): AdapterInvocation {
    return resolveCodexInvocation(instance.executable, args);
  }
  protected commandArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
    return buildCodexStartArgs(instance, prompt, request);
  }
  protected resumeArgs(instance: AgentInstance, sessionId: string, prompt: string, request?: AdapterResumeRequest): string[] {
    return buildCodexResumeArgs(instance, sessionId, prompt, request);
  }
  protected parseStructuredEvent(value: unknown, _stream: "stdout" | "stderr"): AdapterEvent[] {
    return parseCodexJsonEvent(value);
  }
  override start(request: AdapterStartRequest): AdapterRun {
    return request.instance.baseArgs.length ? super.start(request) : startCodexAppServer(request, false);
  }
  override resume(request: AdapterResumeRequest): AdapterRun {
    return request.instance.baseArgs.length ? super.resume(request) : startCodexAppServer(request, true);
  }
  listModels(instance: AgentInstance, context?: AdapterDiscoveryContext) { return discoverCodexModels(instance, context); }
}
