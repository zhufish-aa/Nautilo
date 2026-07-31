import type { AgentInstance } from "@agenthub/domain";
import { ProcessAdapter, type AdapterInvocation } from "../process-adapter.js";
import type { AdapterDiscoveryContext, AdapterEvent, AdapterStartRequest, ProviderDescriptor } from "../types.js";
import { buildCodexResumeArgs, buildCodexStartArgs } from "./commands.js";
import { parseCodexJsonEvent } from "./events.js";
import { resolveCodexInvocation } from "./executable.js";
import { discoverCodexModels } from "./models.js";
import type { AdapterResumeRequest, AdapterRun } from "../types.js";
import { startCodexAppServer } from "./app-server-run.js";

export class CodexAdapter extends ProcessAdapter {
  readonly providerId = "codex";
  readonly descriptor: ProviderDescriptor = {
    providerId: "codex",
    name: "Codex",
    vendor: "OpenAI",
    capabilities: ["headless_structured", "long_running_stdin"],
    defaultExecutable: "codex",
    credentialEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    envPassthrough: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
    baseUrlEnv: "OPENAI_BASE_URL",
    configProfile: true,
    permissionModes: [
      {
        value: "ask",
        name: { "zh-CN": "请求批准", "en-US": "Request approval" },
        description: {
          "zh-CN": "编辑文件和执行命令前始终询问（on-request + workspace-write）",
          "en-US": "Always ask before edits and commands (on-request + workspace-write)"
        }
      },
      {
        value: "auto",
        name: { "zh-CN": "替我审批", "en-US": "Approve for me" },
        description: {
          "zh-CN": "仅对超出沙箱的风险操作请求批准（on-failure + workspace-write）",
          "en-US": "Only ask for risky operations outside the sandbox (on-failure + workspace-write)"
        }
      },
      {
        value: "full-access",
        name: { "zh-CN": "完全访问权限", "en-US": "Full access" },
        description: {
          "zh-CN": "不再询问，可访问任意文件与网络（never + danger-full-access）",
          "en-US": "Never asks; unrestricted file and network access (never + danger-full-access)"
        }
      }
    ]
  };
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
