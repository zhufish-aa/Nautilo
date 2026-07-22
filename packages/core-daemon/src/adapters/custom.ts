import type { AgentInstance } from "@agenthub/domain";
import { ProcessAdapter, streamEvents } from "./process-adapter.js";
import type { AdapterRun, AdapterStartRequest } from "./types.js";
export class CustomCliAdapter extends ProcessAdapter {
  readonly providerId = "custom";
  readonly supportsStructuredOutput = false;
  readonly supportsResume = false;
  override get capabilities() { return { structuredOutput: false, textOutput: true, interactiveStdin: true, nativeResume: false, pty: false }; }
  protected commandArgs(instance: AgentInstance, prompt: string): string[] {
    const args = instance.baseArgs.map((arg) => arg.replaceAll("{prompt}", prompt));
    return args.some((arg) => arg.includes(prompt)) || instance.providerOptions?.inputMode === "stdin" ? args : [...args, prompt];
  }
  override start(request: AdapterStartRequest): AdapterRun {
    const options = request.instance.providerOptions ?? {};
    const process = this.runtime.start({
      command: request.instance.executable,
      args: this.commandArgs(request.instance, request.prompt),
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs ?? numberOption(options.timeoutMs),
      idleTimeoutMs: request.idleTimeoutMs ?? numberOption(options.idleTimeoutMs),
      maxOutputBytes: request.maxOutputBytes ?? numberOption(options.maxOutputBytes) ?? 20 * 1024 * 1024
    });
    if (options.inputMode === "stdin") { process.child.stdin.end(`${request.prompt}\n`); }
    const structured = options.outputMode === "jsonl";
    return { process, events: streamEvents(process, structured), cancel: process.cancel, write: process.write };
  }
}

function numberOption(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
