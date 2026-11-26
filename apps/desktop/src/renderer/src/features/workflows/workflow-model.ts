import type { WorkflowDefinition, WorkflowLayout, WorkflowRun, WorkflowInstance, WorkflowEvent, WorkflowNode } from "@agenthub/domain";

export const nodeSize = (node: WorkflowNode): { width: number; height: number } =>
  node.kind === "join" || node.kind === "condition" ? { width: 44, height: 44 }
    : { width: node.kind === "agent" ? 204 : 162, height: Math.max(62, 22 + node.exits.length * 14) };
export const nodeLabel = (node: WorkflowNode): string => node.name || node.id;
export const nodeKinds = { main: "主 Agent", dispatch: "分发", agent: "Agent", join: "汇合", condition: "条件判断", call: "子流程" } as const;

export function nodeTone(node: Pick<WorkflowNode, "id" | "kind" | "role">): "indigo" | "cyan" | "violet" | "amber" | "emerald" | "neutral" {
  if (node.id === "$return" || node.id === "$return_needs_decision") return "emerald";
  if (node.kind === "main") return "indigo";
  if (node.kind === "dispatch") return "cyan";
  if (node.kind === "join") return "emerald";
  if (node.kind === "condition") return "amber";
  if (node.kind !== "agent") return "neutral";
  switch (node.role?.trim().toLowerCase()) {
    case "explorer": return "cyan";
    case "analyst": return "indigo";
    case "verifier":
    case "reviewer": return "amber";
    default: return "neutral";
  }
}
export const statusLabels: Record<string, string> = {
  ready: "等待派发", starting: "派发中", running: "执行中", waiting_submission: "待补交", completed: "已完成",
  failed: "执行失败", cancelled: "已停止", paused: "调度已暂停", needs_decision: "需要判断", waiting_join: "等待汇合", waiting_approval: "等待批准", waiting_retry: "等待重试"
  , verifying: "验收中", finalizing: "最终验收中"
};
export function workflowEventText(event: WorkflowEvent, definition: WorkflowDefinition): string {
  const label = (id?: string): string => definition.nodes.find(node => node.id === id)?.name || id || "节点";
  const data = event.data as { target?: string; branch?: string; received?: number; required?: number; nodeId?: string } | undefined;
  if (event.type === "edge.traversed") {
    const exit = definition.nodes.find(node => node.id === event.nodeId)?.exits.find(exit => exit.id === data?.branch)?.name;
    return `${label(event.nodeId)} → ${data?.target?.startsWith("$") ? "主会话" : label(data?.target)}${exit ? ` · ${exit}` : ""}`;
  }
  if (event.type === "join.progress") return `${label(data?.nodeId)} · 已收到 ${data?.received}/${data?.required} 路结果`;
  const labels: Record<string, string> = {
    "workflow.started": "流程已启动", "workflow.completed": "流程已完成", "workflow.returned": "结果已交回主会话",
    "workflow.paused": "新任务的派发已暂停", "workflow.resumed": "已恢复派发", "workflow.cancelled": "流程已停止",
    "workflow.child_started": "子流程已启动", "workflow.needs_decision": "流程需要主 Agent 接手判断",
    "node.activated": "已就绪", "node.dispatched": "开始执行", "node.submitted": "已提交命名出口与结果", "node.distributed": "已将结果分发到各出口",
    "node.completed": "已完成", "node.waiting_submission": "已结束，等待补交结果", "node.reminded": "引擎已安排补交通知",
    "node.waiting_approval": "正在等待批准", "node.approved": "已获批准", "node.cancelled": "已停止", "join.completed": "结果已汇齐，继续下一步",
    "node.native_children": "原生子 Agent 状态已更新", "node.native_children_stopped": "原生子 Agent 已停止", "node.native_children_detached": "原生后台任务已交回原会话",
    "node.waiting_verification": "等待验收", "node.verification_started": "正在验收变更", "node.verified": "验收通过", "node.verification_failed": "验收未通过", "workflow.finalizing": "正在做最终验收", "workflow.verified": "最终验收通过", "workflow.verification_failed": "最终验收未通过"
    , "workflow.workspace": "流程工作区已准备", "node.workspace": "节点工作区已准备", "node.workspace_checked": "验收记录已保存", "node.workspace_stopped": "已保留停止时的工作区",
    "node.verification_approval": "验收命令等待批准", "workflow.verification_approval": "最终验收命令等待批准", "workflow.merge_requested": "变更已验收，等待合并", "workflow.merge_recorded": "合并结果已记录", "workflow.workspace_stopped": "已保留停止时的流程工作区"
  };
  return labels[event.type] ? `${event.nodeId ? label(event.nodeId) + " · " : ""}${labels[event.type]}` : event.message;
}

