import type { WorkflowDefinition, WorkflowEdge, WorkflowLayout, WorkflowNode } from "@agenthub/domain";
import { initialLayout, nodeSize } from "./workflow-model";

export interface Point { x: number; y: number }
export interface Connection { source: string; exit?: string; limit?: boolean }
export interface EdgeSelection extends Connection { exit: string }
export interface PlacedNode { node: WorkflowNode; position: Point; size: { width: number; height: number } }

export function edgeKey(connection: EdgeSelection): string {
  return JSON.stringify([connection.source, connection.exit, !!connection.limit]);
}

export function findEdge(definition: WorkflowDefinition, connection: Connection): WorkflowEdge | undefined {
  return definition.edges.find(edge => edge.from[0] === connection.source && edge.from[1] === connection.exit);
}

export function pointIsValid(point?: Point): point is Point {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function placeNodes(definition: WorkflowDefinition, layout: WorkflowLayout): PlacedNode[] {
  const defaults = definition.nodes.some(node => !pointIsValid(layout.nodes[node.id])) ? initialLayout(definition).nodes : undefined;
  const positions: PlacedNode[] = definition.nodes.map(node => ({
    node,
    position: pointIsValid(layout.nodes[node.id]) ? layout.nodes[node.id] : defaults![node.id],
    size: nodeSize(node),
  }));
  const right = Math.max(45, ...positions.map(row => row.position.x + row.size.width));
  const returns = [["$return", "交回主会话"], ["$return_needs_decision", "交回判断"]] as const;
  for (const [index, [id, name]] of returns.entries()) {
    if (!definition.edges.some(edge => edge.to === id || edge.onLimit === id)) continue;
    const node = { id, kind: "main", name, exits: [] } satisfies WorkflowNode;
    positions.push({
      node, size: nodeSize(node),
      position: pointIsValid(layout.nodes[id]) ? layout.nodes[id] : defaults?.[id] ?? { x: right + 158, y: 65 + index * 156 },
    });
  }
  return positions;
}

export function outputPoint(row: PlacedNode, exit?: string): Point {
  const index = row.node.exits.findIndex(port => port.id === exit);
  const offset = index < 0 ? (row.node.exits.length ? row.size.height - 13 : row.size.height / 2)
    : row.size.height * (index + 1) / (row.node.exits.length + 1);
  return { x: row.position.x + row.size.width, y: row.position.y + offset };
}

export function inputPoint(row: PlacedNode): Point {
  return { x: row.position.x, y: row.position.y + row.size.height / 2 };
}

export function linkPath(start: Point, end: Point): string {
  return `M ${start.x} ${start.y} ${linkCurve(start, end)}`;
}

function linkCurve(start: Point, end: Point): string {
  const tension = Math.abs(end.x - start.x) / 2;
  return `C ${start.x + tension} ${start.y}, ${end.x - tension} ${end.y}, ${end.x} ${end.y}`;
}

interface NodeBox { id: string; left: number; right: number; top: number; bottom: number }

function forwardDetour(start: Point, end: Point, obstacles: NodeBox[], above: boolean) {
  const width = end.x - start.x;
  if (width <= 0) return;
  const blocks = obstacles.filter(box => box.left < end.x && box.right > start.x);
  if (!blocks.length) return;

  const yAt = (x: number): number => {
    let lo = 0, hi = 1;
    const at = Math.max(0, Math.min(1, (x - start.x) / width));
    for (let step = 0; step < 12; step++) {
      const t = (lo + hi) / 2;
      if (t * (1.5 + t * (t - 1.5)) < at) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    return start.y + (end.y - start.y) * t * t * (3 - 2 * t);
  };
  if (!blocks.some(block => {
    const a = yAt(block.left), b = yAt(block.right);
    return Math.min(a, b) < block.bottom && Math.max(a, b) > block.top;
  })) return;
  const enter = Math.min(...blocks.map(block => block.left)) - 4;
  const leave = Math.max(...blocks.map(block => block.right)) + 4;
  if (enter <= start.x || leave >= end.x) return;

  const y = above ? Math.min(start.y, end.y, ...blocks.map(block => block.top)) - 34
    : Math.max(start.y, end.y, ...blocks.map(block => block.bottom)) + 34;
  return {
    path: `M ${start.x} ${start.y} ${linkCurve(start, {x:enter,y})} H ${leave} ${linkCurve({x:leave,y}, end)}`,
    labelAnchor: { x: (enter + leave) / 2, y },
    right: end.x,
  };
}

function lowerRoute(start: Point, end: Point, y: number, departure: number) {
  const distance = end.x - start.x;
  const lead = Math.min(departure, distance > 0 ? Math.min(42, distance / 2) : distance === 0 ? 24 : 0);
  const shelfX = start.x + lead;
  const controlX = start.x + Math.min(distance > 0 ? lead / 2 : 52, departure);
  const radius = Math.min(18, Math.abs(end.x - shelfX) / 2, (y - end.y) / 2);
  const approachX = end.x - Math.sign(end.x - shelfX) * radius;
  return {
    path: `M ${start.x} ${start.y} C ${controlX} ${start.y}, ${controlX} ${y}, ${shelfX} ${y} H ${approachX} Q ${end.x} ${y}, ${end.x} ${y - radius} V ${end.y}`,
    labelAnchor: { x: (shelfX + approachX) / 2, y },
    right: Math.max(controlX, shelfX, end.x),
  };
}

export interface DiagramWire {
  selection: EdgeSelection;
  edge: WorkflowEdge;
  index: number;
  target: string;
  key: string;
  path: string;
  start: Point;
  end: Point;
  center: Point;
  labelAnchor: Point;
  right: number;
  name: string;
}

export function diagramWires(definition: WorkflowDefinition, layout: WorkflowLayout, positions: PlacedNode[], preview?: { key: string; point: Point }): DiagramWire[] {
  const nodes = new Map(positions.map(row => [row.node.id, row]));
  const boxes = positions.map(({ node, position, size }) => ({
    id: node.id,
    left: position.x - 8, right: position.x + size.width + 8,
    top: position.y - 8, bottom: position.y + size.height + 8,
  }));
  const loops = loopEdges(definition.edges);
  const wires: DiagramWire[] = [];
  const bottom = Math.max(0, ...positions.map(row => row.position.y + row.size.height));
  let lane = 0;
  definition.edges.forEach((edge, index) => {
    const from = nodes.get(edge.from[0]);
    const port = from?.node.exits.find(exit => exit.id === edge.from[1]);
    if (!from || !port) return;
    [edge.to, edge.onLimit].forEach((target, branch) => {
      const to = target && nodes.get(target);
      if (!to || !target) return;
      const limit = branch === 1;
      const selection = { source: from.node.id, exit: port.id, limit };
      const key = edgeKey(selection);
      const start = outputPoint(from, port.id);
      const backward = !limit && !!edge.maxTraversals || to.position.x + 12 <= from.position.x && !target.startsWith("$");
      const end = backward
        ? { x: to.position.x + to.size.width / 2, y: to.position.y + to.size.height }
        : inputPoint(to);
      const fixed = preview?.key === key ? preview.point : layout.edgeRoutes?.[key];
      const low = backward ? bottom + 34 + 28 * lane++ : 0;
      const obstacles = boxes.filter(box => box.id !== from.node.id && box.id !== target);
      const departure = Math.min(52, ...obstacles.filter(box => box.left >= start.x && box.top <= low && box.bottom >= start.y)
        .map(box => box.left - start.x));
      const automatic = pointIsValid(fixed) ? undefined : backward ? lowerRoute(start, end, low, departure)
        : forwardDetour(start, end, obstacles, target === "$return" || end.y < start.y);
      const center = pointIsValid(fixed) ? fixed : automatic?.labelAnchor ?? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const path = pointIsValid(fixed)
        ? `${linkPath(start, fixed)} C ${fixed.x + 36} ${fixed.y}, ${backward ? end.x : end.x - 36} ${backward ? end.y + 32 : end.y}, ${end.x} ${end.y}`
        : automatic?.path ?? linkPath(start, end);
      wires.push({ selection, edge, index, target, key, path, start, end, center,
        labelAnchor: automatic?.labelAnchor ?? center, right: automatic?.right ?? Math.max(center.x, start.x + 18, end.x),
        name: limit ? port.name + " · 次数用尽" : loops.has(index)
          ? `↺ ${port.name}${edge.maxTraversals ? ` · ≤${edge.maxTraversals}轮` : " · ⚠"}` : port.name });
    });
  });
  return wires;
}

export function diagramBounds(positions: PlacedNode[], wires: DiagramWire[]) {
  const left = Math.min(...positions.map(row => row.position.x), ...wires.map(wire => wire.center.x));
  const top = Math.min(...positions.map(row => row.position.y), ...wires.map(wire => wire.center.y));
  const right = Math.max(...positions.map(row => row.position.x + row.size.width), ...wires.map(wire => wire.right));
  const bottom = Math.max(...positions.map(row => row.position.y + row.size.height), ...wires.map(wire => wire.center.y));
  return positions.length ? { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
    : { left: 0, top: 0, width: 168, height: 74 };
}

export const wireLabelWidth = 176;
export const wireLabelHeight = 22;

export function wireLabelPositions(wires: DiagramWire[], nodes: PlacedNode[], widths: ReadonlyMap<string, number>): Map<string, Point> {
  const positions = new Map<string, Point>();
  const occupied = nodes.map(({ node, position, size }) => ({
    left: position.x - 2,
    right: position.x + size.width + 2,
    top: position.y - 4,
    bottom: position.y + size.height + (node.kind === "join" ? 23 : 4),
  }));
  const clearance = wireLabelHeight / 2 + 2;
  for (const wire of wires) {
    const { x, y } = wire.labelAnchor;
    const wantedY = y - 14;
    const width = widths.get(wire.key) ?? Math.min(wireLabelWidth, [...wire.name].length * 10 + 16);
    const radius = width / 2 + 1;
    const overlapsX = (rect: (typeof occupied)[number], atX: number) => rect.left < atX + radius && rect.right > atX - radius;
    const byX = occupied.filter(rect => overlapsX(rect, x));
    const overlapsY = (rect: (typeof occupied)[number], atY: number) => rect.top < atY + clearance && rect.bottom > atY - clearance;
    let point = { x, y: wantedY };
    if (byX.some(rect => overlapsY(rect, wantedY))) {
      let distance = Infinity;
      const nearby = occupied.filter(rect => rect.left < x + radius + 56 && rect.right > x - radius - 56);
      for (const atY of [wantedY, ...byX.flatMap(rect => [rect.top - clearance, rect.bottom + clearance])]) {
        const vertical = Math.abs(atY - wantedY);
        if (vertical >= distance) continue;
        const blocking = nearby.filter(rect => overlapsY(rect, atY));
        for (const atX of [x, ...blocking.flatMap(rect => [rect.left - radius, rect.right + radius])]) {
          const horizontal = Math.abs(atX - x), offset = Math.hypot(horizontal * 1.2, vertical);
          if (horizontal > 56 || offset >= distance || blocking.some(rect => overlapsX(rect, atX))) continue;
          point = { x: atX, y: atY };
          distance = offset;
        }
      }
    }
    positions.set(wire.key, point);
    occupied.push({ left: point.x - radius, right: point.x + radius, top: point.y - wireLabelHeight / 2, bottom: point.y + wireLabelHeight / 2 });
  }
  return positions;
}

export function loopEdges(edges: WorkflowEdge[]): Set<number> {
  const loop = new Set<number>();
  const routes = new Map<string, { target: string; index: number }[]>();
  for (const [index, edge] of edges.entries()) {
    if (edge.maxTraversals) loop.add(index);
    const target = edge.maxTraversals ? edge.onLimit : edge.to;
    if (!target) continue;
    const exits = routes.get(edge.from[0]) ?? [];
    if (!exits.length) routes.set(edge.from[0], exits);
    exits.push({ target, index });
  }
  const visited = new Set<string>(), path = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id); path.add(id);
    for (const exit of routes.get(id) ?? []) {
      if (path.has(exit.target)) loop.add(exit.index);
      else visit(exit.target);
    }
    path.delete(id);
  }
  for (const id of routes.keys()) visit(id);
  return loop;
}

export function graphReachable(edges: WorkflowEdge[], start: string, reverse = false): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) for (const target of [edge.to, ...(edge.onLimit ? [edge.onLimit] : [])]) {
    const [a, b] = reverse ? [target, edge.from[0]] : [edge.from[0], target];
    const list = adjacency.get(a) ?? [];
    if (!list.length) adjacency.set(a, list);
    list.push(b);
  }
  const reached = new Set([start]);
  for (const id of reached) for (const next of adjacency.get(id) ?? []) reached.add(next);
  return reached;
}

export function alignmentGuides(moving: PlacedNode[], fixed: PlacedNode[], delta: Point, tolerance: number) {
  const result = { delta: { ...delta }, guides: [] as { axis: "x" | "y"; at: number; start: number; end: number }[] };
  for (const axis of ["x", "y"] as const) {
    const length = axis === "x" ? "width" : "height";
    const cross = axis === "x" ? "y" : "x";
    const crossLength = axis === "x" ? "height" : "width";
    let best = tolerance;
    let guide: typeof result.guides[number] | undefined;
    for (const v of moving) for (const other of fixed) for (const fraction of [0, .5, 1]) {
      const at = other.position[axis] + other.size[length] * fraction;
      const offset = at - (v.position[axis] + v.size[length] * fraction + delta[axis]);
      if (Math.abs(offset) >= best) continue;
      best = Math.abs(offset);
      const a = v.position[cross] + delta[cross], b = other.position[cross];
      result.delta[axis] = delta[axis] + offset;
      guide = { axis, at, start: Math.min(a, b), end: Math.max(a + v.size[crossLength], b + other.size[crossLength]) };
    }
    if (guide) result.guides.push(guide);
  }
  return result;
}
