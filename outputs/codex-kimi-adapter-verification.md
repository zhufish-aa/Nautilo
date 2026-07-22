# Codex 与 Kimi Code Adapter 查询及验证记录

> 日期：2026-07-21  
> 范围：只验证 Codex CLI 与 Kimi Code CLI；Claude Code/OpenCode 不在本次完成范围内。

## 1. 本机环境

| Provider | 可执行文件 | 版本 | 结果 |
|---|---|---:|---|
| Codex | npm 全局 shim + `@openai/codex/bin/codex.js` | 0.128.0 | 可启动、可输出 JSONL、可 Resume |
| Kimi Code | `C:\Users\admin\.kimi-code\bin\kimi.exe` | 0.27.0 | 可启动、可输出 stream-json、可 Resume |

## 2. 官方命令矩阵

| 能力 | Codex | Kimi Code |
|---|---|---|
| 非交互执行 | `codex exec <prompt>` | `kimi --prompt <prompt>` |
| 结构化流 | `codex exec --json <prompt>` | `kimi --prompt <prompt> --output-format stream-json` |
| 模型 | `--model <model>` | `--model <model>` |
| 工作目录 | 进程 cwd 或 `--cd <dir>` | 进程 cwd；`--add-dir` 可添加目录 |
| Resume | `codex exec resume <session-id> <prompt>` | `kimi --session <session-id> --prompt <prompt>` |
| 最近会话 | `codex exec resume --last <prompt>` | `kimi --continue` |
| 取消 | 终止当前进程树 | 非交互模式终止进程树；ACP 模式支持 `session/cancel` |
| 输出 Schema | `--output-schema <file>` | 非交互命令未提供同等参数 |

## 3. 实际事件

Codex 0.128.0 的真实成功流：

```text
thread.started → turn.started → item.completed(agent_message) → turn.completed(usage) → exit
```

Kimi Code 0.27.0 的真实成功流：

```text
assistant(content/tool_calls) → tool（可选）→ meta/session.resume_hint → exit
```

Adapter 会把 Provider 事件归一为 `session`、`message`、`thinking`、`tool`、`command`、`file`、`usage`、`status`、`error` 和 `exit`，并把 Provider Session ID 保存回 AgentHub Session。

## 4. 实现拆分

```text
packages/core-daemon/src/adapters/
├── codex/
│   ├── adapter.ts
│   ├── commands.ts
│   ├── events.ts
│   └── executable.ts
└── kimi/
    ├── adapter.ts
    ├── commands.ts
    └── events.ts
```

- `commands.ts` 只负责构建官方 CLI 参数。
- `events.ts` 只负责解析 Provider JSONL。
- `adapter.ts` 只负责把命令、事件与 Process Runtime 组合起来。
- Codex 的 `executable.ts` 只负责 Windows npm shim 到 Node 入口的安全解析。
- 通用 Process Runtime 继续负责 stdout/stderr、超时、输出上限和进程树取消。

## 5. 实际发现并修复的问题

1. Windows PATH 中 `codex.ps1` 优先于 `codex.cmd`，无 Shell `spawn("codex")` 会返回 `EPERM`。现已解析 npm 安装目录并直接调用 `@openai/codex/bin/codex.js`，不启用 Shell。
2. Codex 会继续读取管道 stdin；不关闭 stdin 会等待 EOF。非交互 Adapter 现会在启动后立即关闭 stdin。
3. 本机 Codex 配置包含旧 CLI 不支持的 `model_reasoning_effort = "max"`，并缓存了当前 ChatGPT 账号不支持的模型。Smoke Test 使用 `--ignore-user-config` 和显式可用模型完成，产品侧会把这类 stderr/Provider 错误保留给诊断界面。
4. 原通用 JSON 启发式解析无法可靠识别 Provider Session ID 和用量。现已改成 Codex/Kimi 专属解析器，通用解析只作为未知事件兼容回退。

## 6. 验证结果

```text
Core Daemon 单元/契约测试：18/18 通过（另有 2 个真实 Provider Smoke 默认跳过）
真实 Provider Smoke Test：2/2 通过
Codex Start：通过
Codex Resume：通过
Kimi Start：通过
Kimi Resume：通过
```

Kimi ACP 已确认官方支持 `initialize`、`session/new`、`session/load`、`session/resume`、`session/prompt` 和 `session/cancel`，但本轮 Core Daemon 采用“一次提示启动一个非交互进程、后续通过原生 Resume 续跑”的架构，尚未实现长驻 ACP Client，不能标记为完成。

## 7. 官方来源

- [OpenAI Codex CLI 命令参考](https://developers.openai.com/codex/cli/reference/)
- [OpenAI Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Kimi Code CLI 命令参考](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [Kimi Code ACP 参考](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Kimi Code Session 指南](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions)