export function starterWorkflow(): { definition: WorkflowDefinition; layout: WorkflowLayout } {
  const definition: WorkflowDefinition = {
      schemaVersion: 1, id: crypto.randomUUID(), name: "并行定位与交叉验证", entry: "main", inputs: { question: "text" },
      nodes: [
        { id: "main", name: "主 Agent", kind: "main", dispatch: "all", exits: [{ id: "code", name: "查代码" }, { id: "trace", name: "查时序" }] },
        { id: "code", name: "代码探索", kind: "agent", role: "Explorer", prompt: "围绕 {{input.question}} 检查静态调用链，给出文件位置与可复核证据。提交「{{exit.done}}」。", outputs: { summary: "text", evidence: "list<text>" }, exits: [{ id: "done", name: "代码证据" }] },
        { id: "trace", name: "时序探索", kind: "agent", role: "Explorer", prompt: "围绕 {{input.question}} 检查运行时序，明确已观测与未知的区间。提交「{{exit.done}}」。", outputs: { summary: "text", evidence: "list<text>" }, exits: [{ id: "done", name: "时序证据" }] },
        { id: "join", name: "汇合", kind: "join", scope: "main", wait: "all", exits: [{ id: "done", name: "证据齐备" }] },
        { id: "judge", name: "综合判断", kind: "agent", role: "Analyst", prompt: "回答 {{input.question}}。代码证据：{{steps.code.latest.result}}；时序证据：{{steps.trace.latest.result}}。结合本轮交付 {{incoming}} 交叉核对。能够相互印证时选择「{{exit.done}}」，存在分歧时说明复核问题并选择「{{exit.verify}}」。", outputs: { summary: "text", evidence: "list<text>" }, session: "reuse", exits: [{ id: "done", name: "已定位" }, { id: "verify", name: "证据冲突" }] },
        { id: "verify", name: "独立复核", kind: "agent", role: "Verifier", prompt: "根据 {{incoming.result.summary}} 独立复核有争议的证据，给出可重复检查的结果。提交「{{exit.done}}」。", outputs: { summary: "text", evidence: "list<text>" }, exits: [{ id: "done", name: "复核证据" }] }
      ],
      edges: [
        { from: ["main", "code"], to: "code" }, { from: ["main", "trace"], to: "trace" },
        { from: ["code", "done"], to: "join" }, { from: ["trace", "done"], to: "join" },
        { from: ["join", "done"], to: "judge" }, { from: ["judge", "done"], to: "$return" },
        { from: ["judge", "verify"], to: "verify" }, { from: ["verify", "done"], to: "judge", maxTraversals: 2, onLimit: "$return_needs_decision" }
      ]
  };
  return { definition, layout: initialLayout(definition) };
}
export const starterKinds = [
  { id: "parallel", label: "并行探索 + 交叉汇总" },
  { id: "review", label: "执行 + 独立复核" },
  { id: "condition", label: "条件意图分流" },
] as const;

export function applyStarter(blank: WorkflowDefinition, kind: typeof starterKinds[number]["id"]): WorkflowDefinition {
  const { definition } = starterWorkflow();
  definition.id = blank.id;
  const title = starterKinds.find(item => item.id === kind)!.label;
  for (const node of definition.nodes) if (node.kind === "agent") {
    node.outputDescriptions = {
      summary: "用一两句话写明本步发现或结论。",
      evidence: "逐条列出可核对的依据，例如文件和行号、日志片段或复现步骤。",
    };
  }
  if (kind === "parallel") {
    definition.nodes = definition.nodes.filter(node => node.id !== "verify");
    const judge = definition.nodes.find(node => node.id === "judge")!;
    judge.prompt = "用 {{steps.code.latest.result.evidence}} 和 {{steps.trace.latest.result.evidence}} 回答 {{input.question}}，提交 summary 和 evidence。";
    judge.exits = judge.exits.filter(exit => exit.id === "done");
    definition.edges = definition.edges.filter(edge => edge.to !== "verify" && edge.from[0] !== "verify");
  }
  if (kind === "review") {
    const [main, , , , judge, verify] = definition.nodes;
    main.exits = [{ id: "start", name: "开始执行" }];
    judge.name = "执行任务";
    judge.prompt = "处理 {{input.question}}，提交 summary 和 evidence。初稿交给复核，收到复核结论后决定是否交回主会话。";
    definition.nodes = [main, judge, verify];
    definition.edges = [{ from: ["main", "start"], to: judge.id }, ...definition.edges.filter(edge => [judge.id, verify.id].includes(edge.from[0]))];
  }
  if (kind === "condition") {
    const [main, code, trace] = definition.nodes;
    main.exits = [{ id: "start", name: "判断意图" }];
    definition.inputs = { question: "text", needsCode: "boolean" };
    definition.inputDefaults = { needsCode: false };
    definition.nodes = [main, {
      id: "route", name: "判断意图", kind: "condition",
      exits: [{ id: "code", name: "代码探索" }, { id: "trace", name: "检查时序" }],
      cases: [{ path: "input.needsCode", equals: true, exit: "code" }], otherwise: "trace",
    }, code, trace];
    definition.edges = [
      { from: ["main", "start"], to: "route" },
      { from: ["route", "code"], to: code.id }, { from: ["route", "trace"], to: trace.id },
      { from: [code.id, "done"], to: "$return" }, { from: [trace.id, "done"], to: "$return" },
    ];
  }
  definition.name = title;
  return definition;
}

