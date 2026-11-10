import { randomUUID } from "node:crypto";
import type { AgentInstance, RuntimeConnection, Session } from "@agenthub/domain";
import type { AssistantLookup } from "@agenthub/schemas";
import { activityOf, type AssistantReceipt, type AssistantTurn } from "../../shared/workspace-assistant";
import type { CoreRequest } from "./context";

export async function liveSessions(core: CoreRequest, filter: AssistantLookup) {
  const [page, pending] = await Promise.all([
    core("assistant.sessions", filter),
    core("interaction.list", { sessionId: filter.sessionId, status: "pending" }),
  ]);
  for (const item of page.items) {
    const request = pending.find((r) => r.sessionId === item.id);
    if (request) item.status = request.kind === "approval" ? "waiting_approval" : "waiting_input";
  }
  return page;
}
function usable(agent: AgentInstance) {
  return (
    agent.enabled &&
    agent.providerOptions?.configurationKind === "harness" &&
    !agent.baseArgs.length &&
    !agent.profile?.trim()
  );
}
function compatible(agent: AgentInstance, c: RuntimeConnection) {
  return (
    c.enabled &&
    (c.kind === "login"
      ? c.harness === agent.providerId
      : c.hasCredential !== false && c.models?.some((m) => m.enabled !== false))
  );
}
export async function workspace(core: CoreRequest) {
  const [projects, agents, connections] = await Promise.all([
    core("project.list", undefined),
    core("agent.list", {}),
    core("connection.list", {}),
  ]);
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    harnesses: agents
      .filter(usable)
      .map((a) => ({
        id: a.id,
        name: a.displayName,
        connections: connections.filter((c) => compatible(a, c)).map((c) => c.id),
      })),
    connections: connections
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        name: c.name,
        models: c.models?.filter((m) => m.enabled !== false).map((m) => m.id),
      })),
  };
}
function arg(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Error("Invalid " + field);
  return value.trim();
}
export async function deliver(
  core: CoreRequest,
  turn: AssistantTurn,
  method: string,
  args: Record<string, unknown>,
  task: string,
  save: () => Promise<void>,
  guard: () => void,
  changed: (sessionId: string) => void,
) {
  let target: Session;
  let projectName: string;
  const creating = method === "create_session";
  let busy = false;
  if (creating) {
    const projectId = arg(args.projectId, "project"),
      instance = arg(args.harnessId, "harness"),
      connectionId = arg(args.connectionId, "connection");
    const title = arg(args.title, "title", 120);
    const catalog = await workspace(core);
    const project = catalog.projects.find((p) => p.id === projectId);
    const harness = catalog.harnesses.find((a) => a.id === instance);
    const connection = catalog.connections.find((c) => c.id === connectionId);
    if (!project || !harness?.connections.includes(connectionId) || !connection)
      throw Error("项目、Harness 或兼容连接已不可用，请重新读取工作区。");
    const model = typeof args.model === "string" ? args.model : connection.models?.[0];
    if (model && connection.models?.length && !connection.models.includes(model))
      throw Error("所选执行模型未启用。");
    // Reserve the target and delivery identity in the journal before either external action.
    const now = new Date().toISOString();
    target = {
      id: "sess_" + randomUUID(),
      projectId,
      memberId: instance,
      agentInstanceId: instance,
      connectionId,
      model,
      title,
      status: "idle",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    projectName = project.name;
  } else {
    const sessionId = arg(args.sessionId, "sessionId");
    const entry = (await liveSessions(core, { sessionId })).items[0];
    if (!entry || entry.status === "archived") throw Error("目标会话不存在或已归档。");
    const matches = await core("session.list", { projectId: entry.projectId });
    const session = matches.find((item) => item.id === sessionId);
    if (!session) throw Error("目标会话已移除。");
    target = session;
    projectName = entry.project;
    busy =
      ["running", "waiting_approval", "waiting_input"].includes(activityOf(entry)) &&
      !["completed", "failed", "timed_out", "crashed", "cancelled"].includes(entry.runStatus ?? "");
  }
  const previous = turn.receipts.find(
    (r) =>
      r.task === task && (r.sessionId === target.id || (creating && r.created && r.project === projectName)),
  );
  if (previous) return previous;
  guard();
  const receipt: AssistantReceipt = {
    sessionId: target.id,
    title: target.title,
    project: projectName,
    task,
    created: creating,
    delivery: "pending",
    messageId: "msg_" + randomUUID(),
  };
  turn.receipts.push(receipt);
  await save();
  try {
    guard();
    if (creating) await core("session.upsert", target);
    guard();
    if (busy) {
      await core("session.followUp", {
        sessionId: target.id,
        text: task,
        messageId: receipt.messageId,
        mode: "queue",
      });
      receipt.delivery = "queued";
    } else {
      const teamRoot = target.teamId && !target.parentSessionId;
      const runs = teamRoot ? await core("projectRun.list", { projectId: target.projectId }) : [];
      const active = runs.find((r) => !["completed", "failed", "cancelled"].includes(r.status));
      guard();
      if (teamRoot && (!target.projectRunId || active?.id !== target.projectRunId)) {
        const result = await core("orchestration.start", {
          projectId: target.projectId,
          teamId: target.teamId!,
          agentInstanceId: target.agentInstanceId,
          sessionId: target.id,
          messageId: receipt.messageId,
          goal: task,
        });
        receipt.projectRunId = result.projectRun.id;
      } else {
        const result = await core("session.send", {
          sessionId: target.id,
          text: task,
          messageId: receipt.messageId,
        });
        receipt.runId = result.runId;
      }
      receipt.delivery = "sent";
    }
  } catch (error) {
    receipt.delivery = "failed";
    receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 900);
  }
  await save();
  changed(target.id);
  return receipt;
}
