import type { WorkflowDefinition, WorkflowIssue, WorkflowLayout, WorkflowNode } from "@agenthub/domain";
import { edgeKey, findEdge, graphReachable, loopEdges, type Connection, type EdgeSelection } from "./workflow-geometry";
import { nodeKinds, nodeLabel } from "./workflow-model";

export const addableKinds = ["agent", "condition", "dispatch", "join", "call"] as const;
export type AddableKind = typeof addableKinds[number];
export type InspectorTab = "instructions" | "output" | "environment";

export function promptVariables(definition: WorkflowDefinition, node: WorkflowNode) {
  const upstream = graphReachable(definition.edges, node.id, true);
  const inputs = Object.keys(definition.inputs ?? {}).map(key => ({ label: key, path: "input." + key, description: undefined }));
  const outputs = definition.nodes
    .filter(source => source.id !== node.id && !source.bypass && upstream.has(source.id))
    .flatMap(source => Object.keys(source.outputs ?? {}).map(key => ({
      label: nodeLabel(source) + " · " + key, path: `steps.${source.id}.latest.result.${key}`, description: source.outputDescriptions?.[key],
    })));
  return [
    { label: "全局输入", entries: inputs },
    { label: "上游可达输出", entries: outputs },
    { label: "本节点待提交字段", entries: Object.keys(node.outputs ?? {}).map(key => ({ label: key, path: key, literal: true, description: node.outputDescriptions?.[key] })) },
  ];
}

