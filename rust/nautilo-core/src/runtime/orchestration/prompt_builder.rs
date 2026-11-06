//! Orchestration prompts — port of runtime/orchestration/prompt-builder.ts.
//! The prompt texts are byte-identical to the TS builder.

use serde_json::{json, Value};

pub struct OrchestrationPromptBuilder;

impl OrchestrationPromptBuilder {
    pub fn main_turn(goal: &str, team: &Value, child_sessions: &[Value], continuity: Option<&str>) -> String {
        let can_delegate = team.get("delegationPolicy").and_then(Value::as_str) != Some("direct_only")
            && team.get("members").and_then(Value::as_array).is_some_and(|members| members.iter().any(|member|
                member.get("enabled").and_then(Value::as_bool) == Some(true) && member.get("id") != team.get("mainMemberId")));
        let delegation = if can_delegate {
            [
                "Use agenthub_delegate or agenthub_plan with the exact configured member IDs below to dispatch Nautilo team tasks. Honor an explicit user request to use a configured member even for a small task.",
                "Default to delegating substantial, well-scoped work matching a configured member's role or strengths. Respect role descriptions and limitations; do not take over work assigned to that role.",
                "Order before parallel: research and exploration must finish before implementation that depends on it. Use dependsOn for dependent tasks and serialize overlapping files. Parallelize only independent work.",
                "Give implementation members concrete files, decisions, and acceptance checks. Use an exploration member first when facts are missing.",
                "Do trivial work and central coordination yourself unless the user or a member's configured role explicitly assigns it to a member.",
                "If the Nautilo delegation tools are unavailable in this turn, report that the configured member was not dispatched. Never substitute a provider-native child and claim that it is the configured member.",
            ].join("\n\n")
        } else {
            "Configured-member delegation is disabled for this turn (direct_only policy or no enabled child members). The Nautilo delegate and plan tools are not available. Do not claim a configured member was dispatched; if the user asks for one, explain that the team policy or enabled members need to change.".to_string()
        };
        [
            "[AGENTHUB_MAIN_TURN]".to_string(),
            "Work on the user's request normally. You are not required to classify it or emit routing JSON.".to_string(),
            delegation,
            "Provider-native subagents (spawn_agent, Task, and similar tools) belong to the current Harness. They are distinct from Nautilo's configured members, connections, and models. Do not describe one as the other. Only report a configured dispatch after a successful Nautilo tool receipt; use its actual taskId and sessionId when asked where it ran.".to_string(),
            "Every delegated task must be self-contained. A child receives the task text and its own provider session; it cannot inspect the parent session, a sibling Agent session, or another Agent's pending result.".to_string(),
            "Never ask one child Agent to obtain status, context, or output from another child Agent. Use plan dependencies when ordering matters; Nautilo supplies completed dependency outcomes to the dependent child.".to_string(),
            "Delegation tools do not forward chat-only attachments or inline images. Do not tell a child to inspect 'the attached image' or other unseen conversation content. Handle the visual analysis yourself, or provide a verified child-readable workspace path plus all essential textual observations in the task.".to_string(),
            "A successful tool call is only a dispatch receipt — the delegated task is still running and its outcome is unknown. Never perform, duplicate, or pre-empt delegated work yourself, and never state assumptions about a pending task's outcome as fact or conclude the goal from unfinished child work. Continue only useful non-overlapping work, or end this turn after one concise dispatch update when nothing else remains.".to_string(),
            "Do not poll child status or retry failed child work automatically. Nautilo will return child results into this provider session.".to_string(),
            format!("Goal:\n{goal}"),
            continuity.unwrap_or("").to_string(),
            format!("Configured child Agents:\n{}", serde_json::to_string_pretty(&team_context(team)).unwrap_or_default()),
            format!("Existing compatible child sessions:\n{}", serde_json::to_string_pretty(&session_context(child_sessions, team)).unwrap_or_default()),
        ]
        .join("\n\n")
    }

