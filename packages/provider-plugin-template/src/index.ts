/**
 * Nautilo provider plugin — minimal working template.
 *
 * Wraps any agent CLI that accepts a prompt as a CLI argument and streams its
 * answer to stdout. Copy this package, rename the plugin id in
 * agenthub-plugin.json + the adapter below, and adapt the marked sections to
 * your CLI's protocol (JSONL, ACP, ...).
 *
 * The SDK is imported type-only: the compiled plugin is fully self-contained
 * and resolves nothing from the host at runtime.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AdapterDetectionResult,
  AdapterEvent,
  AdapterRun,
  AdapterStartRequest,
  AgentCliAdapter,
  ProcessEvent,
  ProcessHandle,
  ProviderDescriptor,
  ProviderPluginFactory
} from "@agenthub/provider-sdk";

// Keep in sync with agenthub-plugin.json (descriptor is duplicated there so
// the host can render the catalog entry without loading plugin code).
const descriptor: ProviderDescriptor = {
  providerId: "template-cli",
  name: "Template CLI",
  vendor: "Example",
  capabilities: ["headless_text"],
  defaultExecutable: "template-cli",
  credentialEnv: ["TEMPLATE_API_KEY"]
};

class TemplateCliAdapter implements AgentCliAdapter {
  readonly providerId = "template-cli";
  readonly descriptor = descriptor;
  readonly supportsStructuredOutput = false;
  readonly supportsResume = false;
  readonly capabilities = {
    structuredOutput: false,
    textOutput: true,
    interactiveStdin: false,
    nativeResume: false,
    pty: false
  };

  /** Detection: `<executable> --help` must launch; report its output. */
  detect(instance: { executable: string }): Promise<AdapterDetectionResult> {
    const executable = instance.executable || descriptor.defaultExecutable || "";
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, ["--help"], { windowsHide: true });
      } catch (error) {
        resolve({ installed: false, executable, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => resolve({ installed: false, executable, error: error.message }));
      child.on("close", () => resolve({ installed: true, executable, help: output.slice(0, 4000) }));
    });
  }

  /**
   * One run = one spawned CLI process. Replace the args/stdio handling here
   * with your CLI's protocol; emit AdapterEvents as the answer streams in.
   */
  start(request: AdapterStartRequest): AdapterRun {
    const args = request.instance.baseArgs.length
      ? request.instance.baseArgs.map((arg) => arg.replaceAll("{prompt}", request.prompt))
      : [request.prompt];
    const child = spawn(request.instance.executable, args, {
      cwd: request.cwd,
      env: request.env as Record<string, string>,
      windowsHide: true
    });

    const process = new PluginProcessHandle(child);
    const events = this.streamEvents(process);
    return {
      process,
      events,
      cancel: () => process.cancel(),
      write: (input) => process.write(input)
    };
  }

  private async *streamEvents(handle: PluginProcessHandle): AsyncGenerator<AdapterEvent> {
    let buffer = "";
    for await (const event of handle.events) {
      if (event.kind === "stdout") {
        buffer += event.text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        // Stream every completed line as a message delta; the host assembles
        // them into one assistant message.
        for (const line of lines) yield { kind: "message", phase: "delta", messageId: "main", text: `${line}\n` };
      } else if (event.kind === "stderr") {
        yield { kind: "raw", stream: "stderr", text: event.text };
      } else if (event.kind === "exit") {
        if (buffer.trim()) yield { kind: "message", phase: "delta", messageId: "main", text: buffer };
        // Completed with empty text = "use the buffered deltas".
        yield { kind: "message", phase: "completed", messageId: "main", text: "" };
        yield event;
      } else {
        yield event;
      }
    }
  }
}

/** Minimal ProcessHandle over a spawned child, satisfying the SDK contract. */
class PluginProcessHandle implements ProcessHandle {
  readonly events: AsyncIterable<ProcessEvent>;
  private readonly queue: ProcessEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProcessEvent>) => void> = [];
  private closed = false;
  private readonly exitPromise: Promise<{ exitCode: number | null; signal?: string }>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.events = { [Symbol.asyncIterator]: () => this.iterate() };
    child.stdout.on("data", (chunk) => this.push({ kind: "stdout", text: String(chunk) }));
    child.stderr.on("data", (chunk) => this.push({ kind: "stderr", text: String(chunk) }));
    child.on("error", (error) => this.push({ kind: "error", error }));
    this.exitPromise = new Promise((resolve) => {
      child.on("close", (exitCode, signal) => {
        this.push({ kind: "exit", exitCode, signal: signal ?? undefined });
        this.close();
        resolve({ exitCode, signal: signal ?? undefined });
      });
    });
  }

  get pid(): number | undefined { return this.child.pid; }
  write(input: string): void { this.child.stdin.write(input); }
  wait(): Promise<{ exitCode: number | null; signal?: string }> { return this.exitPromise; }

  async cancel(): Promise<void> {
    this.child.kill("SIGTERM");
    await this.exitPromise.catch(() => undefined);
  }

  private push(event: ProcessEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  private close(): void {
    this.closed = true;
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

const factory: ProviderPluginFactory = () => new TemplateCliAdapter();
export default factory;
