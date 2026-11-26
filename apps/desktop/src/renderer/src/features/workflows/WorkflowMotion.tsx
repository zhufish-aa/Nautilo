import { useLayoutEffect, useRef, useState } from "react";
import type { WorkflowDefinition, WorkflowEvent } from "@agenthub/domain";
import { edgeKey } from "./workflow-geometry";
import type { MotionCue } from "./workflow-motion-preview";

export function traversedWire(definition: WorkflowDefinition, event: WorkflowEvent): string | undefined {
  if (event.type !== "edge.traversed") return;
  const { edgeIndex, target } = (event.data ?? {}) as { edgeIndex?: number; target?: string };
  const edge = edgeIndex !== undefined && definition.edges[edgeIndex];
  if (!edge || !target || (target !== edge.to && target !== edge.onLimit)) return;
  return edgeKey({ source: edge.from[0], exit: edge.from[1], limit: target !== edge.to });
}

export function returnedTarget(event: WorkflowEvent): string | undefined {
  if (event.type !== "workflow.returned") return;
  const target = (event.data as { target?: string } | undefined)?.target;
  return target === "$return" || target === "$return_needs_decision" ? target : undefined;
}

interface EventMotion {
  nodes: ReadonlyMap<string, MotionCue>;
  wires: ReadonlyMap<string, { sequence: number; once: boolean }>;
}
const noCues: EventMotion = { nodes: new Map(), wires: new Map() };

export function useWorkflowEventMotion(
  definition: WorkflowDefinition, events: WorkflowEvent[], activeWires: ReadonlySet<string>,
  source: "editor" | "live" | "history", playing: boolean, reduced: boolean,
) {
  const cursor = useRef<{ sequence: number; source: typeof source }>();
  const [cues, setCues] = useState(noCues);
  useLayoutEffect(() => {
    const previous = cursor.current;
    const sequence = events.at(-1)?.sequence;
    cursor.current = sequence === undefined ? undefined : { sequence, source };
    if (source === "editor" || reduced || !previous || previous.source !== source || sequence === undefined || sequence < previous.sequence) {
      setCues(noCues);
      return;
    }
    if (sequence === previous.sequence) return;
    if (!playing) {
      setCues(noCues);
      return;
    }
    setCues(current => {
      const nodes = new Map(current.nodes), wires = new Map(current.wires);
      for (let index = events.length - 1; index >= 0 && events[index].sequence > previous.sequence; index--) {
        const event = events[index];
        const wire = traversedWire(definition, event);
        if (wire && (wires.get(wire)?.sequence ?? 0) < event.sequence) wires.set(wire, { sequence: event.sequence, once: !activeWires.has(wire) });
        const target = returnedTarget(event);
        const id = event.nodeId || (target === "$return" ? target : undefined);
        if (!id || event.sequence <= (nodes.get(id)?.sequence ?? 0)) continue;
        if (event.type === "join.completed") nodes.set(id, { kind: "join", sequence: event.sequence });
        if (event.type === "node.completed" || target === "$return") nodes.set(id, { kind: "success", sequence: event.sequence });
      }
      return { nodes, wires };
    });
  }, [definition, events, activeWires, source, playing, reduced]);
  return cues;
}

export function WorkflowStream({ path, repeat, playing, offset, duration, delay = 0 }: {
  path: string; repeat: boolean; playing: boolean; offset: number; duration?: number; delay?: number;
}) {
  const line = useRef<SVGPathElement>(null), dot = useRef<SVGGElement>(null);
  const motion = useRef<Animation>();
  const shouldPlay = useRef(playing);
  shouldPlay.current = playing;
  useLayoutEffect(() => {
    const route = line.current, particle = dot.current;
    if (!route || !particle) return;
    const length = route.getTotalLength();
    if (!length) return;
    const sampleCount = Math.min(72, Math.max(24, Math.ceil(length / 9)));
    const time = duration ?? (repeat ? Math.min(3200, Math.max(1400, length * 6)) : Math.min(1200, Math.max(550, length * 4)));
    let angle = 0;
    const frames = Array.from({ length: sampleCount + 1 }, (_, index) => {
      const position = length * index / sampleCount;
      const point = route.getPointAtLength(position);
      const before = route.getPointAtLength(Math.max(0, position - 1));
      const after = route.getPointAtLength(Math.min(length, position + 1));
      const direction = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
      angle += ((direction - angle + 180) % 360 + 360) % 360 - 180;
      const progress = index / sampleCount;
      return { transform: `translate(${point.x}px, ${point.y}px) rotate(${angle}deg)`, opacity: Math.min(1, progress * 18, (1 - progress) * 18) };
    });
    const animation = particle.animate(frames, {
      duration: time,
      delay: delay || (repeat ? -(offset * 137 % time) : 0),
      iterations: repeat ? Infinity : 1,
      easing: "linear",
    });
    motion.current = animation;
    if (!shouldPlay.current) animation.pause();
    return () => { animation.cancel(); motion.current = undefined; };
  }, [path, repeat, offset, duration, delay]);
  useLayoutEffect(() => {
    const animation = motion.current;
    if (!animation || animation.playState === "finished") return;
    if (playing) animation.play();
    else animation.pause();
  }, [playing]);
  return <>
    <path ref={line} d={path} fill="none" stroke="none"/>
    <g ref={dot} className="wf-stream" aria-hidden="true">
      <circle r="3.1" opacity=".22"/>
      <circle r="1.75" className="wf-stream-core"/>
    </g>
  </>;
}