    pub fn planning(goal: &str, team: &Value, child_sessions: &[Value], continuity: Option<&str>) -> String {
        let delegation_policy = team.get("delegationPolicy").and_then(Value::as_str).unwrap_or("");
        let allowed_modes = if delegation_policy == "direct_only" { vec!["direct"] } else { vec!["direct", "delegate", "plan"] };
        [
            "[AGENTHUB_PLANNER_DECISION]".to_string(),
            "You are the user-selected main Agent. Decide whether to complete the goal yourself or use configured team members.".to_string(),
            "Default to delegating substantial, well-scoped tasks that match a member's role or strengths. The team exists to be used.".to_string(),
            "Order before parallel: research before implementation, producers before consumers. Use plan mode with dependsOn whenever one task needs another task's facts, files, or output; tasks that touch the same files must be ordered, never parallel. Only fully independent tasks may run in parallel.".to_string(),
            "Implementation tasks must carry your decisions (concrete files, approach, acceptance). Do not delegate open-ended 'investigate and decide' work to an implementation member.".to_string(),
            "Choose direct only when the task is trivial, when it is central coordination, or when no enabled member fits.".to_string(),
            format!("Delegation policy: {delegation_policy}. Allowed modes: {}.", allowed_modes.join(", ")),
            "Return exactly one JSON object and no Markdown.".to_string(),
            "direct: {\"mode\":\"direct\"}".to_string(),
            "delegate, new child session: {\"mode\":\"delegate\",\"memberId\":\"exact enabled member id\",\"task\":\"what that member should do\"}".to_string(),
            "delegate, continue child session: {\"mode\":\"delegate\",\"memberId\":\"exact enabled member id\",\"task\":\"follow-up task\",\"continueSessionId\":\"exact compatible session id\"}".to_string(),
            "plan: {\"mode\":\"plan\",\"tasks\":[{\"id\":\"task-1\",\"memberId\":\"exact enabled member id\",\"task\":\"what to do\",\"dependsOn\":[],\"continueSessionId\":\"optional exact compatible session id\"}]}".to_string(),
            "Use member IDs exactly as listed below. Do not invent or shorten an ID.".to_string(),
            "Every task must be self-contained. Children cannot read the parent or sibling Agent sessions and must never be told to fetch another child's context or result.".to_string(),
            "Use dependsOn for ordering. Nautilo will include completed dependency outcomes in the dependent child's task prompt.".to_string(),
            "Chat-only attachments and inline images are not transferred by delegation. Do not delegate visual inspection of unseen conversation images; either do that analysis in the main Agent or give the child a verified readable workspace path and the essential observations in task text.".to_string(),
            "Choose whether to start fresh or continue context. Only set continueSessionId when an existing session below belongs to the assigned member; omit it to create a new child session.".to_string(),
            "For plan mode, dependsOn contains task IDs from the same plan and must form an acyclic graph.".to_string(),
            "A reason is optional. Do not output database fields, acceptance objects, paths, session data, or provider commands; Nautilo creates those internally.".to_string(),
            format!("Goal:\n{goal}"),
            continuity.unwrap_or("").to_string(),
            format!("User-configured team (this is the complete routing allowlist):\n{}", serde_json::to_string_pretty(&team_context(team)).unwrap_or_default()),
            format!("Existing child sessions available for optional continuation:\n{}", serde_json::to_string_pretty(&session_context(child_sessions, team)).unwrap_or_default()),
        ]
        .join("\n\n")
    }

    pub fn direct_execution(goal: &str) -> String {
        [
            "[AGENTHUB_DIRECT_EXECUTION]",
            "You selected direct mode. Complete the user's goal yourself now.",
            "Do not invent or invoke team members. Work in the current project and report the result to the user.",
        ]
        .join("\n\n")
            + &format!("\n\nGoal:\n{goal}")
    }

    pub fn delegation_rejected(goal: &str) -> String {
        [
            "[AGENTHUB_DIRECT_EXECUTION]",
            "The user rejected your proposed delegation. Complete the original goal yourself now.",
            "Do not create child tasks in this turn.",
        ]
        .join("\n\n")
            + &format!("\n\nGoal:\n{goal}")
    }

