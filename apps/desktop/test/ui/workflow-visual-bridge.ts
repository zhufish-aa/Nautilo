/** Isolated UI fixture. All workflow actions operate on memory only. */
import state, { evidence } from "virtual:workflow-fixtures";
import { requestCore as fallback } from "./visual-bridge";
import type { AgentRun, Message, Session, WorkflowPlan, WorkflowPlanAssignment, WorkflowRun, WorkflowTemplate } from "@agenthub/domain";
import type { TimelineBlock, TimelineChanges, TimelineOperation } from "@agenthub/schemas";
import type { AgentHubBridge } from "../../src/renderer/src/types/bridge";
export { isElectron } from "./visual-bridge";
const conversationBridge = {} as AgentHubBridge;
export function getBridge(): AgentHubBridge | undefined {
  return new URLSearchParams(location.search).has("conversation") ? conversationBridge : undefined;
}
const fixtures = state as Record<string, WorkflowRun>;
for (const run of Object.values(fixtures)) {
  const shift = Date.parse("2026-11-18T12:00:00Z") - run.createdAt;
  run.createdAt += shift; run.updatedAt += shift;
  for (const event of run.events) event.timestamp += shift;
  for (const instance of run.instances) { instance.createdAt += shift; instance.updatedAt += shift; if (instance.completedAt != null) instance.completedAt += shift; }
  run.assignments = Object.fromEntries(run.definition.nodes.filter(node => node.kind === "agent" && node.role && run.bindings[node.role]?.model).map(node => [
    node.id, { model: run.bindings[node.role!].model, providerId: node.role === "Analyst" ? "claude-code" : "codex" },
  ]));
  for (const message of run.messages) message.createdAt += shift;
}
const seed = fixtures.parallel!;
const template: WorkflowTemplate = { id: seed.definition.id, revision: 1, name: seed.definition.name!, definition: seed.definition, layout: seed.layout!, createdAt: "2026-11-18T12:00:00Z", updatedAt: "2026-11-18T12:00:00Z" };
const childTemplate: WorkflowTemplate = {
  ...template,
  id: "qa-child",
  name: "独立复核",
  definition: {
    schemaVersion: 1, id: "qa-child", name: "独立复核", entry: "child-main", inputs: { question: "text" },
    nodes: [
      { id: "child-main", name: "主 Agent", kind: "main", dispatch: "all", exits: [{ id: "next", name: "开始" }] },
      { id: "child-review", name: "复核", kind: "agent", role: "Verifier", prompt: "复核 {{input.question}}。", exits: [{ id: "done", name: "复核完成" }] },
    ],
    edges: [{ from: ["child-main", "next"], to: "child-review" }, { from: ["child-review", "done"], to: "$return" }],
  },
  layout: { nodes: { "child-main": { x: 30, y: 90 }, "child-review": { x: 245, y: 90 }, "$return": { x: 465, y: 90 } } },
};
const templates = new Map([[template.id, template], [childTemplate.id, childTemplate]]);
export const calls: Array<{ method: string; input: unknown }> = [];
const runSnapshots = new Map<string, WorkflowRun>();
export function advanceRunSnapshot(runId: string, snapshot: string | WorkflowRun): void {
  const run = typeof snapshot === "string" ? fixtures[snapshot] : snapshot;
  if (!run) throw new Error("Missing workflow fixture: " + snapshot);
  runSnapshots.set(runId, run);
}
const clock = "2026-11-18T12:00:00Z";
let session: Session = { id:"qa-main", projectId:"qa-project", agentInstanceId:"qa-agent", memberId:"qa-agent", teamId:"qa-team", title:"调查首轮延迟", status:"idle", createdAt:clock, updatedAt:clock, unreadCount:0 };
const messages: Message[] = [], turns: AgentRun[] = [];
const plans = new Map<string, WorkflowPlan>();
const blocks: TimelineBlock[] = [];
const timelineChanges: TimelineChanges["changes"] = [];
const journal: Array<{ schemaVersion: number; eventId: string; timestamp: string; sequence: number; sessionId: string; type: string; payload: unknown }> = [];
function appendEvent(type: string, payload: unknown) {
  const sequence = journal.length + 1;
  journal.push({ schemaVersion:1, eventId:"event-"+sequence, timestamp:new Date().toISOString(), sequence, sessionId:session.id, type, payload });
}
function publishPlan(plan: WorkflowPlan, message?: Message) {
  const operations: TimelineOperation[] = [];
  const result = { type:"workflow.plan", payload:{ plan } };
  if (message) {
    for (const [blockId, kind, content] of [[message.id, "user_prompt", { ...message }], ["plan-" + plan.id, "notice", result]] as const) {
      const block = { blockId, kind, content, seq:blocks.length + 1, runId:plan.id, sealed:true, status:plan.status, result:null };
      blocks.push(block);
      operations.push({ type:"block_created", block });
    }
  } else {
    const block = blocks.find(block => block.blockId === "plan-" + plan.id)!;
    block.status = plan.status;
    block.result = result;
    operations.push({ type:"block_updated", blockId:block.blockId, status:plan.status, result });
  }
  timelineChanges.push({ operations, turn:null });
}
export async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  calls.push({ method, input: structuredClone(input) });
  const args = input as Record<string, unknown> | undefined;
  if (method === "health.get") return { features:{ workflows:1, workflowPlans:1 } } as T;
  if (["agent.upsert","team.upsert","project.upsert"].includes(method)) return structuredClone(args) as T;
  if (method === "session.upsert") { session = { ...session, ...args }; return structuredClone(session) as T; }
  if (method === "session.get") return structuredClone({ session, messages }) as T;
  if (method === "session.timeline.open") return structuredClone({ revision:timelineChanges.length, blocks, turns:[] }) as T;
  if (method === "session.timeline.wait") {
    await new Promise(resolve => setTimeout(resolve, 75));
    return structuredClone({ reset:false, revision:timelineChanges.length, changes:timelineChanges.slice(Number(args?.revision ?? 0)) }) as T;
  }
  if (method === "session.history") return {
    session:structuredClone(session), cursor:{epoch:"qa",scope:"messages:session:"+session.id,revision:messages.length},
    reset:true, items:messages.map((value,ordinal)=>({value,order:{createdAt:value.createdAt,ordinal}}))
  } as T;
  if (method === "artifact.changes") return { cursor:{epoch:"qa",scope:"artifacts:session:"+session.id,revision:0}, reset:true, items:[] } as T;
  if (method === "session.followUp.list") return { items:[] } as T;
  if (method === "session.generateTitle") return {} as T;
  if (method === "interaction.list") return [] as T;
  if (method === "terminal.status") return { nativeActive:false } as T;
  if (method === "event.subscribe") return { subscriptionId:"qa-conversation" } as T;
  if (method === "event.replay" || method === "event.wait") {
    if (method === "event.wait") await new Promise(resolve => setTimeout(resolve, 75));
    return { events:structuredClone(journal.filter(event => event.sequence > Number(args?.afterSequence ?? 0))), lastSequence:journal.length } as T;
  }
  if (method === "run.list") return structuredClone(turns) as T;
  if (method === "provider.models" && args?.agentInstanceId === "qa-alternate") {
    return { providerId:"claude-code", source:"provider_api", fetchedAt:clock, defaultModel:"review-model", models:[
      { id:"review-model", displayName:"独立复核模型", reasoningEfforts:[], capabilities:[], serviceTiers:[] },
    ] } as T;
  }
  if (method === "session.send") {
    const ref = args?.workflowRef as { id: string; revision: number } | undefined;
    const selected = templates.get(ref?.id ?? "");
    if (!selected || selected.revision !== ref?.revision) throw new Error("Expected a pinned workflow reference");
    const id = "planning-" + (plans.size + 1), createdAt = new Date().toISOString();
    const message: Message = { id:String(args?.messageId), sessionId:session.id, sender:"user", text:String(args?.text), createdAt, workflowRef:{ id:ref.id, revision:ref.revision, name:selected.name } };
    messages.push(message);
    turns.unshift({ id, sessionId:session.id, agentInstanceId:"qa-agent", mode:"headless_structured", status:"completed", startedAt:createdAt, endedAt:createdAt });
    const plan: WorkflowPlan = {
      id, sessionId:session.id, template:{id:ref.id,revision:ref.revision,name:selected.name}, status:"pending", createdAt,
      summary:"先收集证据，再复核关键结论。",
      nodes:selected.definition.nodes.filter(node=>node.kind==="agent").map(node=>({
        key:node.id, name:node.name ?? node.id, role:node.role!, memberName:"探索者",
        task:"围绕本次任务查找证据，记录可以复核的位置。", assignment:{agentInstanceId:"qa-agent"},
      }))
    };
    plans.set(id, plan);
    publishPlan(plan, message);
    appendEvent("workflow.plan", { plan });
    return { accepted:true, runId:id } as T;
  }
  if (method === "workflow.plan.decide") {
    const plan = structuredClone(plans.get(String(args?.planId)));
    if (!plan || plan.sessionId !== args?.sessionId) throw new Error("Unknown workflow plan");
    if (args?.action === "approve") {
      const assignments = (args.assignments ?? {}) as Record<string, WorkflowPlanAssignment>;
      plan.nodes = plan.nodes.map(node => ({ ...node, assignment:assignments[node.key] ?? node.assignment }));
      plan.status = "approved"; plan.runId = "parallel";
    } else {
      plan.status = "rejected";
    }
    plans.set(plan.id, plan);
    publishPlan(plan);
    appendEvent("workflow.plan", { plan });
    if (plan.runId) appendEvent("workflow.updated", { workflowRunId:plan.runId, status:"running" });
    return structuredClone(plan) as T;
  }
  if (method === "workflow.templates") return structuredClone([...templates.values()]) as T;
  if (method === "workflow.archive") {
    const id = String(args?.id);
    if (templates.get(id)?.revision !== args?.revision) throw new Error("The template revision changed");
    templates.delete(id);
    return { archived:true } as T;
  }
  if (method === "workflow.template") return structuredClone(templates.get(String(args?.id))) as T;
  if (method === "workflow.list") return Object.entries(fixtures).map(([id, run]) => ({ ...run, id, name: run.definition.name })) as T;
  if (method === "workflow.get") {
    const id = String(args?.runId);
    return { ...structuredClone(runSnapshots.get(id) ?? fixtures[id] ?? seed), id } as T;
  }
  if (method === "workflow.validate") return { valid: true, issues: [] } as T;
  if (method === "workflow.save") {
    const id = String(args?.id);
    const saved = { ...template, ...args, revision: (templates.get(id)?.revision ?? 0) + 1 } as WorkflowTemplate;
    templates.set(id, saved);
    return structuredClone(saved) as T;
  }
  if (method === "workflow.start") return { ...structuredClone(seed), id: "parallel" } as T;
  if (method === "artifact.list") return structuredClone(evidence.artifacts.filter(artifact => !args?.projectRunId || artifact.projectRunId === args.projectRunId)) as T;
  if (method === "approval.list") return structuredClone(evidence.approvals) as T;
  if (method === "workflow.control") {
    const run = fixtures[String(args?.runId)] || seed; run.id = String(args?.runId);
    if (args?.action === "approve_merge" || args?.action === "reject_merge") { run.status = "completed"; run.workspace!.stage = args.action === "approve_merge" ? "complete" : "retained"; }
    else if (args?.action === "approve_verification" || args?.action === "reject_verification") {
      const workspace = args.instanceId ? run.instances.find(instance => instance.id === args.instanceId)!.workspace! : run.workspace!;
      workspace.stage = args.action === "approve_verification" ? "ready" : "failed";
    } else run.status = args?.action === "pause" ? "paused" : args?.action === "resume" ? "running" : "cancelled";
    return structuredClone(run) as T;
  }
  return fallback<T>(method, input);
}
