import type { WorkflowDefinition, WorkflowEdge, WorkflowLayout, WorkflowNode } from "@agenthub/domain";
import { nodeSize } from "./workflow-model";

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
  const positions: PlacedNode[] = definition.nodes.map((node, index) => ({
    node,
    position: pointIsValid(layout.nodes[node.id]) ? layout.nodes[node.id] : { x: 45 + index % 3 * 230, y: 65 + Math.floor(index / 3) * 115 },
    size: nodeSize(node),
  }));
  const right = Math.max(45, ...positions.map(row => row.position.x + row.size.width));
  const returns = [["$return", "交回主会话"], ["$return_needs_decision", "交回判断"]] as const;
  for (const [index, [id, name]] of returns.entries()) {
    if (!definition.edges.some(edge => edge.to === id || edge.onLimit === id)) continue;
    const node = { id, kind: "main", name, exits: [] } satisfies WorkflowNode;
    positions.push({
      node, size: nodeSize(node),
      position: pointIsValid(layout.nodes[id]) ? layout.nodes[id] : { x: right + 126, y: 65 + index * 120 },
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
  const tension = Math.max(25, Math.abs(end.x - start.x) * .5);
  return `M ${start.x} ${start.y} C ${start.x + tension} ${start.y}, ${end.x - tension} ${end.y}, ${end.x} ${end.y}`;
}

function lowerRoute(start: Point, end: Point, y: number) {
  const distance = end.x - start.x;
  const lead = distance > 0 ? Math.min(42, distance / 2) : distance === 0 ? 24 : 0;
  const shelfX = start.x + lead;
  const controlX = start.x + (distance > 0 ? lead / 2 : 52);
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
  const wires: DiagramWire[] = [];
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
      const backward = to.position.x <= start.x || limit;
      const end = backward
        ? { x: to.position.x + to.size.width / 2, y: to.position.y + to.size.height }
        : inputPoint(to);
      const fixed = preview?.key === key ? preview.point : layout.edgeRoutes?.[key];
      const low = Math.max(from.position.y + from.size.height, to.position.y + to.size.height) + (limit ? 75 : 55);
      const center = pointIsValid(fixed) ? fixed : { x: (start.x + end.x) / 2, y: backward ? low : (start.y + end.y) / 2 };
      const automatic = backward && !pointIsValid(fixed) ? lowerRoute(start, end, low) : undefined;
      const path = pointIsValid(fixed)
        ? `${linkPath(start, fixed)} C ${fixed.x + 36} ${fixed.y}, ${backward ? end.x : end.x - 36} ${backward ? end.y + 32 : end.y}, ${end.x} ${end.y}`
        : automatic?.path ?? linkPath(start, end);
      wires.push({ selection, edge, index, target, key, path, start, end, center,
        labelAnchor: automatic?.labelAnchor ?? center, right: automatic?.right ?? Math.max(center.x, start.x + 18, end.x),
        name: port.name + (limit ? " · 次数用尽" : "") });
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
    left: position.x - 6,
    right: position.x + size.width + 8,
    top: position.y - 4,
    bottom: position.y + size.height + (node.kind === "join" ? 23 : 4),
  }));
  const clearance = wireLabelHeight / 2 + 2;
  for (const wire of wires) {
    const { x, y } = wire.labelAnchor;
    const wantedY = y - 14;
    const width = widths.get(wire.key) ?? Math.min(wireLabelWidth, [...wire.name].length * 10 + 16);
    const radius = width / 2 + 2;
    const overlapsX = (rect: (typeof occupied)[number], atX: number) => rect.left < atX + radius && rect.right > atX - radius;
    const byX = occupied.filter(rect => overlapsX(rect, x));
    const byY = occupied.filter(rect => rect.top < wantedY + clearance && rect.bottom > wantedY - clearance);
    let point = { x, y: wantedY };
    if (byY.some(rect => overlapsX(rect, x))) {
      const ys = byX.flatMap(rect => [rect.top - clearance, rect.bottom + clearance]);
      ys.sort((a, b) => Math.abs(a - wantedY) - Math.abs(b - wantedY));
      const clearY = ys.find(atY => byX.every(rect => atY <= rect.top - clearance || atY >= rect.bottom + clearance))!;
      // A short sideways adjustment keeps labels next to steep curves and closely spaced nodes.
      const xs = byY.flatMap(rect => [rect.left - radius, rect.right + radius]);
      xs.sort((a, b) => Math.abs(a - x) - Math.abs(b - x));
      const clearX = xs.find(atX => Math.abs(atX - x) <= 40 && byY.every(rect => !overlapsX(rect, atX)));
      point = clearX !== undefined && Math.abs(clearX - x) * 1.2 < Math.abs(clearY - wantedY)
        ? { x: clearX, y: wantedY } : { x, y: clearY };
    }
    positions.set(wire.key, point);
    occupied.push({ left: point.x - radius, right: point.x + radius, top: point.y - wireLabelHeight / 2, bottom: point.y + wireLabelHeight / 2 });
  }
  return positions;
}

export function loopEdges(edges: WorkflowEdge[]): Set<number> {
  const limited = edges.flatMap((edge, index) => edge.maxTraversals === undefined ? [] : [index]);
  const result = new Set(limited);
  if (!limited.length) return result;
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const { from: [source], to } of edges) {
    successors.set(source, [...(successors.get(source) ?? []), to]);
    predecessors.set(to, [...(predecessors.get(to) ?? []), source]);
  }
  function reachable(start: string, neighbors: Map<string, string[]>): Set<string> {
    const seen = new Set([start]);
    for (const id of seen) for (const next of neighbors.get(id) ?? []) seen.add(next);
    return seen;
  }
  for (const index of limited) {
    const edge = edges[index];
    const after = reachable(edge.to, successors);
    const before = reachable(edge.from[0], predecessors);
    edges.forEach((candidate, index) => {
      if (after.has(candidate.from[0]) && before.has(candidate.to)) result.add(index);
    });
  }
  return result;
}
