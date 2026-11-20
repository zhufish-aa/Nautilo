use super::WorkflowService;
use crate::adapters::BoxFuture;
use crate::runtime::runtime_tool_provider::{RuntimeToolBinding, RuntimeToolProvider};
use serde_json::{json, Value};
use std::sync::{Arc, Weak};

pub struct WorkflowToolProvider {
    pub workflows: Weak<WorkflowService>,
    pub fallback: Arc<dyn RuntimeToolProvider>,
}
fn object(properties: Value, required: Vec<&str>) -> Value {
    json!({"type":"object","properties":properties,"required":required})
}
impl RuntimeToolProvider for WorkflowToolProvider {
    fn for_run(
        &self,
        session: &Value,
        context: &Value,
        agent: &Value,
    ) -> Option<RuntimeToolBinding> {
        let workflow = context
            .get("workflow")
            .filter(|v| v["instanceId"].is_string())
            .cloned();
        let is_main =
            session.get("parentSessionId").is_none_or(Value::is_null) && workflow.is_none();
        let reference = context.get("workflowReference").filter(|value| value["id"].is_string()).cloned();
        let fallback = if reference.is_some() { None } else { self.fallback.for_run(session, context, agent) };
        let mut tools = fallback
            .as_ref()
            .map(|f| f.tools.clone())
            .unwrap_or_default();
        if workflow.is_some() {
            tools.push(json!({"name":"agenthub_workflow_submit","description":"Submit the named outlet and structured result for this workflow node. Echo instanceId and attempt from the current task prompt; never reuse a previous activation's scope. Use exactly the outlet name in the task prompt. Wait for the accepted receipt before ending your turn.","inputSchema":object(json!({"instanceId":{"type":"string","minLength":1},"attempt":{"type":"integer","minimum":1},"branch":{"type":"string"},"branches":{"type":"array","items":{"type":"string"}},"result":{"type":"object","additionalProperties":true}}),vec!["instanceId","attempt","result"])}));
            if let Some(scope) = workflow.as_ref() {
                if self.workflows.upgrade().is_some_and(|service| service.dynamic_subflow_allowed(scope)) {
                    tools.push(json!({"name":"agenthub_workflow_spawn","description":"Start one authorized subworkflow for this node. Supply complete child prompts, named exits and the preassigned roles. End this turn after an accepted launch; wait for the outcome to be delivered to your native session.","inputSchema":object(json!({"requestId":{"type":"string","minLength":1},"definition":{"type":"object","additionalProperties":true},"inputs":{"type":"object","additionalProperties":true}}),vec!["requestId","definition","inputs"])}));
                }
            }
        } else if is_main {
            tools.push(json!({"name":"agenthub_workflow_run","description":"Start an Agent collaboration graph. Supply either a pinned template ref or a complete schemaVersion 1 definition. Every Agent node needs a prompt, role binding, outputs and named exits. Main nodes dispatch without a model turn. The local engine executes parallel branches, joins and bounded loops and reminds children to submit. Returns immediately with workflow id. Call status to inspect completion.","inputSchema":object(json!({"requestId":{"type":"string","description":"Stable unique launch request id, reuse it when retrying"},"definition":{"type":"object","additionalProperties":true},"ref":{"type":"object","properties":{"id":{"type":"string"},"revision":{"type":"integer"}},"required":["id","revision"]},"inputs":{"type":"object","additionalProperties":true},"bindings":{"type":"object","additionalProperties":true}}),vec!["requestId","inputs","bindings"])}));
            tools.push(json!({"name":"agenthub_workflow_templates","description":"List saved Agent workflows with pinned revisions and role requirements. Inspect the returned definitions to prepare all prompts and bindings before starting.","inputSchema":object(json!({}),vec![])}));
            tools.push(json!({"name":"agenthub_workflow_plan_context","description":"When the user references a saved workflow in this message, read its pinned definition, all Agent node keys and the real team roster before preparing a plan.","inputSchema":object(json!({}),vec![])}));
            tools.push(json!({"name":"agenthub_workflow_propose","description":"Submit an editable workflow plan for the saved workflow referenced in this message. Use the exact node keys supplied by agenthub_workflow_plan_context. Each node entry has a task and a real team memberId, or agentInstanceId for a solo conversation. Provide all required workflow inputs. The plan waits for the user's decision.","inputSchema":object(json!({"summary":{"type":"string"},"inputs":{"type":"object","additionalProperties":true},"nodes":{"type":"object","additionalProperties":true}}),vec!["inputs","nodes"])}));
        }
        tools.push(json!({"name":"agenthub_workflow_status","description":"Inspect a workflow launched by this conversation, its node instances, results and reminders.","inputSchema":object(json!({"runId":{"type":"string"}}),vec!["runId"])}));
        tools.push(json!({"name":"agenthub_workflow_schema","description":"Read the complete workflow v1 language, bindings, prompt variables, joins, foreach, bounded loops, pinned subworkflows and a valid example. Read before writing an ad-hoc graph.","inputSchema":object(json!({}),vec![])}));
        if is_main {
            tools.push(json!({"name":"agenthub_workflow_agents","description":"List real enabled Harness instances and team members, stable binding ids, selected settings and declared capabilities. Use these ids in workflow bindings rather than inventing them.","inputSchema":object(json!({}),vec![])}));
        }
        let fallback_execute = fallback.map(|f| f.execute);
        let service = self.workflows.clone();
        let session_id = session["id"].as_str().unwrap_or("").to_string();
        let invoking_run = context["runId"].as_str().map(str::to_owned);
        Some(RuntimeToolBinding {
            tools,
            execute: Arc::new(move |call: Value| {
                let service = service.clone();
                let workflow = workflow.clone();
                let session_id = session_id.clone();
                let invoking_run = invoking_run.clone();
                let reference = reference.clone();
                let execute = fallback_execute.clone();
                Box::pin(async move {
                    let name = call["name"].as_str().unwrap_or("");
                    if !name.starts_with("agenthub_workflow_") {
                        return match execute {
                            Some(execute) => execute(call).await,
                            None => Err(anyhow::anyhow!("Unknown runtime tool")),
                        };
                    }
                    let service = service
                        .upgrade()
                        .ok_or_else(|| anyhow::anyhow!("The workflow runtime has stopped"))?;
                    let args = call.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    if !args.is_object() {
                        return Err(anyhow::anyhow!("Tool arguments must be an object"));
                    }
                    let result: anyhow::Result<Value> = match name {
                        "agenthub_workflow_submit" => {
                            let scope = workflow.ok_or_else(|| {
                                anyhow::anyhow!("Submission requires a workflow-node execution")
                            })?;
                            // The captured callback supplies authority. The echoed scope
                            // only prevents a delayed old turn from submitting to a newly
                            // activated node when the native session/transport is reused.
                            if args["instanceId"] != scope["instanceId"]
                                || args["attempt"] != scope["attempt"]
                            {
                                anyhow::bail!("Stale workflow submission: instanceId and attempt must match the current task prompt");
                            }
                            service
                                .submit(
                                    scope["runId"].as_str().unwrap(),
                                    scope["instanceId"].as_str().unwrap(),
                                    scope["attempt"].as_u64().unwrap_or(1) as u32,
                                    &args,
                                )
                                .map_err(Into::into)
                        }
                        "agenthub_workflow_run" => {
                            if !is_main {
                                return Err(anyhow::anyhow!(
                                    "Starting a workflow requires the main conversation"
                                ));
                            }
                            if reference.is_some() {
                                anyhow::bail!("This turn is for planning the referenced workflow. Use agenthub_workflow_propose and wait for the user's confirmation.");
                            }
                            let mut input = args;
                            input["sessionId"] = json!(session_id);
                            service.start_in_turn(&input, invoking_run.as_deref()).map_err(Into::into)
                        }
                        "agenthub_workflow_plan_context" | "agenthub_workflow_propose" => {
                            let reference = reference.as_ref().filter(|_| is_main)
                                .ok_or_else(|| anyhow::anyhow!("Reference a saved workflow in the current message first"))?;
                            if name == "agenthub_workflow_plan_context" {
                                service.plan_context(&session_id, reference).map_err(Into::into)
                            } else {
                                let origin = invoking_run.as_deref().ok_or_else(|| anyhow::anyhow!("The planning turn is missing"))?;
                                service.propose_plan(&session_id, origin, reference, &args).map_err(Into::into)
                            }
                        }
                        "agenthub_workflow_spawn" => {
                            let scope = workflow.as_ref().ok_or_else(|| anyhow::anyhow!("A child launch requires an active node"))?;
                            service.start_dynamic_subflow(scope, &args).map_err(Into::into)
                        }
                        "agenthub_workflow_templates" => {
                            if !is_main {
                                return Err(anyhow::anyhow!(
                                    "Listing templates requires the main conversation"
                                ));
                            }
                            service.list_templates().map_err(Into::into)
                        }
                        "agenthub_workflow_schema" => {
                            Ok(crate::runtime::workflow::language_reference())
                        }
                        "agenthub_workflow_agents" => {
                            if !is_main {
                                return Err(anyhow::anyhow!(
                                    "Listing Harness bindings requires the main conversation"
                                ));
                            }
                            service.agents_for_session(&session_id).map_err(Into::into)
                        }
                        "agenthub_workflow_status" => {
                            let run = service.get(args["runId"].as_str().unwrap_or(""))?;
                            if run.session_id != session_id
                                && workflow.as_ref().is_none_or(|w| w["runId"] != run.id)
                                && !workflow.as_ref().is_some_and(|scope| service.owns_dynamic_subflow(scope, &run.id))
                            {
                                return Err(anyhow::anyhow!(
                                    "Workflow belongs to a different conversation"
                                ));
                            }
                            Ok(super::public_view(&run))
                        }
                        _ => Err(anyhow::anyhow!("Unknown workflow tool")),
                    };
                    Ok(json!({"success":true,"content":result?.to_string()}))
                }) as BoxFuture<anyhow::Result<Value>>
            }),
        })
    }
}
