//! The language reference travels through the native runtime tool transport.
use serde_json::{json, Value};
pub fn language_reference() -> Value {
    let mut reference = json!({
        "schemaVersion":1,
        "launch":{
            "requestId":"Unique stable id. Reuse only when retrying the exact launch after a lost receipt.",
            "definition":"Complete definition OR pinned ref {id,revision}; never both.",
            "inputs":"Object satisfying definition.inputs. Declared top-level fields are required.",
            "bindings":"Map every role, including nested templates, to {memberId} or {agentInstanceId}. Optional connectionId, connectionRevision, model, reasoningEffort, serviceTier, permissionMode pin the configuration. Omitted values inherit the selected member/caller."
        },
        "definition":{
            "schemaVersion":1,"id":"Stable nonempty id","entry":"Id of a main node","name":"Optional display label",
            "inputs":"Map field names to TypeSpec","nodes":"Array of node types below; all must be reachable.",
            "edges":"One edge per exit: {from:[nodeId,exitId],to:nodeId|$return|$return_needs_decision}. Feedback edges also need positive maxTraversals and onLimit. Every cycle must consume a bounded edge.",
            "limits":{"maxInstances":1000,"timeoutMs":3600000,"maxParallel":8,"maxDepth":8}
        },
        "typeSpec":["text","number","boolean","json","list<text>","list<json>",{"enum":["pass","revise"]},{"properties":{"summary":"text","evidence":"list<text>"},"required":["summary"]}],
        "commonNode":{"id":"Unique node id; cannot start with $","name":"Optional label","kind":"main | dispatch | agent | join | condition | call","exits":[{"id":"stable-exit-id","name":"Agent-facing name, unique in this node"}],"onError":"Optional recovery exit id. Otherwise a join decides whether remaining producers can satisfy it, or the engine returns needs_decision."},
        "nodeTypes":{
            "main":"Dispatch gateway. Entry represents the existing caller; no model turn. All exits dispatch. dispatch:'all' explicitly creates a join scope even for one branch. Additional main nodes create nested scopes and forward upstream data.",
            "dispatch":"Automatic broadcast gateway, with no model turn. It forwards its incoming evidence to every named exit and establishes a dispatch scope even for one branch. Join nodes can reference this gateway as their scope.",
            "agent":{
                "completion":"tool (default): submit with the scoped runtime tool; structured_final: explicitly use a final JSON object {branch,result}, validated by the same engine when the native turn finishes. This supports Harnesses without runtime tools without disabling their native features.",
                "persistentEvidence":"{{steps.nodeId.latest.result}} and {{steps.nodeId.instances}} preserve completed evidence across feedback loops. Prefix literal {{ with a backslash; injected input values are never parsed a second time.",
                "role":"Bound configured Agent/member role","prompt":"Required before launch. Variables: {{input.field}}, {{incoming}}, {{incoming.result.summary}}, {{item.key}}, {{exit.done}}. exit.<id> renders the frozen exit NAME. Missing variables fail validation/activation.",
                "outputs":"Map required result fields to TypeSpec","exitMode":"one (default) | some (multi-select)","session":"fresh (default) | reuse (this node's prior completed native session)",
                "forEach":{"source":"input.items or incoming.result.items","key":"Unique string/number path relative to each item","maxItems":20,"maxParallel":3,"emptyExit":"Exit id required when an empty list is possible"},
                "submissionPolicy":{"graceMs":3000,"reminderIntervalMs":15000,"maxReminders":1,"timeoutMs":60000}
            },
            "join":{"scope":"Id of real dispatch batch: main/multi-exit dispatch or forEach node.","sources":"Optional distinct directly connected predecessor node ids. Explicit sources allow multiple overlapping joins in one fixed dispatch batch; each join tracks its own arrivals and preserves the scope for later joins. Without sources, collect the actual branch ids or foreach item keys with one join per scope. Collect repeated foreach activations with an item join before using node sources. Feedback through source joins must re-enter their dispatch scope to start a fresh batch.","wait":"all | firstValid | quorum","quorum":"Positive count for quorum","remaining":"continue (default) | cancel. Source joins cancel only their remaining named producers, not unrelated batch work; cancelled producers not yet activated are skipped.","exits":"Use one exit. Merged incoming/result map original branch ids, stable item keys or explicit source node ids to results."},
            "condition":{"cases":[{"path":"incoming.result.approved","equals":true,"exit":"pass"}],"otherwise":"Required fallback exit id. Runs locally without a model."},
            "call":{"ref":{"id":"saved-template","revision":1},"input":{"question":"{{input.question}}"},"exitMap":{"child exit NAME":"local-exit-id"},"outputs":"Result is {returns:[{from,branch,result,...}]}. Map every child return. Pinned refs must be acyclic and within maxDepth."}
        },
        "completion":"For tool completion, echo instanceId and attempt from the latest [NAUTILO_WORKFLOW_NODE] prompt scope, plus exactly one of branch (name) or branches (names) and result, through workflow_submit / agenthub_workflow_submit (possibly MCP-namespaced). The backend-captured scope is authoritative; echoed ids prevent late submissions from advancing another activation. Valid submission AND finished execution are required. Receipts are durable and duplicate-safe. Missing results trigger a turn in the original child session, then a main-session decision request on timeout. Native tools, approvals, accounts and session identity stay in the normal pipeline.",
        "minimalExample":{
            "schemaVersion":1,"id":"single-explore","entry":"main","inputs":{"question":"text"},
            "nodes":[{"id":"main","kind":"main","exits":[{"id":"go","name":"开始探索"}]},{"id":"explore","kind":"agent","role":"Explorer","prompt":"调查 {{input.question}}，给出可复核证据，提交「{{exit.done}}」。","outputs":{"summary":"text","evidence":"list<text>"},"exits":[{"id":"done","name":"探索完成"}]}],
            "edges":[{"from":["main","go"],"to":"explore"},{"from":["explore","done"],"to":"$return"}]
        }
    });
    reference["jsonSchema"] = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/agent-workflows/schema.v1.json"
    )))
    .expect("checked workflow language schema");
    reference
}
