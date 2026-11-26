import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WorkflowsPage } from "../../src/renderer/src/features/workflows/WorkflowsPage";
import { SessionWorkbench } from "../../src/renderer/src/features/sessions/SessionWorkbench";
import { I18nProvider } from "../../src/renderer/src/lib/i18n";
import { useSessionsStore } from "../../src/renderer/src/stores/sessions";
import { useAgentsStore } from "../../src/renderer/src/stores/agents";
import { useSettingsStore } from "../../src/renderer/src/stores/settings";
import { useProjectsStore } from "../../src/renderer/src/stores/projects";
import { useTeamsStore } from "../../src/renderer/src/stores/teams";
import { advanceRunSnapshot, calls } from "./workflow-visual-bridge";
import "./workflow-visual.css";
import "../../src/renderer/src/styles/management.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "light";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
useSettingsStore.setState({ theme: params.get("theme") === "dark" ? "dark" : "light", reduceMotion: params.has("reduceMotion") });
useSessionsStore.setState({ sessions: [{ id: "qa-main", projectId: "qa-project", target: { type: "agent", instanceId: "qa-agent" }, title: "调查首轮延迟", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), unreadCount: 0 }], activeSessionId: "qa-main" });
const clock = new Date().toISOString();
useAgentsStore.setState({ instances: [
  { id:"qa-agent", providerId:"codex", displayName:"Codex", configurationKind:"harness", executable:"fixture", baseArgs:[], enabled:true, envPolicyId:"default", status:"available", createdAt:clock, updatedAt:clock },
  { id:"qa-alternate", providerId:"claude-code", displayName:"Claude Code", configurationKind:"harness", executable:"fixture", baseArgs:[], enabled:true, envPolicyId:"default", status:"available", createdAt:clock, updatedAt:clock }
] });
useTeamsStore.setState({ teams: [{ id:"qa-team", name:"调查团队", delegationPolicy:"ask_before_delegate", createdAt:clock, updatedAt:clock,
  members:[{ id:"qa-explorer", displayName:"探索者", agentInstanceId:"qa-agent", role:{id:"explorer",name:"Explorer",strengths:{}}, enabled:true, allowedTaskTypes:[] }]
}] });
useProjectsStore.setState({ projects: [{ id: "qa-project", name: "Nautilo", rootPath: "/fixture/nautilo", repositoryType: "git", workspaceMode: "git_isolated", addedAt: new Date().toISOString(), scanning: false, verificationTemplates: [
  { id: "required-check", name: "项目必需检查", command: "node", args: ["required.mjs"], timeoutMs: 10_000, required: true, scopes: ["task"] },
  { id: "optional-check", name: "界面检查", command: "node", args: ["visual.mjs"], timeoutMs: 10_000, required: false, scopes: ["task"] },
] }] });
(window as unknown as { workflowQa: unknown }).workflowQa = { calls, advanceRunSnapshot };
createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><I18nProvider><div className={params.has("conversation") ? undefined : "workflows-route-surface"} style={{ maxWidth: 1720, margin: "0 auto", padding: "32px 40px", height: "100dvh", overflow: "auto" }}>
  {params.has("conversation") ? <SessionWorkbench sessionId="qa-main" drawer={null} onOpenDrawer={() => {}} onCloseDrawer={() => {}} onOpenSession={() => {}}/> : <WorkflowsPage inspection={params.has("inspection") ? { runId: params.get("inspection")!, onOpenSession: () => {} } : undefined}/>}
</div></I18nProvider></BrowserRouter></React.StrictMode>);
