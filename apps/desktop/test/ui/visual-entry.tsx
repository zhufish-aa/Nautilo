/** Explicit sample data, isolated from all production entries and real accounts. */
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "../../src/renderer/src/App";
import { I18nProvider } from "../../src/renderer/src/lib/i18n";
import { useSessionsStore } from "../../src/renderer/src/stores/sessions";
import { useProjectsStore } from "../../src/renderer/src/stores/projects";
import { useAgentsStore } from "../../src/renderer/src/stores/agents";
import { useTeamsStore } from "../../src/renderer/src/stores/teams";
import { useSettingsStore } from "../../src/renderer/src/stores/settings";
import { useProviderToolsStore } from "../../src/renderer/src/stores/provider-tools";
import type { TimelineEvent, TimelinePayload, UiSession, UiProject, AgentInstanceConfig, UiTeam } from "../../src/renderer/src/lib/types";
import type { ProviderCapability } from "@agenthub/domain";
import "./visual.css";

const now = "2026-11-03T02:00:00Z";
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "home";
const section = params.get("section") ?? "appearance";
const traceScenario = scenario === "conversation-trace";
useSettingsStore.setState({ onboardingCompleted: true, locale: "zh-CN", theme: params.get("theme") === "dark" ? "dark" : "light", reduceMotion: !traceScenario || params.has("reduceMotion"), collapsedProjects: ["website"], hiddenNav: [] });
localStorage.setItem("nautilo.sidebar.collapsed", String(params.get("collapsed") === "1"));
useProjectsStore.setState({ projects: [
  { id: "nautilo", name: "Nautilo", rootPath: "/sample/nautilo", repositoryType: "git", workspaceMode: "direct", scanning: false, verificationTemplates: [], addedAt: now },
  { id: "website", name: "官网改版", rootPath: "/sample/website", repositoryType: "git", workspaceMode: "direct", scanning: false, verificationTemplates: [], addedAt: now }
] satisfies UiProject[] });
useAgentsStore.setState({ instances: [
  { id: "sample-codex", displayName: "Codex", providerId: "codex", executable: "example-cli-not-installed", baseArgs: [], envPolicyId: "default", enabled: true, status: "available", permissionMode: "default", createdAt: now, updatedAt: now },
  { id: "sample-reviewer", displayName: "检查助手", providerId: "claude", executable: "example-cli-not-installed", baseArgs: [], envPolicyId: "default", enabled: true, status: "available", createdAt: now, updatedAt: now }
] satisfies AgentInstanceConfig[] });
useTeamsStore.setState({ teams: [{ id: "sample-team", name: "开发协作", delegationPolicy: "ask_before_delegate", members: [
  { id: "main", displayName: "主助手", agentInstanceId: "sample-codex", role: { id: "main", name: "协调", description: "示例", responsibilities: [], strengths: {}, limitations: [], systemInstructions: "示例", permissionPolicyId: "default" }, allowedTaskTypes: ["code", "plan"], maxConcurrentTasks: 1, enabled: true },
  { id: "reviewer", displayName: "检查助手", agentInstanceId: "sample-reviewer", role: { id: "reviewer", name: "检查", description: "示例", responsibilities: [], strengths: {}, limitations: [], systemInstructions: "示例", permissionPolicyId: "default" }, allowedTaskTypes: ["review", "test"], maxConcurrentTasks: 1, enabled: true }
], createdAt: now, updatedAt: now }] satisfies UiTeam[] });
useProviderToolsStore.setState({ tools: [
  { id: "sample-skill", name: "代码审查", description: "检查代码变更和回归风险。", kind: "skill", enabled: true, tags: ["review"], providerIds: ["codex"], skill: { instructions: "这是一条界面示例，不执行工具。" }, createdAt: now, updatedAt: now },
  { id: "sample-mcp", name: "项目文档", description: "MCP JSON 导入示例。", kind: "mcp", enabled: false, tags: [], providerIds: ["codex"], mcp: { transport: "stdio", command: "sample-mcp-not-installed", args: [] }, createdAt: now, updatedAt: now }
] satisfies ProviderCapability[], loaded: true, loading: false, error: null });
const sessions = [
  { id: "export", title: "修复导出按钮", projectId: "nautilo", mode: "code", target: { type: "agent", instanceId: "sample-codex", teamId: "sample-team" }, status: "idle", unreadCount: 0, createdAt: now, updatedAt: now },
  { id: "docs", title: "整理需求文档", projectId: "nautilo", mode: "work", target: { type: "agent", instanceId: "sample-codex" }, status: "idle", unreadCount: 0, createdAt: now, updatedAt: now },
  { id: "website-task", title: "导出方案", projectId: "website", target: { type: "agent", instanceId: "sample-codex" }, status: "idle", unreadCount: 0, createdAt: now, updatedAt: now },
  { id: "idea", title: "临时想法", projectId: "removed-sample", target: { type: "agent", instanceId: "sample-codex" }, status: "idle", unreadCount: 0, createdAt: now, updatedAt: now }
] satisfies UiSession[];
const conversation: TimelinePayload[] = [
  { kind: "message", sender: "user", text: "为导出按钮增加加载反馈。" },
  { kind: "message", sender: "agent", text: "我先检查导出入口。" },
  { kind: "tool_activity", toolName: "read_file", status: "done", input: "src/ExportButton.tsx", output: "示例文件内容，仅用于界面检查。" },
  { kind: "message", sender: "agent", text: "将保留现有导出行为，并补充加载反馈。\n\n- 导出期间显示加载状态\n- 保持键盘访问" },
  { kind: "tool_activity", toolName: "apply_patch", status: "done", input: "src/ExportButton.tsx", output: "界面示例，未修改真实文件。" }
];
if (scenario === "approval") conversation.push({ kind: "approval", approval: { id: "example-approval", title: "运行命令", description: "npm test -- ExportButton\n工作目录 /sample/nautilo\n界面示例，不会执行命令。", kind: "command", status: "pending", createdAt: now } });

