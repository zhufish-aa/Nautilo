import type { Session } from "@agenthub/domain";
import type { RuntimeToolSpec } from "../../adapters/index.js";
import type { OrchestrationService } from "../../application/orchestration-service.js";
import type { RunContext } from "../run-service.js";
import type { RuntimeToolBinding, RuntimeToolProvider } from "../runtime-tool-provider.js";
import { Database } from "../../database/index.js";
import { RUNTIME_TOOL_NAMES } from "./runtime-tool-names.js";

function memberSummary(session: Session, database: Database): Array<{ id: string; name: string; role?: string }> {
  const team = session.teamId ? database.teams.get(session.teamId) : undefined;
  if (!team) return [];
  return team.members
    .filter((member) => member.enabled && member.id !== team.mainMemberId)
    .map((member) => ({
      id: member.id,
      name: member.displayName,
      role: team.roles?.find((role) => role.id === member.roleId)?.name
    }));
}

function specs(session: Session, database: Database): RuntimeToolSpec[] {
  const members = memberSummary(session, database);
  const memberIds = members.map((member) => member.id);
  const membersText = members.map((member) => `${member.id} (${member.name}${member.role ? `, ${member.role}` : ""})`).join(", ");
  const memberSchema = memberIds.length ? { type: "string", enum: memberIds } : { type: "string" };
  return [
    {
      name: RUNTIME_TOOL_NAMES.delegate,
      description: `Optionally dispatch one independent, self-contained task to a configured child Agent and continue your current turn. Available members: ${membersText}. The child cannot read the parent or sibling Agent sessions, pending child results, or chat-only attachments/images. Include all required context in task text and do not call this when you can complete the work yourself.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["memberId", "task"],
        properties: {
          memberId: memberSchema,
          task: { type: "string", minLength: 1, description: "A concrete, self-contained task. Do not refer to unseen chat attachments or ask the child to obtain another Agent's context or result." },
          continueSessionId: { type: "string", description: "Optional compatible child session to continue; omit to start a fresh child session." }
        }
      }
    },
    {
      name: RUNTIME_TOOL_NAMES.plan,
      description: `Optionally dispatch a small dependency graph of self-contained tasks to configured child Agents and continue your current turn. Available members: ${membersText}. Children cannot inspect sibling sessions; use dependsOn so AgentHub can supply completed dependency outcomes. Chat-only attachments/images are not forwarded.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "memberId", "task"],
              properties: {
                id: { type: "string", minLength: 1, description: "A plan-local task ID used by dependsOn." },
                memberId: memberSchema,
                task: { type: "string", minLength: 1, description: "A self-contained task with no references to unseen parent-chat attachments or sibling Agent state." },
                dependsOn: { type: "array", items: { type: "string" }, default: [] },
                continueSessionId: { type: "string" }
              }
            }
          }
        }
      }
    }
  ];
}

/** Supplies orchestration tools only to a root team session, never to a child. */
export class MainAgentRuntimeToolProvider implements RuntimeToolProvider {
  constructor(
    private readonly database: Database,
    private readonly orchestration: OrchestrationService
  ) {}

  forRun(session: Session, context: RunContext): RuntimeToolBinding | undefined {
    if (context.messageKind === "planner_decision" || !session.teamId || !session.projectRunId || session.parentSessionId) return undefined;
    const projectRun = this.database.projectRuns.get(session.projectRunId);
    const team = this.database.teams.get(session.teamId);
    if (!projectRun || projectRun.mainSessionId !== session.id || !team || team.delegationPolicy === "direct_only") return undefined;
    const tools = specs(session, this.database);
    if (!memberSummary(session, this.database).length) return undefined;
    return {
      tools,
      execute: (call) => this.orchestration.invokeRuntimeTool(session.id, call.name, call.arguments)
    };
  }
}