export function unknownPromptPaths(definition: WorkflowDefinition, node: WorkflowNode): Set<string> {
  const upstream = graphReachable(definition.edges, node.id, true);
  const unknown = new Set<string>();
  for (const match of (node.prompt || "").matchAll(/\\\{\{|\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const path = match[1]?.trim();
    if (path === undefined) continue;
    const [root, key, version, result, field] = path.split(".");
    if (["input", "incoming", "item", "exit", "steps"].includes(root) && Object.hasOwn(node.fallbacks ?? {}, path) && root !== "exit") continue;
    if (["input", "steps", "exit", "incoming"].includes(path) || root === "incoming" || root === "item" && node.forEach) continue;
    if (root === "input" && Object.hasOwn(definition.inputs ?? {}, key)) continue;
    if (root === "exit" && node.exits.some(port => port.id === key)) continue;
    if (root === "steps" && key !== node.id && upstream.has(key) &&
      (!(version === "latest" && result === "result" && field) ||
        definition.nodes.some(source => source.id === key && !source.bypass && (source.kind !== "agent" || Object.hasOwn(source.outputs ?? {}, field))))) continue;
    unknown.add(path);
  }
  return unknown;
}

export function blankWorkflow(): { definition: WorkflowDefinition; layout: WorkflowLayout; revision: number } {
  return {
    definition: {
      schemaVersion: 1, id: crypto.randomUUID(), name: "未命名流程", entry: "main", inputs: { question: "text" },
      nodes: [{ id: "main", name: "主 Agent", kind: "main", dispatch: "all", exits: [] }], edges: [],
    },
    layout: { nodes: { main: { x: 100, y: 180 } } },
    revision: 0,
  };
}

export function createNode(kind: AddableKind, definition: WorkflowDefinition): WorkflowNode {
  const node: WorkflowNode = { id: kind + "-" + crypto.randomUUID().slice(0, 8), kind, name: nodeKinds[kind], exits: [{ id: "done", name: "完成" }] };
  if (kind === "agent") {
    node.role = "Explorer";
    node.prompt = definition.inputs?.question
      ? "处理 {{input.question}}，并提交结果。"
      : "处理交给你的任务，并提交结果。";
    node.outputs = { summary: "text" };
    node.outputDescriptions = { summary: "简要写明完成了什么，以及最重要的结论。" };
  }
  if (kind === "join") { node.scope = definition.entry; node.wait = "all"; }
  if (kind === "dispatch") node.dispatch = "all";
  if (kind === "condition") { node.cases = []; node.otherwise = "done"; }
  if (kind === "call") { node.input = {}; node.exitMap = {}; }
  return node;
}

export function appendOutlet(node: WorkflowNode): string | undefined {
  if (node.kind === "join" && node.exits.length) return;
  let number = node.exits.length + 1;
  let name = node.exits.length ? "出口 " + number : "下一步";
  while (node.exits.some(exit => exit.name === name)) name = "出口 " + ++number;
  const id = "exit-" + crypto.randomUUID().slice(0, 8);
  node.exits.push({ id, name });
  return id;
}

export function connectNodes(definition: WorkflowDefinition, start: Connection, target: string): EdgeSelection | undefined {
  const source = definition.nodes.find(node => node.id === start.source);
  if (!source || (!definition.nodes.some(node => node.id === target) && !["$return", "$return_needs_decision"].includes(target))) return;
  const exit = start.exit ?? appendOutlet(source);
  if (!exit || !source.exits.some(port => port.id === exit)) return;
  const selection = { source: source.id, exit, limit: start.limit };
  const edge = findEdge(definition, selection);
  if (edge) {
    if (start.limit) edge.onLimit = target;
    else edge.to = target;
  } else if (!start.limit) definition.edges.push({ from: [source.id, exit], to: target });
  else return;
  return selection;
}

export function removeLink(definition: WorkflowDefinition, selection: EdgeSelection): void {
  if (selection.limit) {
    const edge = findEdge(definition, selection);
    if (edge) { delete edge.onLimit; delete edge.maxTraversals; }
  } else definition.edges = definition.edges.filter(edge => edge.from[0] !== selection.source || edge.from[1] !== selection.exit);
}

export function canRemoveOutlet(node: WorkflowNode, exit: string): boolean {
  return node.otherwise !== exit && node.onError !== exit && node.forEach?.emptyExit !== exit
    && !node.cases?.some(rule => rule.exit === exit) && !Object.values(node.exitMap || {}).includes(exit)
    && !node.prompt?.includes("exit." + exit);
}

export function cleanLayout(definition: WorkflowDefinition, layout: WorkflowLayout): void {
  if (!layout.edgeRoutes) return;
  const keys = new Set(definition.edges.flatMap(edge => {
    const selection = { source: edge.from[0], exit: edge.from[1] };
    return [edgeKey(selection), ...(edge.onLimit ? [edgeKey({ ...selection, limit: true })] : [])];
  }));
  for (const key of Object.keys(layout.edgeRoutes)) if (!keys.has(key)) delete layout.edgeRoutes[key];
  if (!Object.keys(layout.edgeRoutes).length) delete layout.edgeRoutes;
}

export function graphIssues(definition: WorkflowDefinition, backend: WorkflowIssue[] = []): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodes = new Map(definition.nodes.map(node => [node.id, node]));
  const targets = new Set([...nodes.keys(), "$return", "$return_needs_decision"]);
  const adjacency = new Map<string, Map<string, typeof definition.edges>>();
  for (const edge of definition.edges) {
    const [source, exit] = edge.from;
    const connections = adjacency.get(source) ?? new Map<string, typeof definition.edges>();
    const branches = connections.get(exit) ?? [];
    branches.push(edge); connections.set(exit, branches); adjacency.set(source, connections);
  }
  for (const node of definition.nodes) {
    if (!node.exits.length) issues.push({ path: "exits", nodeId: node.id, message: `「${nodeLabel(node)}」还没有下一步。拖动节点旁的 + 添加连线。` });
    const labels = new Map<string, number>();
    for (const exit of node.exits) labels.set(exit.name.trim(), (labels.get(exit.name.trim()) ?? 0) + 1);
    for (const exit of node.exits) {
      const branches = adjacency.get(node.id)?.get(exit.id) ?? [];
      const name = `「${nodeLabel(node)}」的「${exit.name || "未命名出口"}」`;
      const message = !branches.length ? `${name}还没连线。把这个出口拖到下一步。`
        : branches.length > 1 ? `${name}连到了多个目标。请只保留一个。`
        : !targets.has(branches[0].to) || (branches[0].onLimit && !targets.has(branches[0].onLimit)) ? `${name}的目标已不存在。请重新连接。`
        : undefined;
      if (message) issues.push({ path: "destination", nodeId: node.id, exitId: exit.id, message });
      else if (!exit.name.trim()) issues.push({ path: "exit.name", nodeId: node.id, exitId: exit.id, message: `请给「${nodeLabel(node)}」的这个出口起一个名字。` });
      else if ((labels.get(exit.name.trim()) ?? 0) > 1) issues.push({ path: "exit.name", nodeId: node.id, exitId: exit.id, message: `${name}重名了。请给它一个不同的名称。` });
    }
  }
  const reached = new Set<string>();
  const pending = [definition.entry];
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const edges of adjacency.get(id)?.values() ?? []) for (const edge of edges) {
      pending.push(edge.to);
      if (edge.onLimit) pending.push(edge.onLimit);
    }
  }
  for (const node of definition.nodes) if (!reached.has(node.id)) {
    issues.push({ path: "incoming", nodeId: node.id, message: `「${nodeLabel(node)}」还没有接入流程。从前一步拖线连接到它。` });
  }
  for (const node of definition.nodes) {
    if (node.kind === "agent" && !node.bypass) for (const binding of unknownPromptPaths(definition, node)) {
      issues.push({ path: "prompt", nodeId: node.id, message: `「${nodeLabel(node)}」的 {{${binding}}} 未声明，可能导致运行时缺失。` });
    }
    if (node.kind === "agent" && !node.bypass && Object.keys(node.outputs ?? {}).length && !/提交|交付|返回|submit|deliver|return/i.test(node.prompt ?? "")) {
      issues.push({ path: "prompt", nodeId: node.id, warning: true, message: `「${nodeLabel(node)}」的提示词未提及提交结果。` });
    }
    if (node.kind === "condition" && !node.otherwise) issues.push({ path: "otherwise", nodeId: node.id, warning: true, message: `「${nodeLabel(node)}」缺少默认出口。` });
  }
  for (const index of loopEdges(definition.edges)) {
    const edge = definition.edges[index];
    if (!edge.maxTraversals) issues.push({ path: "loop", nodeId: edge.from[0], exitId: edge.from[1], warning: true, message: "回环需要设置轮次上限和超限去向。" });
  }
  for (const issue of backend) {
    const destination = issue.message.match(/([^\s.]+)\.([^\s.]+) must have one connected destination/);
    if (destination && issues.some(local => local.nodeId === destination[1] && local.exitId === destination[2])) continue;
    const node = nodes.get(issue.nodeId || destination?.[1] || "");
    const exit = node?.exits.find(port => port.id === (issue.exitId || destination?.[2]));
    const raw = issue.message.trim();
    if (raw.includes("Every node must be reachable") && issues.some(local => local.path === "incoming")) continue;
    if (raw.includes("requires at least one named exit") && issues.some(local => local.path === "exits")) continue;
    if (raw.includes("has duplicate or empty exits") && issues.some(local => local.path === "exit.name")) continue;
    if (issue.nodeId && issue.exitId && issues.some(local => local.nodeId === issue.nodeId && local.exitId === issue.exitId)) continue;
    const place = `${node ? "「" + nodeLabel(node) + "」" : "流程"}${exit ? "的「" + exit.name + "」" : ""}`;
    const binding = raw.match(/may receive no value for (.+?)\. Use a required field/);
    if (binding && issues.some(local => local.nodeId === node?.id && local.path === "prompt" && local.message.includes("{{" + binding[1] + "}}"))) continue;
    const translation = binding ? `${place}的 {{${binding[1]}}} 在部分路线中可能没有值。请检查上游字段或填写默认值。`
      : destination ? `${place}需要连接到一个目标。`
      : /cycle|loop|traversal/i.test(raw) ? "回环需要设置通过次数和次数用尽后的下一步。"
      : /reachable/i.test(raw) ? "有节点还没有接入流程。"
      : /role|prompt/i.test(raw) ? `${place}需要填写角色和任务提示词。`
      : /[㐀-鿿]/.test(raw) ? raw
      : `${place}有一项配置需要检查。`;
    issues.push({ ...issue, nodeId: node?.id ?? issue.nodeId, exitId: exit?.id ?? issue.exitId, message: translation });
  }
  return issues;
}
