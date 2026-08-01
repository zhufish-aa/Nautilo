import type { PlannedTask, Session, Task, TeamDefinition } from "@agenthub/domain";

export interface DelegationReceipt {
  taskId: string;
  title: string;
  assignedMemberId: string;
  memberName?: string;
  sessionId: string;
  runId: string;
}

export interface DelegatedDependencyOutcome {
  taskId: string;
  title: string;
  status: Task["status"];
  assignedMemberId?: string;
  memberName?: string;
  result?: string;
}

export class OrchestrationPromptBuilder {
  mainTurn(goal: string, team: TeamDefinition, childSessions: Session[] = [], continuity?: string): string {
    return [
      "[AGENTHUB_MAIN_TURN]",
      "Work on the user's request normally. You are not required to classify it or emit routing JSON.",
      "Delegation policy for this turn:",
      "- Default to delegating any substantial, well-scoped task that matches a configured member's role or strengths. The team exists to be used; doing everything yourself when a member fits is a failure mode.",
      "- Order before parallel: research and exploration must finish before you dispatch implementation that depends on it. Chain dependent tasks with dependsOn or dispatch them in separate turns after the prerequisite result arrives. Parallel dispatch is only for tasks with disjoint files and no data dependency — when in doubt, serialize.",
      "- Write implementation tasks with your decisions baked in: concrete files, the chosen approach, and acceptance checks. Never hand an implementation member open-ended 'investigate and decide' work — deciding is your job; use an exploration member when facts are missing, then plan from its result.",
      "- Do the work yourself only when it is trivial (a quick lookup or a small edit), when it is central coordination (merging or verifying child output), or when no enabled member fits.",
      "- Respect each member's role description and limitations; when a role assigns a category of work to a member, do not take that work over.",
      "You may call the AgentHub delegate or plan tool at any point in this turn.",
      "Every delegated task must be self-contained. A child receives the task text and its own provider session; it cannot inspect the parent session, a sibling Agent session, or another Agent's pending result.",
      "Never ask one child Agent to obtain status, context, or output from another child Agent. Use plan dependencies when ordering matters; AgentHub supplies completed dependency outcomes to the dependent child.",
      "Delegation tools do not forward chat-only attachments or inline images. Do not tell a child to inspect 'the attached image' or other unseen conversation content. Handle the visual analysis yourself, or provide a verified child-readable workspace path plus all essential textual observations in the task.",
      "A successful tool call is only a dispatch receipt — the delegated task is still running and its outcome is unknown. Never perform, duplicate, or pre-empt delegated work yourself, and never state assumptions about a pending task's outcome as fact or conclude the goal from unfinished child work. Continue only useful non-overlapping work, or end this turn after one concise dispatch update when nothing else remains.",
      "Do not poll child status or retry failed child work automatically. AgentHub will return child results into this provider session.",
      `Goal:\n${goal}`,
      continuity ?? "",
      `Configured child Agents:\n${JSON.stringify(this.teamContext(team), null, 2)}`,
      `Existing compatible child sessions:\n${JSON.stringify(this.sessionContext(childSessions, team), null, 2)}`
    ].join("\n\n");
  }

