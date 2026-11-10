import type { AgentInstance } from "@agenthub/domain";
import { ProcessAdapter, streamEvents } from "./process-adapter.js";
import type { AdapterRun, AdapterStartRequest, ProviderDescriptor } from "./types.js";
export class CustomCliAdapter extends ProcessAdapter {
  readonly providerId = "custom";
  readonly descriptor: ProviderDescriptor = {
    providerId: "custom",
    name: "Custom CLI",
    vendor: "Local",
    capabilities: ["headless_text"]
  };
  readonly supportsStructuredOutput = false;
  readonly supportsResume = false;
  override get capabilities() { return { structuredOutput: false, textOutput: true, interactiveStdin: true, nativeResume: false, pty: false }; }
  protected commandArgs(instance: AgentInstance, prompt: string): string[] {
    const args = instance.baseArgs.map((arg) => arg.replaceAll("{prompt}", prompt));
    return args.some((arg) => arg.includes(prompt)) || instance.providerOptions?.inputMode === "stdin" ? args : [...args, prompt];
  }
  override start(request: AdapterStartRequest): AdapterRun {
    const options = request.instance.providerOptions ?? {};
    const context = {prompt:request.prompt,cwd:request.cwd,model:request.model,reasoningEffort:request.reasoningEffort,
      permissionMode:request.permissionMode,serviceTier:request.serviceTier,contextWindow:request.contextWindow,
      outputSchemaPath:request.outputSchemaPath,localImagePaths:request.localImagePaths};
    const env = {...request.env,NAUTILO_INPUT_JSON:JSON.stringify(context)} as Record<string,string|undefined>;
    for (const [key,name] of [['model','NAUTILO_MODEL'],['reasoningEffort','NAUTILO_REASONING_EFFORT'],['permissionMode','NAUTILO_PERMISSION_MODE'],['serviceTier','NAUTILO_SERVICE_TIER']] as const) {
      if (context[key]) env[name] = context[key];
    }
    const instance = {...request.instance,baseArgs:request.instance.baseArgs.map(arg => Object.entries(context)
      .filter(([key]) => key !== 'prompt').reduce((text,[key,value]) => text.replaceAll(`{${key}}`,value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)),arg))};
    const process = this.runtime.start({
      command: request.instance.executable,
      args: this.commandArgs(instance, request.prompt),
      cwd: request.cwd,
      env,
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