function exampleTrace(): TimelineEvent[] {
  const rows: TimelineEvent[] = [];
  const append = (id: string, seconds: number, data: TimelinePayload, runId?: string): void => {
    rows.push({ id, sessionId: "export", sequence: rows.length + 1, timestamp: new Date(Date.parse(now) + seconds * 1000).toISOString(), data, runId });
  };
  if (params.has("manyTurns")) for (let index = 0; index < 36; index++) {
    const seconds = (index - 36) * 4;
    append(`history-request-${index}`, seconds, { kind: "message", sender: "user", text: `继续第 ${index + 1} 个检查。` });
    append(`history-check-${index}`, seconds + 1, { kind: "reasoning", text: "核对当前结果。" });
    append(`history-answer-${index}`, seconds + 2, { kind: "message", sender: "agent", text: "已完成这项检查。" });
  }
  const trace = "trace-run";
  append("trace-request", 0, { kind: "message", sender: "user", text: "检查导出按钮的加载状态，并跑一遍回归。" });
  append("trace-start", 0, { kind: "activity", phase: "starting" }, trace);
  append("trace-thought", 2, { kind: "reasoning", text: "核对导出入口和按钮状态，确认提交期间只触发一次请求。" }, trace);
  append("trace-command", 4, { kind: "command", status: "done", exitCode: 0,
    command: "pwsh -NoProfile -Command \"Get-Content -LiteralPath 'apps/desktop/src/renderer/src/features/export/ExportButton.tsx'\"",
    output: Array.from({ length: 96 }, (_, index) => `${index + 1}  ${index % 2 ? "按钮状态已核对" : "等待导出操作完成"}`).join("\n") }, trace);
  append("trace-review", 5, { kind: "reasoning", text: "检查加载中、执行完成和失败重试三个状态。" }, trace);
  append("trace-git", 7, { kind: "command", status: "done", exitCode: 0, command: "git diff --check -- apps/desktop/src/renderer/src/features/export", output: "检查通过。" }, trace);
  if (params.has("longHistory")) for (let index = 0; index < 86; index++) {
    append(`trace-more-${index}`, 7.01 + index / 100, { kind: "reasoning", text: `核对第 ${index + 1} 条记录。` }, trace);
  }
  append("trace-update", 9, { kind: "message", sender: "agent", text: "导出入口已经接上加载状态。现在核对键盘访问和重复点击。" }, trace);
  const directory = "apps/desktop/src/renderer/src/features/export/";
  const files = [
    { path: directory + "ExportButton.tsx", additions: 6, deletions: 3 },
    { path: directory + "ExportOptions.tsx", additions: 7, deletions: 16 },
    { path: directory + "components/toolbar/keyboard/ExportShortcut.tsx", additions: 7, deletions: 7 },
    { path: "apps\\desktop\\test\\export-button.test.mjs", additions: 93, deletions: 15 },
  ].map(file => ({ ...file, changeType: "modified" as const,
    diff: `--- a/${file.path}\n+++ b/${file.path}\n@@ -1 +1 @@\n-export const busy = false;\n+export const busy = pending;` }));
  append("trace-diff", 12, { kind: "file_change", source: "provider", files }, trace);
  append("trace-last-check", 14, { kind: "reasoning", text: "核对通过，可以交付。" }, trace);
  append("trace-result", 20, { kind: "message", sender: "agent", text: "已完成导出按钮的加载反馈。导出期间会显示进度，并保留键盘操作。\n\n四个文件已更新，回归检查通过。" }, trace);
  append("trace-complete", 20, { kind: "activity", phase: "completed" }, trace);
  append("trace-emoji", 24, { kind: "message", sender: "user", text: "🥺" });
  if (params.has("running")) {
    append("trace-live-thought", 25, { kind: "reasoning", text: "正在核对测试输出。", streaming: true }, "trace-live");
    append("trace-live-command", 26, { kind: "command", command: "pwsh -NoProfile -Command \"pnpm test -- export\"", status: "running", output: "正在运行回归测试……" }, "trace-live");
  }
  append("trace-confirm", 27, { kind: "message", sender: "agent", text: "可以直接在桌面端点开导出菜单验证。", streaming: params.has("running") }, "trace-live");
  return rows;
}

