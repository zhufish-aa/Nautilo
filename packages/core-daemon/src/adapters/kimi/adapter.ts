import type { AgentInstance } from "@agenthub/domain";
import { ProcessAdapter } from "../process-adapter.js";
import type { AdapterDiscoveryContext, AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest, ProviderDescriptor } from "../types.js";
import { buildKimiResumeArgs, buildKimiStartArgs } from "./commands.js";
import { parseKimiJsonEvent } from "./events.js";
import { discoverKimiModels } from "./models.js";
import { startKimiAcp } from "./acp-run.js";

export class KimiCodeAdapter extends ProcessAdapter {
  readonly providerId = "kimi-code";
  readonly descriptor: ProviderDescriptor = {
    providerId: "kimi-code",
    name: "Kimi Code",
    vendor: "Moonshot AI",
    capabilities: ["headless_structured", "pty_interactive"],
    defaultExecutable: "kimi",
    credentialEnv: ["KIMI_API_KEY"],
    contextWindowDiscovery: true,
    permissionModes: [
      {
        value: "default",
        name: { "zh-CN": "逐个询问", "en-US": "Ask every time" },
        description: {
          "zh-CN": "每次工具调用都向你确认（default）",
          "en-US": "Confirms every tool call with you (default)"
        }
      },
      {
        value: "yolo",
        name: { "zh-CN": "完全自主", "en-US": "Fully autonomous" },
        description: {
          "zh-CN": "自动批准一切，不再询问（yolo）",
          "en-US": "Auto-approve everything without asking (yolo)"
        }
      },
      {
        value: "auto",
        name: { "zh-CN": "自动批准安全操作", "en-US": "Auto-approve safe ops" },
        description: {
          "zh-CN": "安全操作自动通过，其余仍会询问（auto）",
          "en-US": "Safe operations are auto-approved; the rest still ask (auto)"
        }
      }
    ]
  };
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;

  protected validateHelp(help: string): string | undefined {
    return help.includes("stream-json") && help.includes("--session") ? undefined : "Installed Kimi Code CLI does not expose stream-json and session resume support";
  }
  protected commandArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
    return buildKimiStartArgs(instance, prompt, request);
  }
  protected resumeArgs(instance: AgentInstance, sessionId: string, prompt: string, request?: AdapterResumeRequest): string[] {
    return buildKimiResumeArgs(instance, sessionId, prompt, request);
  }
  protected runtimeEnvironment(_instance: AgentInstance, env: Record<string, string | undefined> | undefined, request?: AdapterStartRequest): Record<string, string | undefined> | undefined {
    if (!request?.reasoningEffort) return env;
    return { ...env, KIMI_MODEL_THINKING_EFFORT: request.reasoningEffort };
  }
  protected parseStructuredEvent(value: unknown, _stream: "stdout" | "stderr"): AdapterEvent[] {
    return parseKimiJsonEvent(value);
  }
  override start(request: AdapterStartRequest): AdapterRun {
    return request.instance.baseArgs.length ? super.start(request) : startKimiAcp(request, false);
  }
  override resume(request: AdapterResumeRequest): AdapterRun {
    return request.instance.baseArgs.length ? super.resume(request) : startKimiAcp(request, true);
  }
  listModels(instance: AgentInstance, context?: AdapterDiscoveryContext) {
    return discoverKimiModels({
      capture: (command, args, env) => this.capture(command, args, env),
      invocation: (configured, args) => this.invocation(configured, args)
    }, instance, context?.env);
  }
}
