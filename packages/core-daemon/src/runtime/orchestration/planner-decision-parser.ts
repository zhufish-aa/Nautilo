import type { AcceptanceCriterion, ContextNeed, PlannedTask, TeamDefinition } from "@agenthub/domain";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => text(item) ?? []) : [];
}

function differsByAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let short = left;
  let long = right;
  if (short.length > long.length) [short, long] = [long, short];
  let shortIndex = 0;
  let longIndex = 0;
  let differences = 0;
  while (shortIndex < short.length && longIndex < long.length) {
    if (short[shortIndex] === long[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    differences += 1;
    if (differences > 1) return false;
    if (short.length === long.length) shortIndex += 1;
    longIndex += 1;
  }
  return differences + Number(longIndex < long.length) <= 1;
}

function criteria(value: unknown, taskId: string): AcceptanceCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const description = text(item);
    if (description) return [{ id: `${taskId}-criterion-${index + 1}`, description, required: true }];
    const source = record(item);
    const objectDescription = text(source?.description);
    if (!source || !objectDescription) return [];
    return [{
      id: text(source.id) ?? `${taskId}-criterion-${index + 1}`,
      description: objectDescription,
      ...(text(source.commandTemplateId) ? { commandTemplateId: text(source.commandTemplateId) } : {}),
      required: typeof source.required === "boolean" ? source.required : true
    }];
  });
}

function contextNeeds(value: unknown): ContextNeed[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    const kind = text(source?.kind);
    const reference = text(source?.reference);
    const reason = text(source?.reason);
    if (!source || !reference || !reason || !["file", "artifact", "decision", "verification"].includes(kind ?? "")) return [];
    return [{ kind: kind as ContextNeed["kind"], reference, reason }];
  });
}

/**
 * Converts the small, model-facing planning language into the complete internal task contract.
 * It only auto-routes when the configured team leaves exactly one enabled candidate.
 */
export class PlannerDecisionParser {
  parse(value: unknown, team: TeamDefinition): unknown {
    const source = record(value);
    if (!source) return value;
    const mode = text(source.mode);
    const rationale = text(source.rationale) ?? text(source.reason) ?? `main_agent_selected_${mode ?? "unknown"}`;
    if (mode === "direct") return { mode, rationale };

    if (mode === "delegate") {
      const taskSource = typeof source.task === "string"
        ? { task: source.task, memberId: source.memberId, continueSessionId: source.continueSessionId }
        : record(source.task);
      if (!taskSource) return value;
      return { mode, rationale, task: this.task(taskSource, 0, rationale, team) };
    }

    if (mode === "plan" && Array.isArray(source.tasks)) {
      return {
        mode,
        rationale,
        tasks: source.tasks.map((item, index) => this.task(record(item) ?? {}, index, rationale, team))
      };
    }
    return value;
  }

  private task(source: JsonRecord, index: number, rationale: string, team: TeamDefinition): PlannedTask {
    const id = text(source.id) ?? `task-${index + 1}`;
    const objective = text(source.objective) ?? text(source.task) ?? text(source.title) ?? "";
    const requestedMember = text(source.assignedMemberId) ?? text(source.memberId) ?? "";
    const member = this.member(team, requestedMember);
    const taskType = text(source.taskType) ?? text(source.type) ?? this.defaultTaskType(member?.allowedTaskTypes);
    return {
      id,
      title: text(source.title) ?? objective.slice(0, 80),
      objective,
      taskType,
      assignedMemberId: member?.id ?? requestedMember,
      ...(text(source.continueSessionId ?? source.targetSessionId)
        ? { targetSessionId: text(source.continueSessionId ?? source.targetSessionId) }
        : {}),
      dependencies: strings(source.dependencies ?? source.dependsOn),
      allowedPaths: strings(source.allowedPaths ?? source.paths),
      acceptanceCriteria: criteria(source.acceptanceCriteria ?? source.acceptance, id),
      contextNeeds: contextNeeds(source.contextNeeds),
      assignmentReason: text(source.assignmentReason) ?? text(source.reason) ?? rationale
    };
  }

  private member(team: TeamDefinition, requested: string) {
    const enabled = team.members.filter((member) => member.enabled && member.id !== team.mainMemberId);
    const exact = enabled.find((member) => member.id === requested);
    if (exact) return exact;
    const byName = enabled.filter((member) => member.displayName.localeCompare(requested, undefined, { sensitivity: "accent" }) === 0);
    if (byName.length === 1) return byName[0];
    if (enabled.length === 1 && (!requested || differsByAtMostOne(enabled[0].id, requested))) return enabled[0];
    return undefined;
  }

  private defaultTaskType(allowed: string[] | undefined): string {
    return allowed?.find((taskType) => taskType !== "*") ?? "general";
  }
}
