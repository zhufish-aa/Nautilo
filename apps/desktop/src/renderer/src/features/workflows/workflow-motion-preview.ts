import type { WorkflowDefinition, WorkflowEdge } from "@agenthub/domain";
import { edgeKey, graphReachable, loopEdges } from "./workflow-geometry";

export type MotionNodeState = "idle" | "running" | "success" | "looping";
export type MotionCue = { kind: "success" | "join"; sequence: number };

export interface WorkflowMotionPreviewFrame {
  nodes: ReadonlyMap<string, MotionNodeState>;
  waiting: ReadonlySet<string>;
  cues: ReadonlyMap<string, MotionCue>;
  active: ReadonlySet<string>;
  visited: ReadonlySet<string>;
  duration: number;
}

type Route = { edge: WorkflowEdge; index: number };
type Delivery = { route: Route; target: string; limit: boolean };

const transferDuration = 820;
const joinDuration = 520;
const nodeDuration = 470;

const isReturn = (id: string) => id === "$return" || id === "$return_needs_decision";

/** Walk the visible graph for playback. Conditional results are illustrative, and no workflow is started. */
export function buildWorkflowMotionPreview(definition: WorkflowDefinition): WorkflowMotionPreviewFrame[] {
  const nodesById = new Map(definition.nodes.map(node => [node.id, node]));
  if (!nodesById.has(definition.entry)) return [];

  const outgoing = new Map<string, Route[]>();
  definition.edges.forEach((edge, index) => {
    const source = nodesById.get(edge.from[0]);
    if (!source?.exits.some(exit => exit.id === edge.from[1]) || (!nodesById.has(edge.to) && !isReturn(edge.to))) return;
    const routes = outgoing.get(source.id) ?? [];
    routes.push({ edge, index });
    outgoing.set(source.id, routes);
  });

  const loops = loopEdges(definition.edges);
  const reviewRoutes = new Set(loops);
  const forwardEdges = definition.edges.filter(edge => !edge.maxTraversals);
  for (const edge of definition.edges) if (edge.maxTraversals) {
    const predecessors = graphReachable(forwardEdges, edge.from[0], true);
    for (const route of outgoing.get(edge.to) ?? []) if (predecessors.has(route.edge.to)) reviewRoutes.add(route.index);
  }
  const visits = new Map<number, number>();
  const states = new Map<string, MotionNodeState>();
  const visited = new Set<string>();
  const waiting = new Map<string, Set<string>>();
  const frames: WorkflowMotionPreviewFrame[] = [];
  const visit = (index: number) => visits.get(index) ?? 0;
  const limitTarget = (edge: WorkflowEdge) => edge.onLimit && (isReturn(edge.onLimit) || nodesById.has(edge.onLimit)) ? edge.onLimit : undefined;
  const available = ({ edge, index }: Route) => visit(index) < (loops.has(index) && (edge.maxTraversals === undefined || limitTarget(edge)) ? 2 : 1);

  function frame(duration: number, cues = new Map<string, MotionCue>(), active = new Set<string>()) {
    frames.push({ nodes: new Map(states), waiting: new Set(waiting.keys()), cues, active, visited: new Set(visited), duration });
  }

  function canReach(source: string, target: string): boolean {
    const seen = new Set([source]);
    for (const id of seen) {
      for (const route of outgoing.get(id) ?? []) {
        if (!available(route)) continue;
        const next = visit(route.index) && route.edge.maxTraversals !== undefined ? limitTarget(route.edge)! : route.edge.to;
        if (next === target) return true;
        seen.add(next);
      }
    }
    return false;
  }

  function nextRoutes(id: string): Delivery[] {
    const node = nodesById.get(id);
    if (!node) return [];
    const routes = (outgoing.get(id) ?? []).filter(available);
    const parallel = node.kind === "main" || node.kind === "dispatch" || node.dispatch === "all" || node.exitMode === "some";
    // Prefer an available review loop once, then take a fresh exit. A loop-only route can show its configured fallback.
    const choice = routes.find(route => !visit(route.index) && reviewRoutes.has(route.index))
      ?? routes.find(route => !visit(route.index)) ?? routes[0];
    return (parallel ? routes : choice ? [choice] : []).map(route => {
      const previous = visit(route.index);
      const limit = previous > 0 && route.edge.maxTraversals !== undefined;
      visits.set(route.index, previous + 1);
      return { route, target: limit ? limitTarget(route.edge)! : route.edge.to, limit };
    });
  }

  let ready = new Map([[definition.entry, false]]);
  const joinsReleased = new Set<string>();
  // The visual walk shows a bounded number of passes even on an unfinished graph.
  for (let round = 0; round <= definition.edges.length * 2; round++) {
    const joins = [...waiting].filter(([id, arrivals]) => {
      const node = nodesById.get(id)!;
      if (node.wait === "firstValid") return arrivals.size > 0;
      if (node.wait === "quorum") return arrivals.size >= (node.quorum ?? 1);
      if (node.sources?.length) return node.sources.every(source => arrivals.has(source));
      return ![...ready.keys(), ...waiting.keys()].some(source => source !== id && canReach(source, id));
    });
    const cues = new Map<string, MotionCue>();
    for (const [id] of joins) {
      waiting.delete(id);
      joinsReleased.add(id);
      states.set(id, "success");
      cues.set(id, { kind: "join", sequence: round });
    }
    for (const [id, looping] of ready) {
      states.set(id, isReturn(id) ? "success" : looping ? "looping" : "running");
      if (isReturn(id)) cues.set(id, { kind: "success", sequence: round });
    }
    if (!ready.size && !joins.length) break;
    frame(joins.length ? joinDuration : nodeDuration, cues);

    const deliveries = [...ready.keys(), ...joins.map(([id]) => id)].flatMap(nextRoutes);
    const completed = new Map<string, MotionCue>();
    for (const id of ready.keys()) {
      states.set(id, "success");
      if (!isReturn(id)) completed.set(id, { kind: "success", sequence: round });
    }
    if (!deliveries.length) {
      if (completed.size) frame(joinDuration, completed);
      break;
    }

    const active = new Set(deliveries.map(({ route, limit }) => edgeKey({ source: route.edge.from[0], exit: route.edge.from[1], limit })));
    active.forEach(key => visited.add(key));
    frame(transferDuration, completed, active);

    ready = new Map();
    for (const { route, target, limit } of deliveries) {
      if (nodesById.get(target)?.kind === "join") {
        const join = nodesById.get(target)!;
        const source = route.edge.from[0];
        if (join.sources?.length && !join.sources.includes(source)) continue;
        if (joinsReleased.has(target) && (!loops.has(route.index) || !outgoing.get(target)?.some(available))) continue;
        const arrivals = waiting.get(target) ?? new Set();
        arrivals.add(join.sources?.length ? source : edgeKey({ source, exit: route.edge.from[1], limit }));
        waiting.set(target, arrivals);
      } else if (nodesById.has(target) || isReturn(target)) {
        ready.set(target, ready.get(target) || (!limit && loops.has(route.index)));
      }
    }
  }

  // Leave the final state readable while the editor is idle after playback.
  frame(0);
  return frames;
}
