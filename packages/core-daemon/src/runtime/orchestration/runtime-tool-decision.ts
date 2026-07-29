import { randomUUID } from "node:crypto";
import type { PlannerDecision, TeamDefinition } from "@agenthub/domain";
import { CoreError } from "../../errors.js";
import { DecisionValidator } from "./decision-validator.js";
import { normalizeRuntimeToolName, RUNTIME_TOOL_NAMES } from "./runtime-tool-names.js";

type DelegatingDecision = Exclude<PlannerDecision, { mode: "direct" }>;
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/** Converts the compact provider-tool arguments into the internal validated task contract. */
export class RuntimeToolDecisionBuilder {
  constructor(private readonly decisions: DecisionValidator) {}

  build(toolName: string, input: unknown, team: TeamDefinition): DelegatingDecision {
    const source = record(input);
    const normalizedToolName = normalizeRuntimeToolName(toolName);
    let candidate: unknown;
    if (normalizedToolName === RUNTIME_TOOL_NAMES.delegate) {
      candidate = {
        mode: "delegate",
        rationale: "runtime_tool",
        task: {
          id: randomUUID(),
          memberId: source.memberId,
          task: source.task,
          continueSessionId: source.continueSessionId
        }
      };
    } else if (normalizedToolName === RUNTIME_TOOL_NAMES.plan) {
      const rawTasks = Array.isArray(source.tasks) ? source.tasks.map(record) : [];
      const localIds = new Map<string, string>();
      for (const task of rawTasks) {
        const localId = String(task.id ?? "").trim();
        if (localId && !localIds.has(localId)) localIds.set(localId, randomUUID());
      }
      candidate = {
        mode: "plan",
        rationale: "runtime_tool",
        tasks: rawTasks.map((task) => ({
          id: localIds.get(String(task.id ?? "").trim()) ?? randomUUID(),
          memberId: task.memberId,
          task: task.task,
          continueSessionId: task.continueSessionId,
          dependsOn: Array.isArray(task.dependsOn)
            ? task.dependsOn.map((id) => localIds.get(String(id).trim()) ?? String(id))
            : []
        }))
      };
    } else {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "toolName", value: toolName });
    }

    const decision = this.decisions.planner(candidate, team);
    if (decision.mode === "direct") throw new CoreError("PLAN_SCHEMA_INVALID", { reason: "runtime_tool_direct_mode" });
    return decision;
  }
}
