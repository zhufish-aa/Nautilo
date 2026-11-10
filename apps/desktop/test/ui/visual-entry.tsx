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
import type { TimelinePayload, UiSession, UiProject, AgentInstanceConfig, UiTeam } from "../../src/renderer/src/lib/types";
import type { ProviderCapability } from "@agenthub/domain";
import "./visual.css";

const now = "2026-11-03T02:00:00Z";
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "home";
const section = params.get("section") ?? "appearance";
useSettingsStore.setState({ onboardingCompleted: true, locale: "zh-CN", theme: params.get("theme") === "dark" ? "dark" : "light", reduceMotion: true, collapsedProjects: ["website"], hiddenNav: [] });
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
useSessionsStore.setState({ sessions, activeSessionId: scenario === "conversation" || scenario === "approval" ? "export" : undefined,
  events: { export: conversation.map((data, index) => ({ id: `example-${index}`, sessionId: "export", sequence: index + 1, timestamp: now, data })) },
  contextUsage: { export: { contextUsed: 28000, contextWindow: 100000 } }
});
const routes: Record<string, string> = { home: "/sessions?new=1", conversation: "/sessions?session=export", approval: "/sessions?session=export", projects: "/projects", team: "/teams/sample-team", settings: `/settings?section=${encodeURIComponent(section)}`, skills: "/settings?section=skills", search: "/sessions?new=1" };
if (!location.hash) location.hash = routes[scenario] ?? routes.home;
createRoot(document.getElementById("root")!).render(<HashRouter><I18nProvider><App /></I18nProvider></HashRouter>);
const marker = document.createElement("div");
marker.textContent = "界面测试 · 示例数据 · 未连接CLI";
marker.setAttribute("role", "note");
marker.style.cssText = "position:fixed;top:7px;left:50%;transform:translateX(-50%);z-index:9999;font:11px system-ui;color:#666;background:#f6f6f6;border:1px solid #ddd;border-radius:5px;padding:3px 9px;pointer-events:none";
document.body.append(marker);
if (scenario === "search") setTimeout(() => document.querySelector<HTMLButtonElement>('button[title="搜索 · Ctrl/⌘ K"]')?.click(), 500);