    pub fn delegated_task(task: &Value, team: &Value, dependency_outcomes: &[Value]) -> String {
        let member_id = task.get("assignedMemberId").and_then(Value::as_str);
        let member = team
            .get("members")
            .and_then(Value::as_array)
            .and_then(|members| members.iter().find(|m| m.get("id").and_then(Value::as_str) == member_id).cloned());
        let role = team.get("roles").and_then(Value::as_array).and_then(|roles| {
            roles
                .iter()
                .find(|role| Some(role.get("id").and_then(Value::as_str).unwrap_or("")) == member.as_ref().and_then(|m| m.get("roleId")).and_then(Value::as_str))
                .cloned()
        });
        let task_json = json!({
            "id": task.get("id").cloned().unwrap_or(Value::Null),
            "title": task.get("title").cloned().unwrap_or(Value::Null),
            "objective": task.get("objective").cloned().unwrap_or(Value::Null),
            "taskType": task.get("taskType").cloned().unwrap_or(Value::Null),
            "allowedPaths": task.get("allowedPaths").cloned().unwrap_or(Value::Null),
            "acceptanceCriteria": task.get("acceptanceCriteria").cloned().unwrap_or(Value::Null)
        });
        let dependencies_section = if dependency_outcomes.is_empty() {
            String::new()
        } else {
            format!(
                "Completed dependency outcomes supplied by Nautilo:\n{}",
                serde_json::to_string_pretty(&json!(dependency_outcomes)).unwrap_or_default()
            )
        };
        [
            "[AGENTHUB_DELEGATED_TASK]".to_string(),
            "You are executing one task assigned by the user-selected main Agent.".to_string(),
            format!("Task:\n{}", serde_json::to_string_pretty(&task_json).unwrap_or_default()),
            dependencies_section,
            format!(
                "Your user-defined member configuration:\n{}",
                serde_json::to_string_pretty(&json!({ "member": member, "role": role })).unwrap_or_default()
            ),
            "This prompt is your complete cross-Agent handoff. You cannot access the parent Agent session, sibling Agent sessions, or their tools and pending results.".to_string(),
            "Do not attempt to query another Agent. Use only this task, the dependency outcomes above, and files you can actually access in your workspace.".to_string(),
            "A mention of an attached or inline image is not image access. Inspect an image only when this prompt gives a concrete path that you can read; otherwise report the missing input as a blocker instead of calling unavailable tools.".to_string(),
            "Complete only this task. End with a concise result including changes, checks, risks, and blockers.".to_string(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    }

    pub fn delegation_accepted(goal: &str, receipts: &[Value]) -> String {
        [
            "[AGENTHUB_DELEGATION_ACCEPTED]".to_string(),
            "The delegated tasks below were accepted by Nautilo and are now running asynchronously in child sessions.".to_string(),
            "Continue the parent turn now. Do not wait for the child tasks and do not repeat the routing JSON.".to_string(),
            "Do not execute, verify, create a fallback for, or claim completion of work that is already covered by a delegated task while that task is running.".to_string(),
            "Delegated outcomes are still unknown. Do not draw conclusions, make plans, or dispatch follow-up work that assumes a pending task's result; wait for Nautilo to deliver it.".to_string(),
            "Proceed only with useful independent work whose scope does not overlap any delegated task.".to_string(),
            "If there is no independent work left, give the user exactly one concise dispatch update and end this provider turn immediately.".to_string(),
            "Do not poll task status, repeatedly inspect the workspace, sleep, or loop while waiting; doing so only wastes tokens.".to_string(),
            "Ending this provider turn does not stop the orchestration. Nautilo keeps the overall run active and will deliver child results back into this same provider session when they finish.".to_string(),
            format!("Original goal:\n{goal}"),
            format!("Dispatch receipts:\n{}", serde_json::to_string_pretty(&json!(receipts)).unwrap_or_default()),
        ]
        .join("\n\n")
    }

    pub fn final_synthesis(goal: &str, tasks: &[Value], results: &[Value]) -> String {
        let outcomes: Vec<Value> = tasks
            .iter()
            .map(|task| {
                let task_id = task.get("id").and_then(Value::as_str).unwrap_or("");
                let outcome = results
                    .iter()
                    .find(|item| item.get("taskId").and_then(Value::as_str) == Some(task_id));
                json!({
                    "id": task.get("id").cloned().unwrap_or(Value::Null),
                    "title": task.get("title").cloned().unwrap_or(Value::Null),
                    "status": task.get("status").cloned().unwrap_or(Value::Null),
                    "assignedMemberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null),
                    "completedByMemberId": task.get("completedByMemberId").cloned().unwrap_or(Value::Null),
                    "memberName": outcome.and_then(|o| o.get("memberName").cloned()).unwrap_or(Value::Null),
                    "result": outcome
                        .and_then(|o| o.get("result"))
                        .and_then(Value::as_str)
                        .map(|text| text.chars().take(16_000).collect::<String>())
                        .map(Value::String)
                        .unwrap_or(Value::Null)
                })
            })
            .collect();
        [
            "[AGENTHUB_FINAL_SYNTHESIS]".to_string(),
            "This turn was triggered because all runnable delegated tasks finished. It does not mean the original goal is complete, and it is not the end of the conversation.".to_string(),
            "Compare the task outcomes against the original goal and handle exactly one of these cases:".to_string(),
            "1. The goal is fully addressed: produce the final user-facing response.".to_string(),
            "2. Work remains or a task failed: report progress, failures, and what is still missing, then end the turn. Continue in the next normal turn.".to_string(),
            "Do not dispatch new delegated tasks, retry, reassign, or take over failed work in this synthesis turn; those decisions belong to the next normal turn.".to_string(),
            "Treat member results as reports, not proof. Verify important completion or artifact claims before presenting them as successful.".to_string(),
            "If a delegated task failed, state the failure clearly and do not claim that task succeeded.".to_string(),
            format!("Goal:\n{goal}"),
            format!("Task outcomes:\n{}", serde_json::to_string_pretty(&json!(outcomes)).unwrap_or_default()),
        ]
        .join("\n\n")
    }
}

fn team_context(team: &Value) -> Value {
    let main_member_id = team.get("mainMemberId").and_then(Value::as_str);
    let members: Vec<Value> = team
        .get("members")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|member| {
            member.get("enabled").and_then(Value::as_bool) == Some(true)
                && member.get("id").and_then(Value::as_str) != main_member_id
        })
        .map(|member| {
            let role_id = member.get("roleId").and_then(Value::as_str);
            let role = team.get("roles").and_then(Value::as_array).and_then(|roles| {
                roles.iter().find(|role| role.get("id").and_then(Value::as_str) == role_id).cloned()
            });
            json!({
                "id": member.get("id").cloned().unwrap_or(Value::Null),
                "displayName": member.get("displayName").cloned().unwrap_or(Value::Null),
                "role": role.unwrap_or(Value::Null),
                "model": member.get("model").cloned().unwrap_or(Value::Null),
                "reasoningEffort": member.get("reasoningEffort").cloned().unwrap_or(Value::Null),
                "serviceTier": member.get("serviceTier").cloned().unwrap_or(Value::Null),
                "strengths": member.get("strengths").cloned().unwrap_or(Value::Null),
                "allowedTaskTypes": member.get("allowedTaskTypes").cloned().unwrap_or(Value::Null),
                "maxConcurrentTasks": member.get("maxConcurrentTasks").cloned().unwrap_or(Value::Null)
            })
        })
        .collect();
    Value::Array(members)
}

fn session_context(sessions: &[Value], team: &Value) -> Value {
    let enabled: std::collections::HashSet<&str> = team
        .get("members")
        .and_then(Value::as_array)
        .map(|members| members.iter().filter(|m| m.get("enabled").and_then(Value::as_bool) == Some(true)).filter_map(|m| m.get("id").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    let mut filtered: Vec<Value> = sessions
        .iter()
        .filter(|session| session.get("memberId").and_then(Value::as_str).is_some_and(|id| enabled.contains(id)))
        .cloned()
        .collect();
    filtered.sort_by(|left, right| {
        right
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(left.get("updatedAt").and_then(Value::as_str).unwrap_or(""))
    });
    Value::Array(
        filtered
            .iter()
            .take(20)
            .map(|session| {
                json!({
                    "sessionId": session.get("id").cloned().unwrap_or(Value::Null),
                    "memberId": session.get("memberId").cloned().unwrap_or(Value::Null),
                    "title": session.get("title").cloned().unwrap_or(Value::Null),
                    "status": session.get("status").cloned().unwrap_or(Value::Null),
                    "lastMessageAt": session.get("lastMessageAt").cloned().unwrap_or(Value::Null)
                })
            })
            .collect(),
    )
}
