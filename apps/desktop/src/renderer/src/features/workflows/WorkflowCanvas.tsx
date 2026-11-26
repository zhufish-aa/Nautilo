import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Activity, BellRing, Check, Circle, ClipboardPaste, Copy, CornerDownLeft, GitFork, GitMerge, Hand, Layers3, Link, Lock, Minus, MousePointer2, Orbit, Plus, RotateCcw, Scan, ScanEye, SkipForward, Trash2, Unlock, Workflow, X } from "lucide-react";
import type { WorkflowDefinition, WorkflowLayout, WorkflowInstance, WorkflowEvent, WorkflowIssue, WorkflowRun } from "@agenthub/domain";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { providerMeta } from "../../lib/provider-catalog";
import { addableKinds, canRemoveOutlet, type AddableKind } from "./workflow-editing";
import { alignmentGuides, diagramBounds, diagramWires, edgeKey, findEdge, graphReachable, inputPoint, linkPath, loopEdges, outputPoint, placeNodes, wireLabelHeight, wireLabelPositions, wireLabelWidth, type Connection, type DiagramWire, type EdgeSelection, type PlacedNode, type Point } from "./workflow-geometry";
import { nodeKinds, nodeLabel, nodeTone, starterKinds, statusLabels } from "./workflow-model";
import { WorkflowMenu, type MenuAction } from "./WorkflowMenu";
import { returnedTarget, traversedWire, useWorkflowEventMotion, WorkflowStream } from "./WorkflowMotion";
import type { MotionNodeState, WorkflowMotionPreviewFrame } from "./workflow-motion-preview";

interface Editor {
  edge?: EdgeSelection;
  canPaste: boolean;
  selectEdge(edge: EdgeSelection): void;
  connect(link: Connection, target: string): void;
  add(kind: AddableKind, point: Point, link?: Connection, insert?: EdgeSelection): void;
  moveWire(edge: EdgeSelection, point?: Point): void;
  unlink(edge: EdgeSelection): void;
  removeOutlet(source: string, exit: string): void;
  removeNode(id: string): void;
  copyNode(id: string): void;
  pasteNode(point: Point): void;
  renameNode(id: string, name: string): void;
  renameEdge(selection: EdgeSelection, name: string): void;
  cloneNode(id: string): void;
  bypassNodes(ids: string[]): void;
  removeNodes(ids: string[]): void;
  arrangeNodes(ids: string[], action: "horizontal" | "vertical" | "parallel", groupId?: string): void;
  rewireSource(selection: EdgeSelection, source: string): void;
  moveOutOfGroup(id: string, groupId: string): void;
  startFrom(kind: typeof starterKinds[number]["id"]): void;
}

interface Props {
  definition: WorkflowDefinition; layout: WorkflowLayout; selected: string; editing: boolean;
  instances: Map<string, WorkflowInstance>; events: WorkflowEvent[];
  onSelect(id: string): void;
  onMove(id: string, x: number, y: number): void;
  onMoveEnd(): void;
  editor?: Editor;
  motionPlaying: boolean;
  motionLive: boolean;
  motionReduced: boolean;
  libraryCollapsed: boolean;
  preview?: WorkflowMotionPreviewFrame;
  previewPlaying?: boolean;
  issues?: WorkflowIssue[];
  assignments?: WorkflowRun["assignments"];
  locked?: boolean;
  onLockChange?(locked: boolean): void;
  hoveredOutlet?: EdgeSelection;
  children?: ReactNode;
  locate?: { nodeId: string; exitId?: string; request: number; reveal?: boolean };
}
const icons = { main: Orbit, dispatch: GitFork, agent: Activity, join: GitMerge, condition: Layers3, call: Workflow };
const arrowTones = ["normal", "focus", "selected", "loop", "loop-focus", "active"] as const;
const activeInstance = (instance: WorkflowInstance) => instance.status === "starting" || instance.status === "running" || instance.status === "verifying";
const pointerTools = [
  { id:"select", key:"V", label:"选择", icon:MousePointer2 },
  { id:"pan", key:"H", label:"抓手拖动", icon:Hand },
  { id:"connect", key:"C", label:"快捷连线", icon:Link },
] as const;
type PointerMode = typeof pointerTools[number]["id"];

type Drag = {
  pointer: number; screen: Point; moved: boolean;
} & (
  | { kind: "pan"; base: Point; nodeId?: string }
  | { kind: "marquee"; extend: boolean }
  | { kind: "node"; id: string; rows: PlacedNode[]; groups: Array<{ id: string; x: number; y: number; width: number; height: number; members: string[] }> }
  | { kind: "wire"; wire: DiagramWire; base: Point }
  | { kind: "link"; from: Connection; origin: Point; reverse?: EdgeSelection }
);

type Menu = { anchor: Point; point: Point } & (
  | { kind: "add"; from?: Connection; insert?: EdgeSelection }
  | { kind: "node"; id: string; port?: string }
  | { kind: "wire"; wire: DiagramWire }
);

