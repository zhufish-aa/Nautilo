import type { PlannedTask, Session, Task, TeamDefinition } from "@agenthub/domain";

export interface DelegationReceipt {
  taskId: string;
  title: string;
  assignedMemberId: string;
  memberName?: string;
  sessionId: string;
  runId: string;
}

export class OrchestrationPromptBuilder {
  planning(goal: string, team: TeamDefinition, childSessions: Session[] = [], continuity?: string): string {
    const allowedModes = team.delegationPolicy === "direct_only" ? ["direct"] : ["direct", "delegate", "plan"];
    return [
      "[AGENTHUB_PLANNER_DECISION]",
      "You are the user-selected main Agent. Decide whether to complete the goal yourself or use configured team members.",
      "Delegation is optional. Choose direct whenever using another member would not materially help.",
      `Delegation policy: ${team.delegationPolicy}. Allowed modes: ${allowedModes.join(", ")}.`,
      "Return exactly one JSON object and no Markdown.",
      'direct: {"mode":"direct"}',
      'delegate, new child session: {"mode":"delegate","memberId":"exact enabled member id","task":"what that member should do"}',
      'delegate, continue child session: {"mode":"delegate","memberId":"exact enabled member id","task":"follow-up task","continueSessionId":"exact compatible session id"}',
      'plan: {"mode":"plan","tasks":[{"id":"task-1","memberId":"exact enabled member id","task":"what to do","dependsOn":[],"continueSessionId":"optional exact compatible session id"}]}',
      "Use member IDs exactly as listed below. Do not invent or shorten an ID.",
      "Choose whether to start fresh or continue context. Only set continueSessionId when an existing session below belongs to the assigned member; omit it to create a new child session.",
      "For plan mode, dependsOn contains task IDs from the same plan and must form an acyclic graph.",
      "A reason is optional. Do not output database fields, acceptance objects, paths, session data, or provider commands; AgentHub creates those internally.",
      `Goal:\n${goal}`,
      continuity ?? "",
      `User-configured team (this is the complete routing allowlist):\n${JSON.stringify(this.teamContext(team), null, 2)}`,
      `Existing child sessions available for optional continuation:\n${JSON.stringify(this.sessionContext(childSessions, team), null, 2)}`
    ].join("\n\n");
  }

  directExecution(goal: string): string {
    return [
      "[AGENTHUB_DIRECT_EXECUTION]",
      "You selected direct mode. Complete the user's goal yourself now.",
      "Do not invent or invoke team members. Work in the current project and report the result to the user.",
      `Goal:\n${goal}`
    ].join("\n\n");
  }

  delegationRejected(goal: string): string {
    return [
      "[AGENTHUB_DIRECT_EXECUTION]",
      "The user rejected your proposed delegation. Complete the original goal yourself now.",
      "Do not create child tasks in this turn.",
      `Goal:\n${goal}`
    ].join("\n\n");
  }

  delegatedTask(task: Task, team: TeamDefinition): string {
    const member = team.members.find((candidate) => candidate.id === task.assignedMemberId);
    const role = team.roles?.find((candidate) => candidate.id === member?.roleId);
    return [
      "[AGENTHUB_DELEGATED_TASK]",
      "You are executing one task assigned by the user-selected main Agent.",
      `Task:\n${JSON.stringify({ id: task.id, title: task.title, objective: task.objective, taskType: task.taskType, allowedPaths: task.allowedPaths, acceptanceCriteria: task.acceptanceCriteria }, null, 2)}`,
      `Your user-defined member configuration:\n${JSON.stringify({ member, role }, null, 2)}`,
      "Complete only this task. End with a concise result including changes, checks, risks, and blockers."
    ].join("\n\n");
  }

  delegationAccepted(goal: string, receipts: DelegationReceipt[]): string {
    return [
      "[AGENTHUB_DELEGATION_ACCEPTED]",
      "The delegated tasks below were accepted by AgentHub and are now running asynchronously in child sessions.",
      "Continue the parent turn now. Do not wait for the child tasks and do not repeat the routing JSON.",
      "Do not execute, verify, create a fallback for, or claim completion of work that is already covered by a delegated task while that task is running.",
      "Proceed only with useful independent work whose scope does not overlap any delegated task.",
      "If there is no independent work left, give the user exactly one concise dispatch update and end this provider turn immediately.",
      "Do not poll task status, repeatedly inspect the workspace, sleep, or loop while waiting; doing so only wastes tokens.",
      "Ending this provider turn does not stop the orchestration. AgentHub keeps the overall run active and will deliver child results back into this same provider session when they finish.",
      `Original goal:\n${goal}`,
      `Dispatch receipts:\n${JSON.stringify(receipts, null, 2)}`
    ].join("\n\n");
  }

  finalSynthesis(goal: string, tasks: Task[], results: Array<{ taskId: string; memberName?: string; result?: string }>): string {
    return [
      "[AGENTHUB_FINAL_SYNTHESIS]",
      "All runnable delegated tasks have finished. Produce the final user-facing response for the original goal.",
      "Treat member results as reports, not proof. Verify important completion or artifact claims before presenting them as successful.",
      "If a delegated task failed, state the failure clearly and do not claim that task succeeded.",
      "Do not automatically retry, reassign, or take over a failed task in this synthesis turn. The main Agent may choose a next action in a later normal turn.",
      `Goal:\n${goal}`,
      `Task outcomes:\n${JSON.stringify(tasks.map((task) => {
        const outcome = results.find((item) => item.taskId === task.id);
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          assignedMemberId: task.assignedMemberId,
          completedByMemberId: task.completedByMemberId,
          memberName: outcome?.memberName,
          result: outcome?.result?.slice(0, 16_000)
        };
      }), null, 2)}`
    ].join("\n\n");
  }

  private teamContext(team: TeamDefinition): unknown {
    return team.members.filter((member) => member.enabled && member.id !== team.mainMemberId).map((member) => ({
      id: member.id,
      displayName: member.displayName,
      role: team.roles?.find((role) => role.id === member.roleId),
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      serviceTier: member.serviceTier,
      strengths: member.strengths,
      allowedTaskTypes: member.allowedTaskTypes,
      maxConcurrentTasks: member.maxConcurrentTasks
    }));
  }

  private sessionContext(sessions: Session[], team: TeamDefinition): unknown {
    const enabledMemberIds = new Set(team.members.filter((member) => member.enabled).map((member) => member.id));
    return sessions
      .filter((session) => enabledMemberIds.has(session.memberId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20)
      .map((session) => ({
        sessionId: session.id,
        memberId: session.memberId,
        title: session.title,
        status: session.status,
        lastMessageAt: session.lastMessageAt
      }));
  }
}