useSessionsStore.setState({ sessions, activeSessionId: scenario === "conversation" || scenario === "approval" || traceScenario ? "export" : undefined,
  events: { export: traceScenario ? exampleTrace() : conversation.map((data, index) => ({ id: `example-${index}`, sessionId: "export", sequence: index + 1, timestamp: now, data })) },
  contextUsage: { export: { contextUsed: 28000, contextWindow: 100000 } }
});
const routes: Record<string, string> = { home: "/sessions?new=1", conversation: "/sessions?session=export", "conversation-trace": "/sessions?session=export", approval: "/sessions?session=export", projects: "/projects", team: "/teams/sample-team", settings: `/settings?section=${encodeURIComponent(section)}`, skills: "/settings?section=skills", search: "/sessions?new=1" };
if (!location.hash) location.hash = routes[scenario] ?? routes.home;
createRoot(document.getElementById("root")!).render(<HashRouter><I18nProvider><App /></I18nProvider></HashRouter>);
const marker = document.createElement("div");
marker.textContent = "界面测试 · 示例数据 · 未连接CLI";
marker.setAttribute("role", "note");
marker.style.cssText = "position:fixed;top:7px;left:50%;transform:translateX(-50%);z-index:9999;font:11px system-ui;color:#666;background:#f6f6f6;border:1px solid #ddd;border-radius:5px;padding:3px 9px;pointer-events:none";
document.body.append(marker);
if (scenario === "search") setTimeout(() => document.querySelector<HTMLButtonElement>('button[title="搜索 · Ctrl/⌘ K"]')?.click(), 500);