export function initialLayout(definition: WorkflowDefinition): WorkflowLayout {
  const sizes = new Map(definition.nodes.map(node => [node.id, nodeSize(node)]));
  const exits = new Map(definition.edges.map(edge => [JSON.stringify(edge.from), edge.maxTraversals ? edge.onLimit : edge.to]));
  const outgoing = new Map<string, string[]>();
  for (const node of definition.nodes) {
    const targets = node.exits.map(port => exits.get(JSON.stringify([node.id, port.id]))).filter((id): id is string => !!id);
    for (const id of targets) if (id.startsWith("$")) sizes.set(id, nodeSize({ id, kind: "main", exits: [] }));
    outgoing.set(node.id, [...new Set(targets)]);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const order: string[] = [];
  function visit(id: string): void {
    if (visited.has(id)) return;
    visiting.add(id);
    const targets = (outgoing.get(id) ?? []).filter(target => sizes.has(target) && !visiting.has(target));
    outgoing.set(id, targets);
    targets.forEach(visit);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  [...sizes.keys()].reverse().forEach(visit);
  const levels = new Map<string, number>([[definition.entry, 0]]);
  const lanes = new Map<string, number[]>();
  const columns: { width: number; rows: { id: string; center: number; height: number }[] }[] = [];
  for (const id of order.reverse()) {
    const level = levels.get(id) ?? 0;
    const size = sizes.get(id)!;
    const column = columns[level] ??= { width: 0, rows: [] };
    const proposals = lanes.get(id) ?? [0];
    const wanted = proposals.reduce((sum, value) => sum + value, 0) / proposals.length;
    const separation = (height: number) => (height + size.height) / 2 + 70;
    const centers = [wanted, ...column.rows.flatMap(row => [row.center - separation(row.height), row.center + separation(row.height)])];
    const center = centers.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))
      .find(value => column.rows.every(row => Math.abs(row.center - value) >= separation(row.height)))!;
    column.rows.push({ id, center, height: size.height });
    column.width = Math.max(column.width, size.width);
    const targets = outgoing.get(id) ?? [];
    targets.forEach((target, index) => {
      levels.set(target, Math.max(level + 1, levels.get(target) ?? 0));
      const values = lanes.get(target) ?? [];
      values.push(center + (index - (targets.length - 1) / 2) * 156);
      lanes.set(target, values);
    });
  }
  const nodes: WorkflowLayout["nodes"] = {};
  const top = Math.min(0, ...columns.flatMap(column => column.rows.map(row => row.center - row.height / 2)));
  let x = 30;
  for (const column of columns) {
    for (const row of column.rows) nodes[row.id] = { x, y: Math.round(row.center - row.height / 2 - top + 65) };
    x += column.width + 158;
  }
  return { nodes };
}
export function eventProjection(run: WorkflowRun, sequence?: number): { instances: Map<string, WorkflowInstance>; events: WorkflowEvent[] } {
  const events = sequence === undefined ? run.events : run.events.filter(event => event.sequence <= sequence);
  if (sequence === undefined) {
    const pending = new Map<string, WorkflowInstance>();
    for (const event of events) {
      const data = event.data as { batchId?: string; nodeId?: string; received?: number; required?: number } | undefined;
      if (event.type === "join.progress" && data?.batchId && data.nodeId) pending.set(`${data.batchId}:${data.nodeId}`, { id: `join:${data.batchId}:${data.nodeId}`, nodeId: data.nodeId, status: "waiting_join", attempt: 1, iteration: 1, incoming: data, reminders: 0, createdAt: event.timestamp, updatedAt: event.timestamp });
      if (event.type === "join.completed" && data?.batchId) pending.delete(`${data.batchId}:${event.nodeId}`);
    }
    return { instances: new Map([...run.instances, ...(["running", "paused"].includes(run.status) ? pending.values() : [])].map(instance => [instance.id, instance])), events };
  }
  const instances = new Map<string, WorkflowInstance>();
  const sources = new Map(run.instances.map(instance => [instance.id, instance]));
  for (const event of events) {
    const data = (event.data || {}) as Partial<WorkflowInstance> & { batchId?: string; received?: number; required?: number };
    if (event.type === "workflow.cancelled" || event.type === "workflow.needs_decision") {
      for (const instance of instances.values()) if (["ready", "starting", "running", "waiting_submission", "waiting_approval", "waiting_retry", "waiting_join", "verifying"].includes(instance.status)) {
        instance.status = "cancelled";
        if (instance.acceptance?.status === "pending") instance.acceptance = { ...instance.acceptance, status: "cancelled", endedAt: event.timestamp };
      }
    }
    if (event.type === "join.progress" && data.batchId && data.nodeId) {
      instances.set(`join:${data.batchId}:${data.nodeId}`, { id: `join:${data.batchId}:${data.nodeId}`, nodeId: data.nodeId, status: "waiting_join", attempt: 1, iteration: 1, incoming: data, reminders: 0, createdAt: event.timestamp, updatedAt: event.timestamp });
    }
    if (event.type === "join.completed" && data.batchId) instances.delete(`join:${data.batchId}:${event.nodeId}`);
    const source = event.instanceId ? sources.get(event.instanceId) : undefined;
    if (!source) continue;
    let instance = instances.get(source.id);
    if (!instance && event.type === "node.activated") {
      instance = { id: source.id, nodeId: source.nodeId, incoming: data.incoming ?? source.incoming, item: data.item, prompt: data.prompt ?? source.prompt, taskText: data.taskText, attempt: data.attempt ?? 1, iteration: data.iteration ?? source.iteration, status: data.status ?? "ready", reminders: 0, createdAt: event.timestamp, updatedAt: event.timestamp };
      instances.set(source.id, instance);
    }
    if (!instance) continue;
    const states: Record<string, WorkflowInstance["status"]> = { "node.dispatched": "running", "node.waiting_subworkflow": "waiting_submission", "node.waiting_submission": "waiting_submission", "node.waiting_approval": "waiting_approval", "node.retry_available": "waiting_retry", "node.retrying": "ready", "node.approved": "ready", "node.completed": "completed", "node.failed": "failed", "node.cancelled": "cancelled" };
    if (states[event.type]) instance.status = states[event.type];
    if (event.type === "node.retrying") {
      instance.attempt = data.attempt ?? instance.attempt + 1;
      instance.error = undefined; instance.runId = undefined; instance.nativeWork = undefined; instance.completedAt = undefined;
      instance.branches = undefined; instance.result = undefined; instance.reminders = 0; instance.childRunId = undefined;
    }
    if (["node.waiting_verification", "node.verification_started"].includes(event.type)) instance.status = "verifying";
    if (data.acceptance) instance.acceptance = structuredClone(data.acceptance);
    if (data.workspace) instance.workspace = structuredClone(data.workspace);
    if (event.type === "node.dispatched") { instance.runId = data.runId; instance.sessionId = data.sessionId; instance.prompt = data.prompt ?? instance.prompt; }
    if (["node.completed","node.skipped","join.completed"].includes(event.type)) instance.completedAt = event.timestamp;
    if (event.type === "node.native_children") instance.nativeWork = data.nativeWork ? structuredClone(data.nativeWork) : undefined;
    if (event.type === "node.native_children_stopped" && instance.nativeWork) instance.nativeWork.released = true;
    if (event.type === "node.native_children_detached" && instance.nativeWork) instance.nativeWork.detached = true;
    if (event.type === "node.submitted" || event.type === "node.distributed") { instance.branches = data.branches ?? source.branches; instance.result = data.result ?? source.result; }
    if (event.type === "node.reminded") instance.reminders++;
    if (event.type === "node.failed" || event.type === "node.retry_available") instance.error = event.message;
    instance.updatedAt = event.timestamp;
  }
  return { instances, events };
}