export function WorkflowCanvas({ definition, layout, selected, editing: design, instances, events, onSelect, onMove, onMoveEnd, editor,
  motionPlaying, motionLive, motionReduced, libraryCollapsed, preview, previewPlaying, issues = [], assignments, locked = false, onLockChange, hoveredOutlet, children, locate }: Props): JSX.Element {
  const editing = design && !locked;
  const board = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const viewMotion = useRef<Animation>();
  const measureCanvas = useRef<() => void>();
  const pane = useRef({ libraryCollapsed, motionReduced });
  pane.current = { libraryCollapsed, motionReduced };
  const [viewport, setViewport] = useState({ x: 20, y: 20, zoom: 1 });
  const [link, setLink] = useState<Connection>();
  const [linkPreview, setLinkPreview] = useState<{ origin: Point; tip: Point; target?: string; invalid?: boolean }>();
  const [wirePreview, setWirePreview] = useState<{ key: string; point: Point }>();
  const [menu, setMenu] = useState<Menu>();
  const [hovered, setHovered] = useState<string>();
  const [dragging, setDragging] = useState<Drag["kind"]>();
  const [multiple, setMultiple] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ start: Point; end: Point }>();
  const [guides, setGuides] = useState<ReturnType<typeof alignmentGuides>["guides"]>([]);
  const [lineage, setLineage] = useState(false);
  const [pinnedLineage, setPinnedLineage] = useState<string>();
  const [tooltip, setTooltip] = useState<string>();
  const [minimap, setMinimap] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: "node" | "wire"; id: string; name: string }>();
  const [space, setSpace] = useState(false);
  const [pointerMode, setPointerMode] = useState<PointerMode>("select");
  const currentMode = design && (locked || space) ? "pan" : pointerMode;
  const [labelWidths, setLabelWidths] = useState<ReadonlyMap<string, number>>(() => new Map());
  const drag = useRef<Drag>();
  const marker = "wf-arrow-" + useId().replace(/:/g, "");
  const arrowStyles = Object.fromEntries(arrowTones.map(tone => [`--wf-arrow-${tone}`, `url(#${marker}-${tone})`])) as CSSProperties;
  const positions = useMemo(() => placeNodes(definition, layout), [definition, layout.nodes]);
  const byId = useMemo(() => new Map(positions.map(row => [row.node.id, row])), [positions]);
  const wires = useMemo(() => diagramWires(definition, layout, positions, wirePreview), [definition, layout, positions, wirePreview]);
  const loops = useMemo(() => loopEdges(definition.edges), [definition.edges]);
  const labelPositions = useMemo(() => wireLabelPositions(wires, positions, labelWidths), [wires, positions, labelWidths]);
  const selectedWire = editor?.edge ? edgeKey(editor.edge) : undefined;
  const byNode = useMemo(() => {
    const rows = new Map<string, WorkflowInstance[]>();
    for (const instance of instances.values()) {
      const existing = rows.get(instance.nodeId) ?? [];
      existing.push(instance);
      rows.set(instance.nodeId, existing);
    }
    return rows;
  }, [instances]);
  const history = useMemo(() => {
    const visited = new Set<string>(), returned = new Set<string>();
    for (const event of events) {
      const wire = traversedWire(definition, event), target = returnedTarget(event);
      if (wire) visited.add(wire);
      if (target) returned.add(target);
    }
    return { visited, returned };
  }, [definition, events]);
  const liveWires = useMemo(() => {
    const active = new Set<string>(), looping = new Set<string>();
    for (const wire of wires) {
      if (!history.visited.has(wire.key) || !byNode.get(wire.target)?.some(instance => {
        const incoming = instance.incoming as { from?: string; branch?: string } | null;
        return activeInstance(instance) && incoming?.from === wire.selection.source && incoming.branch === wire.selection.exit;
      })) continue;
      active.add(wire.key);
      if (loops.has(wire.index)) looping.add(wire.target);
    }
    return { active, looping };
  }, [wires, history.visited, byNode, loops]);
  const eventCues = useWorkflowEventMotion(definition, events, liveWires.active, editing ? "editor" : motionLive ? "live" : "history", motionPlaying, motionReduced);
  const focused = design && !previewPlaying && !dragging && !link && !menu ? hovered : undefined;
  const lineageSource = pinnedLineage ?? (lineage ? focused : undefined);
  const family = useMemo(() => lineageSource ? { before: graphReachable(definition.edges, lineageSource, true), after: graphReachable(definition.edges, lineageSource) } : undefined, [lineageSource, definition.edges]);
  const focusOf = (wire: DiagramWire) => family ? (family.before.has(wire.selection.source) && family.before.has(wire.target) ? "upstream"
    : family.after.has(wire.selection.source) && family.after.has(wire.target) ? "downstream" : "far")
    : focused ? (wire.selection.source === focused || wire.target === focused ? "near" : "far") : undefined;
  const linkingFrom = drag.current?.kind === "link" ? drag.current.from : link;
  const outletHighlighted = hoveredOutlet && edgeKey(hoveredOutlet);
  useEffect(() => {
    setTooltip(undefined);
    if (!focused || currentMode !== "select" || !byId.has(focused)) return;
    const timer = window.setTimeout(() => setTooltip(focused), 280);
    return () => window.clearTimeout(timer);
  }, [focused, currentMode]);
  const parallelGroups = useMemo(() => definition.nodes.filter(node => node.kind === "main" || node.kind === "dispatch" || node.dispatch === "all").flatMap(node => {
    const targets = definition.edges.filter(edge => edge.from[0] === node.id).map(edge => byId.get(edge.to)).filter(row => row?.node.kind === "agent");
    if (targets.length < 2) return [];
    const x = Math.min(...targets.map(row => row!.position.x)) - 23, y = Math.min(...targets.map(row => row!.position.y)) - 35;
    return [{ id: node.id, x, y, width: Math.max(...targets.map(row => row!.position.x + row!.size.width)) - x + 23, height: Math.max(...targets.map(row => row!.position.y + row!.size.height)) - y + 25, members: targets.map(row => row!.node.id) }];
  }), [definition, byId]);
  const fit = (): void => {
    if (!board.current) return;
    viewMotion.current?.cancel();
    const { left, top, width, height } = diagramBounds(positions, wires);
    const { clientWidth, clientHeight } = board.current;
    const zoom = Math.max(.17, Math.min(1.15, (clientWidth - 84) / width, (clientHeight - 120) / height));
    setViewport({ x: (clientWidth - width * zoom) / 2 - left * zoom, y: (clientHeight - height * zoom) / 2 - top * zoom, zoom });
  };
  const fitting = useRef(fit); fitting.current = fit;
  useLayoutEffect(() => {
    const element = board.current;
    if (!element) return;
    let size: { x: number; y: number; screenX: number; screenY: number; collapsed: boolean } | undefined;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const next = { x: element.clientWidth, y: element.clientHeight, screenX: rect.left + rect.width / 2, screenY: rect.top + rect.height / 2, collapsed: pane.current.libraryCollapsed };
      if (!next.x || !next.y) return;
      if (!size) fitting.current();
      else {
        const dx = (next.x - size.x) / 2, dy = (next.y - size.y) / 2;
        if (dx || dy) setViewport(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
        if (size.collapsed !== next.collapsed && !pane.current.motionReduced && world.current && (dx || dy)) {
          const computed = getComputedStyle(world.current);
          const [shiftX = 0, shiftY = 0] = computed.translate.split(" ").map(part => Number.parseFloat(part) || 0);
          const fromX = size.screenX - next.screenX + shiftX, fromY = size.screenY - next.screenY + shiftY;
          viewMotion.current?.cancel();
          viewMotion.current = world.current.animate([{ translate: `${fromX}px ${fromY}px` }, { translate: "0 0" }], {
            duration: Number.parseFloat(computed.getPropertyValue("--wf-motion-panel")),
            easing: computed.getPropertyValue("--wf-motion-panel-ease").trim(),
          });
        }
      }
      size = next;
    };
    measureCanvas.current = updateSize;
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => { observer.disconnect(); viewMotion.current?.cancel(); measureCanvas.current = undefined; };
  }, [definition.id]);
  useLayoutEffect(() => { measureCanvas.current?.(); }, [libraryCollapsed]);
  useLayoutEffect(() => { if (motionReduced) viewMotion.current?.cancel(); }, [motionReduced]);
  useLayoutEffect(() => {
    const labels = Array.from(board.current?.querySelectorAll<HTMLElement>(".wf-edge-label") ?? []);
    const measure = () => {
      const widths = new Map(labels.map(label => [label.dataset.labelKey!, label.offsetWidth] as const));
      setLabelWidths(previous => widths.size === previous.size && Array.from(widths).every(([key, width]) => previous.get(key) === width) ? previous : widths);
    };
    measure();
    const observer = new ResizeObserver(measure);
    labels.forEach(label => observer.observe(label));
    return () => observer.disconnect();
  }, [definition]);
  useEffect(() => {
    setLink(undefined); setMenu(undefined); setLinkPreview(undefined); setWirePreview(undefined);
    setHovered(undefined); setDragging(undefined); setMultiple([]); setRenaming(undefined); drag.current = undefined;
  }, [editing, definition.id]);
  useEffect(() => {
    const row = locate && byId.get(locate.nodeId);
    const element = board.current;
    if (!row || !element) return;
    const point = locate.exitId ? outputPoint(row, locate.exitId) : { x: row.position.x + row.size.width / 2, y: row.position.y + row.size.height / 2 };
    const nodeElement = [...element.querySelectorAll<HTMLElement>("[data-node-id]")].find(node => node.dataset.nodeId === locate.nodeId);
    if (!locate.reveal && !motionReduced && world.current) {
      const zoom = Math.max(.8, viewport.zoom);
      const x = element.clientWidth / 2 - point.x * zoom, y = element.clientHeight / 2 - point.y * zoom;
      const from = getComputedStyle(world.current).transform;
      viewMotion.current?.cancel();
      viewMotion.current = world.current.animate([{ transform: from }, { transform: `translate(${x}px,${y}px) scale(${zoom})` }], { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" });
      nodeElement?.querySelector(".wf-focus-ring")?.animate([{ opacity: .9, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.12)" }], { duration: 470, easing: "ease-out" });
    }
    setViewport(current => {
      if (locate.reveal) {
        const left = row.position.x * current.zoom + current.x;
        const top = row.position.y * current.zoom + current.y;
        const right = left + row.size.width * current.zoom;
        const bottom = top + row.size.height * current.zoom;
        const x = left < 24 ? 24 - left : Math.min(0, element.clientWidth - 43 - right);
        const y = top < 34 ? 34 - top : Math.min(0, element.clientHeight - 58 - bottom);
        return x || y ? { ...current, x: current.x + x, y: current.y + y } : current;
      }
      const zoom = Math.max(.8, current.zoom);
      return { x: element.clientWidth / 2 - point.x * zoom, y: element.clientHeight / 2 - point.y * zoom, zoom };
    });
    const frame = requestAnimationFrame(() => {
      const node = [...element.querySelectorAll<HTMLElement>("[data-node-id]")].find(node => node.dataset.nodeId === locate.nodeId);
      const port = [...(node?.querySelectorAll<HTMLButtonElement>("[data-outlet-id]") ?? [])].find(port => port.dataset.outletId === locate.exitId);
      (port || node?.querySelector<HTMLButtonElement>(".wf-node-body"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [locate?.request]);

  useEffect(() => {
    if (!design) return;
    const down = (event: KeyboardEvent) => {
      const target = event.target as Element;
      if (event.key === "Alt") { setLineage(true); return; }
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat ||
          target.closest?.("input,textarea,select,[contenteditable=true],[role=menu],[role=dialog]") ||
          (!board.current?.contains(target) && !board.current?.matches(":hover"))) return;
      const mode = pointerTools.find(tool => tool.key.toLowerCase() === event.key.toLowerCase());
      if (mode && !locked) { event.preventDefault(); setPointerMode(mode.id); setLink(undefined); setMenu(undefined); }
      if (event.key.toLowerCase() === "l") { event.preventDefault(); onLockChange?.(!locked); }
      if (event.key === " ") { event.preventDefault(); setSpace(true); }
    };
    const up = (event: KeyboardEvent) => { if (event.key === "Alt") setLineage(false); if (event.key === " ") setSpace(false); };
    const release = () => { setLineage(false); setSpace(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", release);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", release); };
  }, [design, locked, onLockChange]);

  const closeMenu = useCallback((restore?: boolean): void => {
    setMenu(undefined);
    if (restore) board.current?.focus({ preventScroll: true });
  }, []);
  const localPoint = (point: Point): Point => {
    const rect = board.current!.getBoundingClientRect();
    return { x: point.x - rect.left, y: point.y - rect.top };
  };
  const worldPoint = (point: Point): Point => {
    const local = localPoint(point);
    return { x: (local.x - viewport.x) / viewport.zoom, y: (local.y - viewport.y) / viewport.zoom };
  };
  const screenPoint = (event: { clientX: number; clientY: number }): Point => ({ x: event.clientX, y: event.clientY });
  const targetAt = (point: Point, source: string): string | undefined => {
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || !board.current?.contains(hit) || hit.closest(".wf-zoom, .wf-context-menu, .wf-link-notice")) return;
    const id = hit.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    if (id) return id === source ? undefined : id;
    const world = worldPoint(point);
    let distance = 32 / viewport.zoom, target: string | undefined;
    for (const row of positions) {
      if (row.node.id === source) continue;
      const input = inputPoint(row);
      const gap = Math.hypot(input.x - world.x, input.y - world.y);
      if (gap >= distance) continue;
      distance = gap;
      target = row.node.id;
    }
    return target;
  };
  const zoomBy = useCallback((amount: number, anchor?: Point): void => {
    viewMotion.current?.cancel();
    setViewport(current => {
      const next = Math.max(.17, Math.min(2, current.zoom * amount));
      const { x, y } = anchor ?? { x: (board.current?.clientWidth || 800) / 2, y: (board.current?.clientHeight || 400) / 2 };
      return { x: x - (x - current.x) * next / current.zoom, y: y - (y - current.y) * next / current.zoom, zoom: next };
    });
  }, []);
  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const zoomFromWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomBy(event.deltaY > 0 ? .93 : 1.075, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener("wheel", zoomFromWheel, { passive: false });
    return () => element.removeEventListener("wheel", zoomFromWheel);
  }, [zoomBy]);
  function begin(event: ReactPointerEvent, next: Drag): void {
    event.preventDefault();
    event.stopPropagation();
    viewMotion.current?.cancel();
    setMenu(undefined);
    drag.current = next;
    setDragging(next.kind);
    board.current?.setPointerCapture(event.pointerId);
  }
  function startLink(event: ReactPointerEvent, from: Connection, origin: Point): void {
    if (event.button !== 0 || currentMode === "pan") return;
    board.current?.focus({ preventScroll: true });
    begin(event, { kind: "link", from, origin, screen: screenPoint(event), moved: false, pointer: event.pointerId });
    setLink(undefined);
  }
  function move(event: ReactPointerEvent): void {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const at = screenPoint(event), dx = at.x - current.screen.x, dy = at.y - current.screen.y;
    current.moved ||= Math.hypot(dx, dy) > 4;
    if (!current.moved) return;
    if (current.kind === "link") {
      const target = targetAt(at, current.from.source);
      const row = target && byId.get(target);
      const invalid = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId === current.from.source;
      setLinkPreview({ origin: current.origin, tip: row ? (current.reverse ? outputPoint(row) : inputPoint(row)) : worldPoint(at), target, invalid });
    } else if (current.kind === "node") {
      if (!board.current?.hasPointerCapture(event.pointerId)) {
        board.current?.setPointerCapture(event.pointerId); setDragging("node");
      }
      const ids = new Set(current.rows.map(row => row.node.id));
      const snapped = alignmentGuides(current.rows, positions.filter(row => !ids.has(row.node.id)), { x: dx / viewport.zoom, y: dy / viewport.zoom }, 6 / viewport.zoom);
      setGuides(snapped.guides);
      for (const row of current.rows) onMove(row.node.id, Math.round(row.position.x + snapped.delta.x), Math.round(row.position.y + snapped.delta.y));
    } else if (current.kind === "marquee") {
      setMarquee({ start: localPoint(current.screen), end: localPoint(at) });
    } else if (current.kind === "wire") {
      setWirePreview({ key: current.wire.key, point: { x: current.base.x + dx / viewport.zoom, y: current.base.y + dy / viewport.zoom } });
    } else setViewport(previous => ({ ...previous, x: current.base.x + dx, y: current.base.y + dy }));
  }
  function finish(event: ReactPointerEvent, cancelled = false): void {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = undefined;
    setDragging(undefined);
    const element = board.current;
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setLinkPreview(undefined); setWirePreview(undefined); setMarquee(undefined); setGuides([]);
    if (cancelled) { if (current.kind === "node") onMoveEnd(); return; }
    const at = screenPoint(event);
    if (current.kind === "node" && current.moved && current.rows.length === 1 && current.rows[0].node.kind === "agent") {
      const center = worldPoint(at);
      const previous = current.groups.find(group => group.members.includes(current.id));
      const contains = (group: typeof current.groups[number]) => center.x >= group.x && center.x <= group.x + group.width && center.y >= group.y && center.y <= group.y + group.height;
      const target = current.groups.find(group => group !== previous && contains(group));
      if (target) editor?.arrangeNodes([current.id], "parallel", target.id);
      else if (previous && !contains(previous)) editor?.moveOutOfGroup(current.id, previous.id);
    }
    if (current.kind === "node") onMoveEnd();
    if (current.kind === "link") {
      if (current.reverse) {
        const target = current.moved && targetAt(at, current.from.source);
        if (target && !target.startsWith("$")) editor?.rewireSource(current.reverse, target);
        return;
      }
      if (!current.moved) { setLink(current.from); return; }
      const target = targetAt(at, current.from.source);
      if (target) editor?.connect(current.from, target);
      else {
        const hit = document.elementFromPoint(at.x, at.y);
        if (element?.contains(hit) && !hit?.closest("[data-node-id], .wf-zoom, .wf-context-menu")) {
          setMenu({ kind: "add", from: current.from, point: worldPoint(at), anchor: localPoint(at) });
        }
      }
    } else if (current.kind === "wire" && current.moved) {
      editor?.moveWire(current.wire.selection, { x: current.base.x + (at.x - current.screen.x) / viewport.zoom, y: current.base.y + (at.y - current.screen.y) / viewport.zoom });
    } else if (current.kind === "marquee" && current.moved) {
      const a = worldPoint(current.screen), b = worldPoint(at);
      const ids = positions.filter(({ node, position, size }) => !node.id.startsWith("$") &&
        position.x < Math.max(a.x, b.x) && position.x + size.width > Math.min(a.x, b.x) && position.y < Math.max(a.y, b.y) && position.y + size.height > Math.min(a.y, b.y)).map(row => row.node.id);
      const selection = current.extend ? [...new Set([...multiple, ...(selected ? [selected] : []), ...ids])] : ids;
      setMultiple(selection); onSelect(selection[0] ?? "");
    } else if (current.kind === "pan" && !current.moved && current.nodeId && !link) {
      onSelect(current.nodeId);
      setMultiple([]);
    } else if ((current.kind === "pan" || current.kind === "marquee") && !current.moved && design) {
      if (link) setMenu({ kind: "add", from: link, point: worldPoint(at), anchor: localPoint(at) });
      else onSelect(current.kind === "pan" ? current.nodeId ?? "" : "");
      setLink(undefined); setMultiple([]);
    }
  }
  function openMenu(at: Point, target: Element): void {
    if (!editing || !editor) return;
    setLink(undefined);
    const frame = { anchor: localPoint(at), point: worldPoint(at) };
    const wireKey = target.closest<SVGElement>("[data-wire-key]")?.dataset.wireKey;
    const wire = wireKey && wires.find(wire => wire.key === wireKey);
    if (wire) {
      editor.selectEdge(wire.selection); setMenu({ ...frame, kind: "wire", wire }); return;
    }
    const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    if (id && !id.startsWith("$")) {
      onSelect(id);
      setMenu({ ...frame, kind: "node", id, port: target.closest<HTMLButtonElement>("[data-outlet-id]")?.dataset.outletId || undefined });
    } else setMenu({ ...frame, kind: "add" });
  }
  const withClose = (action: () => void): (() => void) => () => { closeMenu(true); action(); };
  function menuContent(value: Menu): { title: string; actions: MenuAction[] } {
    if (!editor) return { title: "", actions: [] };
    if (value.kind === "add") {
      const actions: MenuAction[] = addableKinds.map(kind => ({
        label: nodeKinds[kind], icon: icons[kind], action: withClose(() => editor.add(kind, value.point, value.from, value.insert)),
      }));
      if (value.from) {
        const from = value.from;
        actions.push({ label: "交回主会话", icon: CornerDownLeft, secondary: true, action: withClose(() => editor.connect(from, "$return")) });
      } else if (!value.insert && editor.canPaste) {
        actions.push({ label: "粘贴节点", icon: ClipboardPaste, secondary: true, action: withClose(() => editor.pasteNode(value.point)) });
      }
      return { title: value.insert ? "在线上插入节点" : value.from ? "添加下一步" : "添加节点", actions };
    }
    if (value.kind === "wire") {
      const { wire } = value;
      return { title: wire.name, actions: [
        { label: "改接目标", icon: Link, action: withClose(() => setLink(wire.selection)) },
        { label: "插入节点", icon: Plus, action: () => setMenu({ ...value, kind: "add", insert: wire.selection, point: wire.center }) },
        ...(layout.edgeRoutes?.[wire.key] ? [{ label: "恢复自动走线", icon: RotateCcw, action: withClose(() => editor.moveWire(wire.selection)) }] : []),
        { label: "删除连线", icon: Trash2, shortcut: "Del", dangerous: true, secondary: true, action: withClose(() => editor.unlink(wire.selection)) },
      ] };
    }
    const row = byId.get(value.id);
    if (!row) return { title: "", actions: [] };
    const free = row.node.exits.find(port => !findEdge(definition, { source: value.id, exit: port.id }));
    if (value.port) {
      const port = row.node.exits.find(port => port.id === value.port);
      if (port) {
        const from = { source: value.id, exit: port.id };
        return { title: port.name, actions: [
          { label: findEdge(definition, from) ? "改接目标" : "连接出口", icon: Link, action: withClose(() => setLink(from)) },
          ...(canRemoveOutlet(row.node, port.id) ? [{ label: "移除出口", icon: Trash2, dangerous: true, action: withClose(() => editor.removeOutlet(value.id, port.id)) }] : []),
        ] };
      }
    }
    const actions: MenuAction[] = [];
    if (row.node.kind !== "join" || !row.node.exits.length || free) {
      actions.push({ label: "添加下一步", icon: Plus, action: () => {
        const next = { x: row.position.x + row.size.width + 165, y: row.position.y + row.size.height / 2 };
        setMenu({ ...value, kind: "add", point: next, from: { source: value.id, exit: free?.id } });
      } });
    }
    if (row.node.kind !== "main") actions.push({ label: "复制节点", icon: Copy, action: withClose(() => editor.copyNode(value.id)) });
    if (value.id !== definition.entry) actions.push({ label: "删除节点", icon: Trash2, shortcut: "Del", dangerous: true, secondary: true, action: withClose(() => editor.removeNode(value.id)) });
    return { title: nodeLabel(row.node), actions };
  }
  const menuView = menu && menuContent(menu);
  const isBlank = definition.nodes.length === 1 && !definition.edges.length && !definition.nodes[0].exits.length;
  const bounds = diagramBounds(positions, wires);
  const selectedRows = positions.filter(row => multiple.includes(row.node.id));
  const batchBypass = selectedRows.length > 1 && selectedRows.every(row => row.node.kind === "agent" && row.node.exits.length === 1 && !row.node.forEach);

  function rename(event: React.FocusEvent<HTMLInputElement>) {
    const value = event.currentTarget.value.trim();
    if (value && renaming?.kind === "node") editor?.renameNode(renaming.id, value);
    if (value && renaming?.kind === "wire") {
      const wire = wires.find(wire => wire.key === renaming.id);
      if (wire) editor?.renameEdge(wire.selection, value);
    }
    setRenaming(undefined);
  }

  const tip = tooltip ? byId.get(tooltip) : undefined;
  return <div ref={board} className="wf-canvas" data-editing={editing} data-pointer={currentMode} data-linking={!!linkingFrom || currentMode === "connect"} data-dragging={dragging} data-lineage={!!family} data-history-frame={!design && !motionLive}
    data-motion-playing={motionPlaying} data-motion-reduced={motionReduced} tabIndex={0} aria-label="工作流画布"
    onKeyDown={event => {
      if ((event.target as Element).closest("input,textarea,[role=menu]")) return;
      if (event.key === "Escape") { setLink(undefined); setMenu(undefined); setMultiple([]); setPointerMode("select"); setPinnedLineage(undefined); }
      if (editing && event.key === "Delete" && multiple.length > 1) { event.preventDefault(); editor?.removeNodes(multiple); setMultiple([]); }
      if (editing && editor?.canPaste && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        const { width, height, left, top } = board.current!.getBoundingClientRect();
        event.preventDefault(); editor.pasteNode(worldPoint({ x: left + width / 2, y: top + height / 2 }));
      }
      if (editing && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        const target = event.target as Element, rect = target.getBoundingClientRect();
        event.preventDefault(); openMenu({ x: rect.left + Math.min(120, rect.width / 2), y: rect.top + Math.min(60, rect.height / 2) }, target);
      }
    }}
    onPointerDown={event => {
      const target = event.target as Element;
      if (event.button !== 0 && event.button !== 1 || target.closest(".wf-dock,.wf-zoom,.wf-context-menu,.wf-minimap,.wf-node-tools,input")) return;
      const pan = !design || currentMode === "pan" || event.button === 1 || event.pointerType === "touch";
      if (!pan && target.closest("button,[data-wire-key]")) return;
      event.currentTarget.focus({ preventScroll: true });
      const start = { screen: screenPoint(event), pointer: event.pointerId, moved: false };
      const nodeId = event.button === 0 ? target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId : undefined;
      begin(event, editing && !link && !pan && currentMode === "select"
        ? { ...start, kind: "marquee", extend: event.shiftKey } : { ...start, kind: "pan", base: viewport, nodeId });
    }}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onContextMenu={event => {
      if (!editing) return;
      event.preventDefault(); openMenu(screenPoint(event), event.target as Element);
    }}>
    <div ref={world} className="wf-world" style={{ transform: "translate(" + viewport.x + "px," + viewport.y + "px) scale(" + viewport.zoom + ")" }}>
      {parallelGroups.map(group => <div className="wf-parallel-frame" key={group.id} style={{ left: group.x, top: group.y, width: group.width, height: group.height }}><span><Layers3 size={11}/>并行分工<i/>{group.members.length} 路</span></div>)}
      <svg className="wf-wires" width="4000" height="2400" aria-hidden={!editing} style={arrowStyles}>
        {guides.map(guide => <g key={guide.axis} className="wf-alignment-guide">
          <line x1={guide.axis === "x" ? guide.at : guide.start} x2={guide.axis === "x" ? guide.at : guide.end}
            y1={guide.axis === "y" ? guide.at : guide.start} y2={guide.axis === "y" ? guide.at : guide.end}/>
          <text x={guide.axis === "x" ? guide.at + 4 : guide.start} y={guide.axis === "y" ? guide.at - 5 : guide.start - 5}>{Math.round(guide.end - guide.start)} px</text>
        </g>)}
        <defs>{arrowTones.map(tone => <marker key={tone} id={`${marker}-${tone}`} viewBox="0 0 10 10" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" refX="8" refY="5" orient="auto"><path className="wf-arrow" data-tone={tone} d="M2 2 L8 5 L2 8"/></marker>)}</defs>
        {wires.map(wire => {
          const used = preview ? preview.visited.has(wire.key) : history.visited.has(wire.key);
          const active = preview ? preview.active.has(wire.key) : liveWires.active.has(wire.key);
          const transfer = eventCues.wires.get(wire.key);
          const sourceCue = eventCues.nodes.get(wire.selection.source);
          const delay = transfer && sourceCue?.kind === "join" && transfer.sequence - sourceCue.sequence === 1 ? 400 : 0;
          const loop = wire.selection.limit || loops.has(wire.index);
          const loopMoving = loop && (active || (used && preview?.nodes.get(wire.target) === "looping"));
          const chosen = selectedWire === wire.key;
          return <g key={wire.key} className={"wf-wire-row" + (active ? " is-active" : used ? " is-used" : "")} data-wire-key={wire.key}
            data-limit={wire.selection.limit} data-loop={loop} data-loop-moving={loopMoving} data-selected={chosen}
            data-focus={focusOf(wire)} data-outlet-hover={wire.key === outletHighlighted} data-outgoing={editing && !previewPlaying && wire.selection.source === selected}>
            <title>{wire.name}</title>
            <path d={wire.path} className="wf-wire"/>
            {!motionReduced && (active || transfer?.once || family && ["upstream","downstream"].includes(focusOf(wire) || "")) && <WorkflowStream key={transfer?.sequence ?? "active"}
              path={wire.path} repeat={!preview && (active || !!family)} playing={motionPlaying} offset={wire.index} duration={preview?.duration} delay={delay}/>}
            {design && editor && <>
              <path className="wf-wire-hit" d={wire.path} role="button" tabIndex={0} aria-label={"连线 " + wire.name} aria-pressed={chosen}
                onPointerDown={event => {
                  if (event.button !== 0 || link) return;
                  if (currentMode === "pan" && !locked) return;
                  event.currentTarget.focus({ preventScroll: true });
                  setMultiple([]);
                  editor.selectEdge(wire.selection);
                  if (!editing) { event.stopPropagation(); return; }
                  const at = screenPoint(event);
                  begin(event, { kind: "wire", wire, screen: at, base: layout.edgeRoutes?.[wire.key] || worldPoint(at), pointer: event.pointerId, moved: false });
                }}
                onKeyDown={event => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault(); editor.selectEdge(wire.selection);
                }}/>
              {editing && currentMode === "select" && <foreignObject className="wf-wire-insert-hit" x={wire.center.x - 10} y={wire.center.y - 10} width={20} height={20}>
                <button type="button" className="wf-wire-insert" aria-label={"插入节点 · " + wire.name} onClick={event => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ kind: "add", insert: wire.selection, point: wire.center, anchor: localPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) });
                }}><Plus size={12}/></button>
              </foreignObject>}
            </>}
          </g>;
        })}
        {linkPreview && <path className="wf-link-preview" data-invalid={linkPreview.invalid} d={drag.current?.kind === "link" && drag.current.reverse ? linkPath(linkPreview.tip, linkPreview.origin) : linkPath(linkPreview.origin, linkPreview.tip)}/>}
        {wires.map(wire => {
          const point = labelPositions.get(wire.key)!;
          return <foreignObject key={wire.key} className="wf-wire-caption" aria-hidden={!editing}
            data-focus={focusOf(wire)} data-loop={wire.selection.limit || loops.has(wire.index)}
            data-highlighted={selectedWire === wire.key || outletHighlighted === wire.key || (editing && !previewPlaying && wire.selection.source === selected) || preview?.active.has(wire.key)}
            x={point.x - wireLabelWidth / 2} y={point.y - wireLabelHeight / 2} width={wireLabelWidth} height={wireLabelHeight}>
            <div>{renaming?.kind === "wire" && renaming.id === wire.key ? <input className="wf-inline-rename" aria-label="编辑连线名称" autoFocus defaultValue={renaming.name} onBlur={rename} onKeyDown={event => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { event.stopPropagation(); setRenaming(undefined); }
            }}/> : <span className="wf-edge-label" data-label-key={wire.key} data-wire-key={wire.key} onDoubleClick={() => {
              if (editing) setRenaming({ kind: "wire", id: wire.key, name: byId.get(wire.selection.source)?.node.exits.find(exit => exit.id === wire.selection.exit)?.name ?? "" });
            }}>{wire.name}</span>}</div>
          </foreignObject>;
        })}
      </svg>
      {positions.map(row => {
        const { node, position, size } = row;
        const nodeInstances = byNode.get(node.id) ?? [];
        const runningInstance = nodeInstances.find(activeInstance);
        const instance = runningInstance ?? nodeInstances.at(-1);
        const assignment = instance?.sessionId ? assignments?.[node.id] : undefined;
        const returned = history.returned.has(node.id);
        const runStatus = instance?.status ?? (returned ? (node.id === "$return" ? "completed" : "needs_decision") : undefined);
        const motionState: MotionNodeState = preview?.nodes.get(node.id) ?? (runningInstance
          ? (liveWires.looping.has(node.id) ? "looping" : "running") : runStatus === "completed" ? "success" : "idle");
        const running = motionState === "running" || motionState === "looping";
        const cue = preview?.cues.get(node.id) ?? eventCues.nodes.get(node.id);
        const status = preview ? (preview.waiting.has(node.id) ? "waiting_join" : running ? "running" : motionState === "success" ? "completed" : undefined) : runStatus;
        const tone = nodeTone(node);
        const Icon = node.id.startsWith("$") ? CornerDownLeft : node.kind === "agent" && tone === "amber" ? ScanEye : icons[node.kind];
        const completed = nodeInstances.filter(instance => instance.status === "completed").length;
        const nodeIssues = issues.filter(issue => issue.nodeId === node.id);
        const nodeIssue = nodeIssues.some(issue => !issue.warning) ? "error" : nodeIssues.length ? "warning" : undefined;
        const free = node.exits.find(port => !findEdge(definition, { source: node.id, exit: port.id }));
        const plus = editing && editor && !node.id.startsWith("$") && (node.kind !== "join" || !node.exits.length);
        const target = linkPreview?.target === node.id;
        const joinProgress = instance?.status === "waiting_join" ? instance.incoming as { received: number; required: number } : undefined;
        const statusText = joinProgress ? `${joinProgress.received}/${joinProgress.required} 已到达`
          : nodeInstances.some(item => item.item !== undefined) ? `已交 ${completed}/${nodeInstances.length}` : statusLabels[status ?? ""];
        return <div key={node.id} data-node-id={node.id} className={"wf-node wf-node-" + node.kind + (node.id.startsWith("$") ? " wf-return" : "")}
          data-tone={tone} data-selected={node.id === selected || multiple.includes(node.id)} data-status={status} data-motion-state={motionState} data-hovered={focused === node.id}
          data-bypass={node.bypass} data-lineage={family && (node.id === focused || family.before.has(node.id) ? "upstream" : family.after.has(node.id) ? "downstream" : "far")}
          data-issue={nodeIssue} data-drop-target={target} data-assigned={!!assignment || undefined} data-drop-invalid={linkPreview?.invalid && linkingFrom?.source === node.id || undefined}
          style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
          onPointerEnter={event => {
            if (design && event.pointerType !== "touch" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) setHovered(node.id);
          }} onPointerLeave={() => setHovered(current => current === node.id ? undefined : current)}>
          <div className="wf-node-plate" aria-hidden="true">
            {running && !motionReduced && <span className="wf-node-beam"/>}
            {motionState === "success" && cue && !motionReduced && <span key={cue.sequence} className={cue.kind === "join" ? "wf-join-ripple" : "wf-node-flash"}/>}
          </div>
          <span className="wf-focus-ring" aria-hidden/>
          <button className="wf-node-body" type="button" aria-pressed={node.id === selected || multiple.includes(node.id)} title={nodeLabel(node)}
            onDoubleClick={() => { if (editing && !node.id.startsWith("$")) setRenaming({ kind: "node", id: node.id, name: nodeLabel(node) }); }}
            onClick={event => {
              if (editing && event.detail !== 0) return;
              if (link && link.source !== node.id) { editor?.connect(link, node.id); setLink(undefined); }
              else onSelect(node.id);
            }}
            onPointerDown={event => {
              if (!editing || event.button !== 0 || currentMode === "pan") return;
              if (currentMode === "connect" && !node.id.startsWith("$") && !link) {
                const port = free?.id ?? (node.exits.length === 1 ? node.exits[0].id : undefined);
                startLink(event, { source: node.id, exit: port }, outputPoint(row, port));
                return;
              }
              if (link) { editor?.connect(link, node.id); setLink(undefined); return; }
              event.currentTarget.focus({ preventScroll: true });
              if (event.shiftKey) {
                const ids = multiple.length ? multiple : selected ? [selected] : [];
                const next = ids.includes(node.id) ? ids.filter(id => id !== node.id) : [...ids, node.id];
                setMultiple(next); onSelect(next.at(-1) ?? ""); return;
              }
              const rows = multiple.includes(node.id) ? selectedRows : [row];
              if (rows.length === 1) setMultiple([]);
              onSelect(node.id);
              drag.current = { kind: "node", id: node.id, rows, groups: parallelGroups, screen: screenPoint(event), pointer: event.pointerId, moved: false };
              event.stopPropagation();
            }}
            onKeyDown={event => {
              if (!editing || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault(); onSelect(node.id);
              const distance = event.shiftKey ? 20 : 4;
              onMove(node.id, position.x + (event.key === "ArrowRight" ? distance : event.key === "ArrowLeft" ? -distance : 0), position.y + (event.key === "ArrowDown" ? distance : event.key === "ArrowUp" ? -distance : 0));
              onMoveEnd();
            }}>
            <span className="wf-node-content">
              <span className="wf-node-icon"><Icon size={19}/>{running && <i className="wf-node-breath" aria-hidden="true"/>}</span>
              <span className="wf-node-copy"><strong>{nodeLabel(node)}</strong>
                {assignment ? <small className="wf-node-engine" title={[assignment.providerId && providerMeta(assignment.providerId).name, assignment.model].filter(Boolean).join(" · ")}>
                  {assignment.providerId && <ProviderAvatar providerId={assignment.providerId} size="sm"/>}<span>{assignment.model || "原生默认模型"}</span>
                </small> : <small>{node.bypass ? "已跳过" : node.role || (node.kind === "main" ? "当前会话" : node.kind === "dispatch" ? "自动分发" : node.kind === "join" ? "" : nodeKinds[node.kind])}</small>}
              </span>
            </span>
          </button>
          {renaming?.kind === "node" && renaming.id === node.id && <input className="wf-inline-rename wf-node-rename" aria-label="行内编辑节点名称" autoFocus defaultValue={renaming.name} onBlur={rename} onKeyDown={event => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") { event.stopPropagation(); setRenaming(undefined); }
          }}/>}
          {editing && node.kind === "agent" && <div className="wf-node-tools">
            <button type="button" title="克隆" aria-label="克隆此节点" onClick={() => editor?.cloneNode(node.id)}><Copy size={12}/></button>
            {node.exits.length === 1 && !node.forEach && <button type="button" title={node.bypass ? "恢复执行" : "跳过执行"} aria-label={node.bypass ? "恢复执行" : "跳过执行"} onClick={() => editor?.bypassNodes([node.id])}><SkipForward size={12}/></button>}
            <button type="button" title="查看上下游血缘" aria-label="查看上下游血缘" aria-pressed={pinnedLineage === node.id} onClick={() => setPinnedLineage(pinnedLineage === node.id ? undefined : node.id)}><GitFork size={12}/></button>
            <button type="button" title="删除" aria-label="删除此节点" onClick={() => editor?.removeNode(node.id)}><Trash2 size={12}/></button>
          </div>}
          {editing && nodeIssue && <i className="wf-node-issue" title={nodeIssues[0].message} aria-label={nodeIssues[0].message}/>}
          {status && !(node.kind === "join" && status === "completed") && <span className="wf-node-state" title={statusText} aria-label={statusText}>
            {status === "completed" ? <span className="wf-success-mark" data-flash={!!cue && !motionReduced} key={cue?.sequence}><Check size={10}/></span>
              : status === "failed" ? <X size={10}/>
              : status === "waiting_submission" ? <BellRing size={10}/> : <Circle size={8}/>}
            {status === "completed" && !preview && instance?.completedAt != null && !node.bypass ? `${((instance.completedAt - instance.createdAt) / 1000).toFixed(1)}s` : ""}
            {status !== "completed" && status !== "failed" && statusText}
            {instance && instance.item === undefined && instance.iteration > 1 ? " ×" + instance.iteration : ""}
          </span>}
          {(target || editing && node.id !== definition.entry) && <span className={target ? "wf-input-magnet" : "wf-input-socket"} aria-hidden="true"/>}
          {editing && node.exits.map(port => {
            const issue = issues.find(issue => issue.nodeId === node.id && issue.exitId === port.id);
            const from = { source: node.id, exit: port.id };
            const point = outputPoint(row, port.id);
            return <button key={port.id} type="button" className="wf-port" data-outlet-id={port.id} data-issue={!!issue}
              data-linking={linkingFrom?.source === node.id && linkingFrom.exit === port.id} style={{ top: point.y - position.y }}
              aria-label={nodeLabel(node) + "的出口 " + port.name} title={issue?.message || "拖动 " + port.name + " 改接"}
              onPointerDown={event => startLink(event, from, point)}
              onClick={event => { if (event.detail === 0) setLink(from); }}><span className="wf-port-face" aria-hidden="true"/></button>;
          })}
          {plus && <button type="button" className="wf-port-new"
            aria-label={"从" + nodeLabel(node) + "拖出下一步"} title="拖到节点连接，拖到空白添加下一步"
            onPointerDown={event => startLink(event, { source: node.id, exit: free?.id }, outputPoint(row, free?.id))}
            onClick={event => { if (event.detail === 0) setLink({ source: node.id, exit: free?.id }); }}><Plus size={12}/></button>}
        </div>;
      })}
      {editing && editor && selectedWire && wires.filter(wire => wire.key === selectedWire).map(wire =>
        <div key={wire.key}><button type="button" className="wf-wire-end" data-wire-key={wire.key}
          style={{ left: wire.end.x, top: wire.end.y }} title="拖动端点改接" aria-label={"改接 " + wire.name}
          onPointerDown={event => startLink(event, wire.selection, wire.start)}
          onClick={event => { if (event.detail === 0) setLink(wire.selection); }}/>
          {!wire.selection.limit && <button type="button" className="wf-wire-end" title="拖动端点改接起点" aria-label={"改接起点 " + wire.name}
            style={{ left: wire.start.x, top: wire.start.y }} onPointerDown={event => {
              if (event.button === 0) begin(event, { kind: "link", from: wire.selection, reverse: wire.selection, origin: wire.end, screen: screenPoint(event), pointer: event.pointerId, moved: false });
            }}/>}
        </div>)}
    </div>
    {marquee && <div className="wf-marquee" style={{ left: Math.min(marquee.start.x, marquee.end.x), top: Math.min(marquee.start.y, marquee.end.y), width: Math.abs(marquee.start.x - marquee.end.x), height: Math.abs(marquee.start.y - marquee.end.y) }}/>}
    {editor && editing && selectedRows.length > 1 && <div className="wf-batch" style={{
      top: Math.max(8, Math.min(...selectedRows.map(row => row.position.y)) * viewport.zoom + viewport.y - 42),
    }}>
      <button type="button" onClick={() => editor.arrangeNodes(multiple, "horizontal")}>水平对齐</button>
      <button type="button" onClick={() => editor.arrangeNodes(multiple, "vertical")}>垂直对齐</button>
      <button type="button" onClick={() => editor.arrangeNodes(multiple, "parallel")}>打包并行分工</button>
      {batchBypass && <button type="button" onClick={() => editor.bypassNodes(multiple)}>{selectedRows.every(row => row.node.bypass) ? "批量恢复" : "批量跳过"}</button>}
      <button type="button" onClick={() => { editor.removeNodes(multiple); setMultiple([]); }}>删除</button>
    </div>}
    {isBlank && editing && !link && !linkPreview && !menu && <div className="wf-starters" aria-label="起手模板">
      {starterKinds.map(kind => <button key={kind.id} type="button" onClick={() => {
        editor?.startFrom(kind.id);
        requestAnimationFrame(() => {
          fitting.current();
          if (motionReduced) return;
          board.current?.querySelectorAll<HTMLElement>(".wf-node:not(.wf-node-main)").forEach((node, index) => node.animate([
            { opacity: 0, translate: "0 6px" }, { opacity: 1, translate: "0 0" },
          ], { delay: index * 30, duration: 200, fill: "backwards", easing: "cubic-bezier(.22,1,.36,1)" }));
        });
      }}><Workflow size={13}/>{kind.label}</button>)}
    </div>}
    {link && <div className="wf-link-notice" role="status"><Link size={13}/>选择目标节点，或在空白处添加下一步<button type="button" onClick={() => setLink(undefined)}>取消 <kbd>Esc</kbd></button></div>}
    {design && <div className="wf-dock" role="toolbar" aria-label="画布工具">
      <div className="wf-pointer-modes" role="group" aria-label="指针模式" style={{ "--wf-pointer": pointerTools.findIndex(tool => tool.id === currentMode) } as CSSProperties}>
        <i aria-hidden/>
        {pointerTools.map(({ id, key, label, icon: Icon }) => <button type="button" key={id} aria-label={label} aria-keyshortcuts={key} aria-pressed={currentMode === id} disabled={locked && id !== "pan"}
          onClick={() => { setPointerMode(id); setLink(undefined); setMenu(undefined); }}>
          <Icon size={16}/><span className="wf-dock-tooltip">{label}<kbd>{key}</kbd></span>
        </button>)}
      </div>
      <i className="wf-toolbar-divider" aria-hidden/>
      <button type="button" aria-label="锁定画布" aria-keyshortcuts="L" aria-pressed={locked} data-lock onClick={() => onLockChange?.(!locked)}>{locked ? <Lock size={15}/> : <Unlock size={15}/>}
        <span className="wf-dock-tooltip">{locked ? "解锁画布" : "锁定画布"}<kbd>L</kbd></span>
      </button>
      <i className="wf-toolbar-divider" aria-hidden/>
      {children}
    </div>}
    {preview && <span className="wf-preview-status" role="status">{previewPlaying ? "正在预览" : "预览完成"}</span>}
    <div className="wf-zoom"><button aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}><Minus size={14}/></button><button aria-label="缩放重置为 100%" onClick={() => zoomBy(1 / viewport.zoom)}><output>{Math.round(viewport.zoom * 100)}%</output></button><button aria-label="放大" onClick={() => zoomBy(1.2)}><Plus size={14}/></button><i/><button aria-label="适应画布" onClick={fit}><Scan size={14}/></button>
      {design && !isBlank && <button type="button" title="小地图" aria-label="小地图" aria-expanded={minimap} onClick={() => setMinimap(!minimap)}><Layers3 size={13}/></button>}
    </div>
    {design && !isBlank && minimap && <div className="wf-minimap">
      <svg viewBox={`${bounds.left - 30} ${bounds.top - 30} ${bounds.width + 60} ${bounds.height + 60}`} aria-label="小地图定位"
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); recenterMinimap(event); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) recenterMinimap(event); }}>
        {wires.map(wire => <path key={wire.key} d={wire.path}/>)}
        {positions.map(({ node, position, size }) => <rect key={node.id} data-current={node.id === selected} x={position.x} y={position.y} width={size.width} height={size.height} rx={8}/>)}
        <rect className="wf-minimap-viewport" x={-viewport.x / viewport.zoom} y={-viewport.y / viewport.zoom} width={(board.current?.clientWidth ?? 0) / viewport.zoom} height={(board.current?.clientHeight ?? 0) / viewport.zoom}/>
      </svg>
    </div>}
    {tip?.node.kind === "agent" && <aside className="wf-node-tooltip" role="tooltip" style={{
      left: Math.max(8, Math.min((board.current?.clientWidth ?? 250) - 246, viewport.x + (tip.position.x + tip.size.width) * viewport.zoom + 10)),
      top: Math.max(8, Math.min((board.current?.clientHeight ?? 190) - 184, viewport.y + tip.position.y * viewport.zoom)),
    }}>
      <strong>{nodeLabel(tip.node)}</strong>
      <dl>
        <div><dt>产出字段</dt><dd title={Object.entries(tip.node.outputDescriptions ?? {}).map(([name, description]) => name + " · " + description).join("\n")}>
          {Object.entries(tip.node.outputs ?? {}).map(([name, type]) => name + (typeof type === "string" && type.startsWith("list<") ? "[]" : "")).join(" · ") || "未声明"}</dd></div>
        <div><dt>重试</dt><dd>{(tip.node.maxAttempts ?? 1) - 1} 次</dd></div>
        <div><dt>会话</dt><dd>{tip.node.session === "reuse" ? "复用会话" : "每次新建"}</dd></div>
        <div><dt>路径权限</dt><dd>{tip.node.workspace?.allowedPaths?.join(" · ") || (tip.node.workspace?.mode === "isolated" ? "独立工作区" : "沿用项目设置")}</dd></div>
      </dl>
      {tip.node.prompt && <p>{tip.node.prompt}</p>}
    </aside>}
    {menu && menuView?.actions.length ? <WorkflowMenu key={menuView.title} title={menuView.title} anchor={menu.anchor} actions={menuView.actions} close={closeMenu} searchable={menu.kind === "add"}/> : null}
  </div>;

  function recenterMinimap(event: ReactPointerEvent<SVGSVGElement>) {
    const element = board.current!;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    setViewport(current => ({ ...current, x: element.clientWidth / 2 - point.x * current.zoom, y: element.clientHeight / 2 - point.y * current.zoom }));
  }
}
