import type { AgentInstance } from "@agenthub/domain";
import { ProcessRuntime, type ProcessHandle, type ProcessRequest } from "../process-runtime.js";
import type { AdapterCapabilities, AdapterDetectionResult, AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest, AgentCliAdapter, ProviderDescriptor } from "./types.js";
import { normalizeJson } from "./normalize.js";
import { EnvironmentPolicyService } from "../runtime/security/environment-policy.js";

export type StructuredEventParser = (value: unknown, stream: "stdout" | "stderr") => AdapterEvent[];
export interface AdapterInvocation { command: string; args: string[]; }

export function appendPrompt(defaultArgs: string[], instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
  const args = [...(instance.baseArgs.length ? instance.baseArgs : defaultArgs)];
  if (!instance.baseArgs.length && request?.model) args.push("--model", request.model);
  return [...args, prompt];
}

export function streamEvents(process: ProcessHandle, structured: boolean, parse: StructuredEventParser = (value) => normalizeJson(value)): AsyncIterable<AdapterEvent> {
  async function* iterate(): AsyncGenerator<AdapterEvent> {
    const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    for await (const event of process.events) {
      if (event.kind === "stdout" || event.kind === "stderr") {
        if (!structured) { yield { kind: "raw", stream: event.kind, text: event.text }; continue; }
        pending[event.kind] += event.text;
        const lines = pending[event.kind].split(/\r?\n/);
        pending[event.kind] = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = parse(JSON.parse(line) as unknown, event.kind);
            yield* (parsed.length ? parsed : [{ kind: "raw", stream: event.kind, text: line }]);
          } catch { yield { kind: "raw", stream: event.kind, text: line }; }
        }
      } else if (event.kind === "exit" || event.kind === "timeout" || event.kind === "error") yield event;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      if (pending[stream].trim()) yield { kind: "raw", stream, text: pending[stream] };
    }
  }
  return { [Symbol.asyncIterator]: iterate };
}

export abstract class ProcessAdapter implements AgentCliAdapter {
  abstract readonly providerId: string;
  abstract readonly descriptor: ProviderDescriptor;
  abstract readonly supportsStructuredOutput: boolean;
  abstract readonly supportsResume: boolean;
  get capabilities(): AdapterCapabilities {
    return { structuredOutput: this.supportsStructuredOutput, textOutput: true, interactiveStdin: false, nativeResume: this.supportsResume, pty: false };
  }
  protected readonly runtime = new ProcessRuntime();
  private readonly environment = new EnvironmentPolicyService();
  protected abstract commandArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[];
  protected resumeArgs(_instance: AgentInstance, _providerSessionId: string, _prompt: string, _request?: AdapterResumeRequest): string[] | undefined { return undefined; }
  protected helpArgs(): string[] { return ["--help"]; }
  protected validateHelp(_help: string): string | undefined { return undefined; }
  protected parseStructuredEvent(value: unknown, _stream: "stdout" | "stderr"): AdapterEvent[] { return normalizeJson(value); }
  protected invocation(instance: AgentInstance, args: string[]): AdapterInvocation { return { command: instance.executable, args }; }
  protected runtimeEnvironment(instance: AgentInstance, env: Record<string, string | undefined> | undefined, _request?: AdapterStartRequest): Record<string, string | undefined> | undefined {
    return env;
  }
  protected closeStdinAfterStart(): boolean { return true; }

  async detect(instance: AgentInstance): Promise<AdapterDetectionResult> {
    try {
      const versionInvocation = this.invocation(instance, ["--version"]);
      const version = await this.capture(versionInvocation.command, versionInvocation.args);
      if (version.exitCode !== 0) return { installed: false, executable: instance.executable, error: version.text || `exit ${version.exitCode ?? "unknown"}` };
      const helpInvocation = this.invocation(instance, this.helpArgs());
      const help = await this.capture(helpInvocation.command, helpInvocation.args);
      const compatibilityError = help.exitCode === 0 ? this.validateHelp(help.text) : help.text || `help exited with ${help.exitCode ?? "unknown"}`;
      return {
        installed: true,
        compatible: compatibilityError === undefined,
        executable: instance.executable,
        version: version.text.trim(),
        help: help.text.slice(0, 16_384),
        error: compatibilityError
      };
    } catch (error) {
      return { installed: false, executable: instance.executable, error: error instanceof Error ? error.message : String(error) };
    }
  }

  protected async capture(command: string, args: string[], env?: Record<string, string | undefined>): Promise<{ text: string; exitCode: number | null }> {
    const handle = this.runtime.start({ command, args, env: this.environment.build(undefined, env), timeoutMs: 8_000, idleTimeoutMs: 4_000, maxOutputBytes: 512 * 1024 });
    let text = "";
    let exitCode: number | null = null;
    for await (const event of handle.events) {
      if (event.kind === "stdout" || event.kind === "stderr") text += event.text;
      else if (event.kind === "error") throw event.error;
      else if (event.kind === "exit") exitCode = event.exitCode;
    }
    return { text, exitCode };
  }

  start(request: AdapterStartRequest): AdapterRun {
    const invocation = this.invocation(request.instance, this.commandArgs(request.instance, request.prompt, request));
    const processRequest: ProcessRequest = {
      command: invocation.command,
      args: invocation.args, cwd: request.cwd,
      env: this.runtimeEnvironment(request.instance, request.env, request), timeoutMs: request.timeoutMs, idleTimeoutMs: request.idleTimeoutMs,
      maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
    };
    const process = this.runtime.start(processRequest);
    if (this.closeStdinAfterStart()) process.child.stdin.end();
    return { process, events: streamEvents(process, this.supportsStructuredOutput, (value, stream) => this.parseStructuredEvent(value, stream)), cancel: process.cancel, write: process.write };
  }

  resume(request: AdapterResumeRequest): AdapterRun {
    const args = this.resumeArgs(request.instance, request.providerSessionId, request.prompt, request);
    if (!args) throw new Error(`${this.providerId} does not support native session resume`);
    const invocation = this.invocation(request.instance, args);
    const process = this.runtime.start({ command: invocation.command, args: invocation.args, cwd: request.cwd, env: this.runtimeEnvironment(request.instance, request.env, request), timeoutMs: request.timeoutMs, idleTimeoutMs: request.idleTimeoutMs, maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024 });
    if (this.closeStdinAfterStart()) process.child.stdin.end();
    return { process, events: streamEvents(process, this.supportsStructuredOutput, (value, stream) => this.parseStructuredEvent(value, stream)), cancel: process.cancel, write: process.write };
  }
}
