import type { TimelineBlock, TimelineChanges, TimelineSnapshot, TimelineTurn } from "@agenthub/schemas";

export interface SessionTimeline extends Omit<TimelineSnapshot, "turns"> {
  turns: ReadonlyMap<string, TimelineTurn>;
  positions: ReadonlyMap<string, number>;
}

export function openTimeline(snapshot: TimelineSnapshot): SessionTimeline {
  const positions = new Map<string, number>();
  let previous = 0;
  for (const [index, block] of snapshot.blocks.entries()) {
    if (block.seq <= previous || positions.has(block.blockId)) throw new Error("Invalid timeline snapshot order");
    previous = block.seq;
    positions.set(block.blockId, index);
  }
  return { ...snapshot, turns: new Map(snapshot.turns.map(turn => [turn.runId, turn])), positions };
}

export function applyTimelineChanges(current: SessionTimeline, page: TimelineChanges): SessionTimeline {
  if (page.reset) throw new Error("Timeline cursor has expired");
  if (!page.changes.length || page.revision <= current.revision) return current;
  const blocks = current.blocks.slice();
  let positions: Map<string, number> | undefined;
  let turns: Map<string, TimelineTurn> | undefined;
  for (const { operations, turn } of page.changes) {
    for (const operation of operations) {
      const index = (positions ?? current.positions).get(operation.type === "block_created" ? operation.block.blockId : operation.blockId);
      if (operation.type === "block_created") {
        const { block } = operation;
        if (index !== undefined || block.seq <= (blocks.at(-1)?.seq ?? 0)) throw new Error("Timeline creation is not a tail append");
        positions ??= new Map(current.positions);
        positions.set(block.blockId, blocks.length);
        blocks.push(block);
      } else {
        if (index === undefined) throw new Error("Timeline update references an unknown block");
        const block = blocks[index]!;
        if (operation.type === "block_delta") {
          if (block.sealed || index !== blocks.length - 1 || typeof block.content.text !== "string") throw new Error("Timeline delta targets a closed block");
          blocks[index] = { ...block, content: { ...block.content, text: block.content.text + operation.text } };
        } else {
          blocks[index] = { ...block, sealed: operation.sealed ?? block.sealed, status: operation.status ?? block.status, result: operation.result ?? block.result };
        }
      }
    }
    if (turn) {
      turns ??= new Map(current.turns);
      turns.set(turn.runId, turn);
    }
  }
  return { blocks, turns: turns ?? current.turns, positions: positions ?? current.positions, revision: page.revision };
}

export type TimelineEntry = { block: TimelineBlock }
  | { turn: TimelineTurn; process: TimelineBlock[] }
  | { summary: TimelineTurn };

export function timelineEntries({ blocks, turns }: SessionTimeline): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const lastProcess = new Map<TimelineTurn, TimelineEntry>();
  const runningTails = new Map<string, TimelineBlock>();
  for (const block of blocks) {
    if (block.runId && turns.get(block.runId)?.status === "running" &&
        ["assistant_text", "thinking", "tool_call", "user_append"].includes(block.kind)) {
      runningTails.set(block.runId, block);
    }
  }
  let group: Extract<TimelineEntry, { process: TimelineBlock[] }> | undefined;
  for (const block of blocks) {
    const turn = block.runId ? turns.get(block.runId) : undefined;
    const reply = block.kind === "assistant_text" && block === runningTails.get(turn?.runId ?? "");
    const process = turn && turn.finalBlockId !== block.blockId && !reply
      && ["thinking", "tool_call", "assistant_text", "assistant_note", "user_append", "notice"].includes(block.kind)
      && !["workflow.plan", "run.failed"].includes(String(block.content.type));
    if (!process) {
      group = undefined;
      entries.push({ block });
    } else {
      // Start a row at each steering message so it remains a navigation target.
      if (group?.turn !== turn || block.kind === "user_append") {
        group = { turn, process: [] };
        entries.push(group);
        lastProcess.set(turn, group);
      }
      group.process.push(block);
    }
  }
  return entries.flatMap<TimelineEntry>((entry, index) => {
    if ("process" in entry) {
      const { turn } = entry;
      const next = entries[index + 1];
      if (turn.status !== "running" && lastProcess.get(turn) === entry &&
          (!turn.finalBlockId || (next && "block" in next && next.block.blockId === turn.finalBlockId))) {
        return [{ summary: turn }, entry];
      }
    } else if ("block" in entry && entry.block.runId) {
      const turn = turns.get(entry.block.runId);
      if (turn?.finalBlockId === entry.block.blockId && lastProcess.has(turn) && lastProcess.get(turn) !== entries[index - 1]) {
        return [{ summary: turn }, entry];
      }
    }
    return [entry];
  });
}