  planning(goal: string, team: TeamDefinition, childSessions: Session[] = [], continuity?: string): string {
    const allowedModes = team.delegationPolicy === "direct_only" ? ["direct"] : ["direct", "delegate", "plan"];
    return [
      "[AGENTHUB_PLANNER_DECISION]",
      "You are the user-selected main Agent. Decide whether to complete the goal yourself or use configured team members.",
      "Default to delegating substantial, well-scoped tasks that match a member's role or strengths. The team exists to be used.",
      "Order before parallel: research before implementation, producers before consumers. Use plan mode with dependsOn whenever one task needs another task's facts, files, or output; tasks that touch the same files must be ordered, never parallel. Only fully independent tasks may run in parallel.",
      "Implementation tasks must carry your decisions (concrete files, approach, acceptance). Do not delegate open-ended 'investigate and decide' work to an implementation member.",
      "Choose direct only when the task is trivial, when it is central coordination, or when no enabled member fits.",
      `Delegation policy: ${team.delegationPolicy}. Allowed modes: ${allowedModes.join(", ")}.`,
      "Return exactly one JSON object and no Markdown.",
      'direct: {"mode":"direct"}',
      'delegate, new child session: {"mode":"delegate","memberId":"exact enabled member id","task":"what that member should do"}',
      'delegate, continue child session: {"mode":"delegate","memberId":"exact enabled member id","task":"follow-up task","continueSessionId":"exact compatible session id"}',
      'plan: {"mode":"plan","tasks":[{"id":"task-1","memberId":"exact enabled member id","task":"what to do","dependsOn":[],"continueSessionId":"optional exact compatible session id"}]}',
      "Use member IDs exactly as listed below. Do not invent or shorten an ID.",
      "Every task must be self-contained. Children cannot read the parent or sibling Agent sessions and must never be told to fetch another child's context or result.",
      "Use dependsOn for ordering. AgentHub will include completed dependency outcomes in the dependent child's task prompt.",
      "Chat-only attachments and inline images are not transferred by delegation. Do not delegate visual inspection of unseen conversation images; either do that analysis in the main Agent or give the child a verified readable workspace path and the essential observations in task text.",
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

  delegatedTask(task: Task, team: TeamDefinition, dependencyOutcomes: DelegatedDependencyOutcome[] = []): string {
    const member = team.members.find((candidate) => candidate.id === task.assignedMemberId);
    const role = team.roles?.find((candidate) => candidate.id === member?.roleId);
    return [
      "[AGENTHUB_DELEGATED_TASK]",
      "You are executing one task assigned by the user-selected main Agent.",
      `Task:\n${JSON.stringify({ id: task.id, title: task.title, objective: task.objective, taskType: task.taskType, allowedPaths: task.allowedPaths, acceptanceCriteria: task.acceptanceCriteria }, null, 2)}`,
      dependencyOutcomes.length
        ? `Completed dependency outcomes supplied by AgentHub:\n${JSON.stringify(dependencyOutcomes, null, 2)}`
        : "",
      `Your user-defined member configuration:\n${JSON.stringify({ member, role }, null, 2)}`,
      "This prompt is your complete cross-Agent handoff. You cannot access the parent Agent session, sibling Agent sessions, or their tools and pending results.",
      "Do not attempt to query another Agent. Use only this task, the dependency outcomes above, and files you can actually access in your workspace.",
      "A mention of an attached or inline image is not image access. Inspect an image only when this prompt gives a concrete path that you can read; otherwise report the missing input as a blocker instead of calling unavailable tools.",
      "Complete only this task. End with a concise result including changes, checks, risks, and blockers."
    ].filter(Boolean).join("\n\n");
  }

  delegationAccepted(goal: string, receipts: DelegationReceipt[]): string {
    return [
      "[AGENTHUB_DELEGATION_ACCEPTED]",
      "The delegated tasks below were accepted by AgentHub and are now running asynchronously in child sessions.",
      "Continue the parent turn now. Do not wait for the child tasks and do not repeat the routing JSON.",
      "Do not execute, verify, create a fallback for, or claim completion of work that is already covered by a delegated task while that task is running.",
      "Delegated outcomes are still unknown. Do not draw conclusions, make plans, or dispatch follow-up work that assumes a pending task's result; wait for AgentHub to deliver it.",
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
      "This turn was triggered because all runnable delegated tasks finished. It does not mean the original goal is complete, and it is not the end of the conversation.",
      "Compare the task outcomes against the original goal and handle exactly one of these cases:",
      "1. The goal is fully addressed: produce the final user-facing response.",
      "2. Work remains or a task failed: report progress, failures, and what is still missing, then end the turn. Continue in the next normal turn.",
      "Do not dispatch new delegated tasks, retry, reassign, or take over failed work in this synthesis turn; those decisions belong to the next normal turn.",
      "Treat member results as reports, not proof. Verify important completion or artifact claims before presenting them as successful.",
      "If a delegated task failed, state the failure clearly and do not claim that task succeeded.",
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
