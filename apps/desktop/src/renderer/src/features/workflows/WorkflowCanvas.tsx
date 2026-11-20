import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Activity, BellRing, Check, Circle, ClipboardPaste, Copy, CornerDownLeft, GitFork, GitMerge, Layers3, Link, Minus, Orbit, Plus, RotateCcw, Scan, ScanEye, Trash2, Workflow } from "lucide-react";
import type { WorkflowDefinition, WorkflowLayout, WorkflowInstance, WorkflowEvent, WorkflowIssue } from "@agenthub/domain";
import { addableKinds, canRemoveOutlet, type AddableKind } from "./workflow-editing";
import { diagramBounds, diagramWires, edgeKey, findEdge, inputPoint, linkPath, loopEdges, outputPoint, placeNodes, wireLabelHeight, wireLabelPositions, wireLabelWidth, type Connection, type DiagramWire, type EdgeSelection, type Point } from "./workflow-geometry";
import { nodeKinds, nodeLabel, nodeTone, statusLabels } from "./workflow-model";
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
  locate?: { nodeId: string; exitId?: string; request: number; reveal?: boolean };
}
const icons = { main: Orbit, dispatch: GitFork, agent: Activity, join: GitMerge, condition: Layers3, call: Workflow };
const arrowTones = ["normal", "focus", "selected", "loop", "loop-focus", "active"] as const;
const activeInstance = (instance: WorkflowInstance) => instance.status === "starting" || instance.status === "running" || instance.status === "verifying";

type Drag = {
  pointer: number; screen: Point; moved: boolean;
} & (
  | { kind: "pan"; base: Point }
  | { kind: "node"; id: string; base: Point }
  | { kind: "wire"; wire: DiagramWire; base: Point }
  | { kind: "link"; from: Connection; origin: Point }
);

type Menu = { anchor: Point; point: Point } & (
  | { kind: "add"; from?: Connection; insert?: EdgeSelection }
  | { kind: "node"; id: string; port?: string }
  | { kind: "wire"; wire: DiagramWire }
);

