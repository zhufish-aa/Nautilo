import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";
import type { ProcessHandle } from "../../process-runtime.js";
import { ProcessAdapter, streamEvents } from "../process-adapter.js";
import { normalizeJson } from "../normalize.js";
import { startRuntimeMcpBridge, type RuntimeMcpBridge } from "../runtime-mcp-bridge.js";
import type { AdapterDiscoveryContext, AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest, ProviderDescriptor } from "../types.js";
import { buildClaudeResumeArgs, buildClaudeStartArgs, claudePermissionPromptToolArgs, claudeRuntimeMcpArgs } from "./commands.js";
import { createClaudeParseState, parseClaudeJsonEvent } from "./events.js";
import { discoverClaudeModels } from "./models.js";
import { buildClaudePermissionPromptHandler } from "./permission-prompt.js";

export class ClaudeCodeAdapter extends ProcessAdapter {
  readonly providerId = "claude-code";
  readonly descriptor: ProviderDescriptor = {
    providerId: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    capabilities: ["headless_structured", "long_running_stdin", "pty_interactive"],
    defaultExecutable: "claude",
    credentialEnv: ["ANTHROPIC_API_KEY"],
    envPassthrough: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    contextWindowDiscovery: true,
    permissionModes: [
      {
        value: "default",
        name: { "zh-CN": "默认", "en-US": "Default" },
        description: {
          "zh-CN": "由 CLI 按自身规则决定何时询问",
          "en-US": "The CLI decides when to ask, per its own rules"
        }
      },
      {
        value: "acceptEdits",
        name: { "zh-CN": "自动接受编辑", "en-US": "Auto-accept edits" },
        description: {
          "zh-CN": "文件编辑自动通过，其余操作仍按默认规则",
          "en-US": "File edits pass automatically; everything else follows default rules"
        }
      },
      {
        value: "plan",
        name: { "zh-CN": "计划模式", "en-US": "Plan mode" },
        description: {
          "zh-CN": "只读探索，先产出计划再动手",
          "en-US": "Read-only exploration; produce a plan first"
        }
      },
      {
        value: "bypassPermissions",
        name: { "zh-CN": "跳过全部权限", "en-US": "Bypass all permissions" },
        description: {
          "zh-CN": "不做任何权限询问，请谨慎使用",
          "en-US": "No permission prompts at all — use with care"
        }
      }
    ]
  };
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;
  /** Fallback parse state for the custom baseArgs path (tool_use ids are globally unique). */
  private readonly fallbackState = createClaudeParseState();

  protected validateHelp(help: string): string | undefined {
    return help.includes("stream-json") && help.includes("--resume") && help.includes("--include-partial-messages")
      ? undefined
      : "Installed Claude Code CLI does not expose stream-json output, partial messages, and session resume support";
  }

  protected commandArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
    return buildClaudeStartArgs(instance, prompt, request);
  }

  protected resumeArgs(instance: AgentInstance, sessionId: string, prompt: string, request?: AdapterResumeRequest): string[] {
    return buildClaudeResumeArgs(instance, sessionId, prompt, request);
  }

  protected parseStructuredEvent(value: unknown): AdapterEvent[] {
    // Custom baseArgs may point at a Claude-compatible wrapper emitting generic
    // JSONL; fall back to the shared normalizer when nothing claude-native matches.
    const parsed = parseClaudeJsonEvent(value, this.fallbackState);
    return parsed.length ? parsed : normalizeJson(value);
  }

  override start(request: AdapterStartRequest): AdapterRun {
    // Custom baseArgs take over the whole CLI surface, so MCP config cannot be injected.
    return request.instance.baseArgs.length ? super.start(request) : this.launch(request, false);
  }

  override resume(request: AdapterResumeRequest): AdapterRun {
    return request.instance.baseArgs.length ? super.resume(request) : this.launch(request, true);
  }

  listModels(_instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog> {
    return discoverClaudeModels(context?.env);
  }

  /**
   * Default headless path. The MCP bridge URL is only known once the loopback
   * server is listening, but --mcp-config is a CLI flag — so the process is
   * spawned lazily inside the event stream and `process` is a deferred facade.
   */
  private launch(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
    const instance = request.instance;
    const state = createClaudeParseState();
    let handle: ProcessHandle | undefined;
    let bridge: RuntimeMcpBridge | undefined;

    const events = async function* (this: ClaudeCodeAdapter): AsyncGenerator<AdapterEvent> {
      try {
        let args = resume
          ? buildClaudeResumeArgs(instance, (request as AdapterResumeRequest).providerSessionId, request.prompt, request as AdapterResumeRequest)
          : buildClaudeStartArgs(instance, request.prompt, request);
        if (request.runtimeTools?.length || request.requestInteraction) {
          bridge = await startRuntimeMcpBridge(
            "claude-code",
            request.runtimeTools ?? [],
            request.executeRuntimeTool,
            request.requestInteraction ? buildClaudePermissionPromptHandler(request.requestInteraction) : undefined
          );
        }
        const mcpArgs = claudeRuntimeMcpArgs(bridge?.url, request.mcpServers);
        const injectedArgs = [...mcpArgs, ...claudePermissionPromptToolArgs(request, bridge)];
        if (injectedArgs.length) {
          // Keep the prompt in the final position after injecting MCP flags.
          args = [...args.slice(0, -1), ...injectedArgs, args.at(-1)!];
        }
        handle = this.runtime.start({
          command: instance.executable,
          args,
          cwd: request.cwd,
          // The CLI gates output_config.effort behind a hardcoded model-name
          // allowlist (only the *-4-6 families in 2.1.x), so an explicit user
          // effort is silently dropped for other models (e.g. claude-opus-5 on
          // relays). Opt out via the CLI's override; a user-set value still wins.
          env: request.reasoningEffort
            ? { CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1", ...request.env }
            : request.env,
          timeoutMs: request.timeoutMs,
          idleTimeoutMs: request.idleTimeoutMs,
          maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
        });
        handle.child.stdin.end();
        yield* streamEvents(handle, true, (value) => parseClaudeJsonEvent(value, state));
      } catch (error) {
        yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
      } finally {
        await bridge?.close().catch(() => undefined);
      }
    }.call(this);

    const deferred: ProcessHandle = {
      get pid() { return handle?.pid; },
      get child() {
        if (!handle) throw new Error("Claude Code process has not started yet");
        return handle.child;
      },
      events: {
        async *[Symbol.asyncIterator]() {
          if (handle) yield* handle.events;
        }
      },
      write: (input: string) => handle?.write(input),
      cancel: async () => {
        await handle?.cancel();
        await bridge?.close().catch(() => undefined);
      },
      wait: () => (handle ? handle.wait() : Promise.resolve({ exitCode: null }))
    };

    return {
      process: deferred,
      events: { [Symbol.asyncIterator]: () => events },
      cancel: () => deferred.cancel(),
      write: (input: string) => deferred.write(input)
    };
  }
}