export function WorkflowCanvas({ definition, layout, selected, editing, instances, events, onSelect, onMove, onMoveEnd, editor,
  motionPlaying, motionLive, motionReduced, libraryCollapsed, preview, previewPlaying, issues = [], locate }: Props): JSX.Element {
  const board = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const viewMotion = useRef<Animation>();
  const measureCanvas = useRef<() => void>();
  const pane = useRef({ libraryCollapsed, motionReduced });
  pane.current = { libraryCollapsed, motionReduced };
  const [viewport, setViewport] = useState({ x: 20, y: 20, zoom: 1 });
  const [link, setLink] = useState<Connection>();
  const [linkPreview, setLinkPreview] = useState<{ origin: Point; tip: Point; target?: string }>();
  const [wirePreview, setWirePreview] = useState<{ key: string; point: Point }>();
  const [menu, setMenu] = useState<Menu>();
  const [hovered, setHovered] = useState<string>();
  const [dragging, setDragging] = useState<Drag["kind"]>();
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
  const focused = editing && !previewPlaying && !dragging && !link && !menu ? hovered : undefined;
  const focusOf = (wire: DiagramWire) => focused ? (wire.selection.source === focused || wire.target === focused ? "near" : "far") : undefined;
  const linkingFrom = drag.current?.kind === "link" ? drag.current.from : link;
  const parallelGroups = useMemo(() => definition.nodes.filter(node => node.kind === "main" || node.kind === "dispatch" || node.dispatch === "all").flatMap(node => {
    const targets = definition.edges.filter(edge => edge.from[0] === node.id).map(edge => byId.get(edge.to)).filter(row => row?.node.kind === "agent");
    if (targets.length < 2) return [];
    const x = Math.min(...targets.map(row => row!.position.x)) - 23, y = Math.min(...targets.map(row => row!.position.y)) - 35;
    return [{ id: node.id, x, y, width: Math.max(...targets.map(row => row!.position.x + row!.size.width)) - x + 23, height: Math.max(...targets.map(row => row!.position.y + row!.size.height)) - y + 25, count: targets.length }];
  }), [definition, byId]);
  const fit = (): void => {
    if (!board.current) return;
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
    setHovered(undefined); setDragging(undefined); drag.current = undefined;
  }, [editing, definition.id]);
  useEffect(() => {
    const row = locate && byId.get(locate.nodeId);
    const element = board.current;
    if (!row || !element) return;
    const point = locate.exitId ? outputPoint(row, locate.exitId) : { x: row.position.x + row.size.width / 2, y: row.position.y + row.size.height / 2 };
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
    let distance = 11 / viewport.zoom, target: string | undefined;
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
    if (event.button !== 0) return;
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
      setLinkPreview({ origin: current.origin, tip: row ? inputPoint(row) : worldPoint(at), target });
    } else if (current.kind === "node") {
      onMove(current.id, current.base.x + dx / viewport.zoom, current.base.y + dy / viewport.zoom);
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
    setLinkPreview(undefined); setWirePreview(undefined);
    if (current.kind === "node") onMoveEnd();
    if (cancelled) return;
    const at = screenPoint(event);
    if (current.kind === "link") {
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
    } else if (current.kind === "pan" && !current.moved && editing) {
      if (link) setMenu({ kind: "add", from: link, point: worldPoint(at), anchor: localPoint(at) });
      else onSelect("");
      setLink(undefined);
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

  return <div ref={board} className="wf-canvas" data-editing={editing} data-linking={!!linkingFrom} data-dragging={dragging}
    data-motion-playing={motionPlaying} data-motion-reduced={motionReduced} tabIndex={0} aria-label="工作流画布"
    onKeyDown={event => {
      if (event.key === "Escape") { setLink(undefined); setMenu(undefined); }
      if (editor?.canPaste && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        const { width, height, left, top } = board.current!.getBoundingClientRect();
        event.preventDefault(); editor.pasteNode(worldPoint({ x: left + width / 2, y: top + height / 2 }));
      }
      if (editing && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        const target = event.target as Element, rect = target.getBoundingClientRect();
        event.preventDefault(); openMenu({ x: rect.left + Math.min(120, rect.width / 2), y: rect.top + Math.min(60, rect.height / 2) }, target);
      }
    }}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest("button, input, [data-wire-key]")) return;
      event.currentTarget.focus({ preventScroll: true });
      begin(event, { kind: "pan", screen: screenPoint(event), pointer: event.pointerId, base: viewport, moved: false });
    }}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onContextMenu={event => {
      if (!editing) return;
      event.preventDefault(); openMenu(screenPoint(event), event.target as Element);
    }}>
    <div ref={world} className="wf-world" style={{ transform: "translate(" + viewport.x + "px," + viewport.y + "px) scale(" + viewport.zoom + ")" }}>
      {parallelGroups.map(group => <div className="wf-parallel-frame" key={group.id} style={{ left: group.x, top: group.y, width: group.width, height: group.height }}><span><Layers3 size={11}/>并行分工<i/>{group.count} 路</span></div>)}
      <svg className="wf-wires" width="4000" height="2400" aria-hidden={!editing} style={arrowStyles}>
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
            data-focus={focusOf(wire)} data-outgoing={editing && !previewPlaying && wire.selection.source === selected}>
            <title>{wire.name}</title>
            <path d={wire.path} className="wf-wire"/>
            {!motionReduced && (active || transfer?.once) && <WorkflowStream key={transfer?.sequence ?? "active"}
              path={wire.path} repeat={!preview && active} playing={motionPlaying} offset={wire.index} duration={preview?.duration} delay={delay}/>}
            {editing && editor && <>
              <path className="wf-wire-hit" d={wire.path} role="button" tabIndex={0} aria-label={"连线 " + wire.name} aria-pressed={chosen}
                onPointerDown={event => {
                  if (event.button !== 0 || link) return;
                  event.currentTarget.focus({ preventScroll: true });
                  editor.selectEdge(wire.selection);
                  const at = screenPoint(event);
                  begin(event, { kind: "wire", wire, screen: at, base: layout.edgeRoutes?.[wire.key] || worldPoint(at), pointer: event.pointerId, moved: false });
                }}
                onKeyDown={event => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault(); editor.selectEdge(wire.selection);
                }}/>
              {chosen && <circle className="wf-wire-bend" cx={wire.center.x} cy={wire.center.y} r={5.5} aria-hidden="true"/>}
            </>}
          </g>;
        })}
        {linkPreview && <path className="wf-link-preview" d={linkPath(linkPreview.origin, linkPreview.tip)}/>}
        {wires.map(wire => {
          const point = labelPositions.get(wire.key)!;
          return <foreignObject key={wire.key} className="wf-wire-caption" aria-hidden="true"
            data-focus={focusOf(wire)} data-loop={wire.selection.limit || loops.has(wire.index)}
            data-highlighted={selectedWire === wire.key || (editing && !previewPlaying && wire.selection.source === selected) || preview?.active.has(wire.key)}
            x={point.x - wireLabelWidth / 2} y={point.y - wireLabelHeight / 2} width={wireLabelWidth} height={wireLabelHeight}>
            <div><span className="wf-edge-label" data-label-key={wire.key}>{wire.name}</span></div>
          </foreignObject>;
        })}
      </svg>
      {positions.map(row => {
        const { node, position, size } = row;
        const nodeInstances = byNode.get(node.id) ?? [];
        const runningInstance = nodeInstances.find(activeInstance);
        const instance = runningInstance ?? nodeInstances.at(-1);
        const returned = history.returned.has(node.id);
        const runStatus = instance?.status ?? (returned ? (node.id === "$return" ? "completed" : "needs_decision") : undefined);
        const motionState: MotionNodeState = preview?.nodes.get(node.id) ?? (runningInstance
          ? (liveWires.looping.has(node.id) ? "looping" : "running") : runStatus === "completed" ? "success" : "idle");
        const running = motionState === "running" || motionState === "looping";
        const cue = preview?.cues.get(node.id) ?? eventCues.nodes.get(node.id);
        const status = preview ? (preview.waiting.has(node.id) ? "waiting_join" : running ? "running" : motionState === "success" ? "completed" : undefined) : runStatus;
        const tone = nodeTone(node);
        const Icon = tone === "emerald" ? CornerDownLeft : tone === "amber" ? ScanEye : icons[node.kind];
        const completed = nodeInstances.filter(instance => instance.status === "completed").length;
        const nodeIssue = issues.some(issue => !issue.exitId && issue.nodeId === node.id);
        const free = node.exits.find(port => !findEdge(definition, { source: node.id, exit: port.id }));
        const plus = editing && editor && !node.id.startsWith("$") && (node.kind !== "join" || !node.exits.length);
        const target = linkPreview?.target === node.id;
        const joinProgress = instance?.status === "waiting_join" ? instance.incoming as { received: number; required: number } : undefined;
        const statusText = joinProgress ? `${joinProgress.received}/${joinProgress.required} 已到达`
          : nodeInstances.some(item => item.item !== undefined) ? `已交 ${completed}/${nodeInstances.length}` : statusLabels[status ?? ""];
        return <div key={node.id} data-node-id={node.id} className={"wf-node wf-node-" + node.kind + (node.id.startsWith("$") ? " wf-return" : "")}
          data-tone={tone} data-selected={node.id === selected} data-status={status} data-motion-state={motionState} data-hovered={focused === node.id}
          data-issue={nodeIssue} data-drop-target={target}
          style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
          onPointerEnter={event => {
            if (editing && event.pointerType !== "touch" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) setHovered(node.id);
          }} onPointerLeave={() => setHovered(current => current === node.id ? undefined : current)}>
          <div className="wf-node-plate" aria-hidden="true">
            {running && !motionReduced && <span className="wf-node-beam"/>}
            {motionState === "success" && cue && !motionReduced && <span key={cue.sequence} className={cue.kind === "join" ? "wf-join-ripple" : "wf-node-flash"}/>}
          </div>
          <button className="wf-node-body" type="button" aria-pressed={node.id === selected} title={nodeLabel(node)}
            onClick={() => {
              if (link && link.source !== node.id) { editor?.connect(link, node.id); setLink(undefined); }
              else onSelect(node.id);
            }}
            onPointerDown={event => {
              if (!editing || event.button !== 0 || link) return;
              event.currentTarget.focus({ preventScroll: true });
              onSelect(node.id);
              begin(event, { kind: "node", id: node.id, screen: screenPoint(event), base: position, pointer: event.pointerId, moved: false });
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
              <span className="wf-node-copy"><strong>{nodeLabel(node)}</strong><small>{node.role || (node.kind === "main" ? "当前会话" : node.kind === "dispatch" ? "自动分发" : node.kind === "join" ? "" : nodeKinds[node.kind])}</small></span>
            </span>
          </button>
          {status && <span className="wf-node-state">
            {status === "completed" ? <span className="wf-success-mark" data-flash={!!cue && !motionReduced} key={cue?.sequence}><Check size={10}/></span>
              : status === "waiting_submission" ? <BellRing size={10}/> : <Circle size={8}/>} {motionState === "looping" ? "复核回环" : statusText}
            {instance && instance.item === undefined && instance.iteration > 1 ? " · " + instance.iteration : ""}
          </span>}
          {target && <span className="wf-input-magnet" aria-hidden="true"/>}
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
        <button type="button" key={wire.key} className="wf-wire-end" data-wire-key={wire.key}
          style={{ left: wire.end.x, top: wire.end.y }} title="拖动端点改接" aria-label={"改接 " + wire.name}
          onPointerDown={event => startLink(event, wire.selection, wire.start)}
          onClick={event => { if (event.detail === 0) setLink(wire.selection); }}/>)}
    </div>
    {isBlank && editing && !link && !linkPreview && !menu && <div className="wf-canvas-hint">从 + 拖出第一条线</div>}
    {link && <div className="wf-link-notice" role="status"><Link size={13}/>选择目标节点，或在空白处添加下一步<button type="button" onClick={() => setLink(undefined)}>取消 <kbd>Esc</kbd></button></div>}
    <div className="wf-zoom"><button aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}><Minus size={14}/></button><output>{Math.round(viewport.zoom * 100)}%</output><button aria-label="放大" onClick={() => zoomBy(1.2)}><Plus size={14}/></button><i/><button aria-label="适应画布" onClick={fit}><Scan size={14}/></button></div>
    {menu && menuView?.actions.length ? <WorkflowMenu title={menuView.title} anchor={menu.anchor} actions={menuView.actions} close={closeMenu}/> : null}
  </div>;
}
