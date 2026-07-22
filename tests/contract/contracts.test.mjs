import assert from "node:assert/strict";
import {
  availableActions,
  canTransitionTask,
  createAgentHubError,
  errorCatalog
} from "../../packages/domain/dist/index.js";
import {
  isPlannerDecision,
  validatePlannerDecision
} from "../../packages/schemas/dist/index.js";

const direct = { mode: "direct", rationale: "目标很小，主 Agent 直接完成。" };
const delegate = {
  mode: "delegate",
  rationale: "把局部检查交给用户定义的成员。",
  task: {
    id: "task-1",
    title: "检查接口",
    objective: "检查接口契约",
    taskType: "review",
    assignedMemberId: "member-1",
    dependencies: [],
    allowedPaths: ["src/**"],
    acceptanceCriteria: [],
    contextNeeds: [],
    assignmentReason: "该成员由用户配置为擅长接口审查。"
  }
};

assert.equal(isPlannerDecision(direct), true);
assert.equal(isPlannerDecision(delegate), true);
assert.equal(isPlannerDecision({ mode: "direct" }), false);
assert.equal(validatePlannerDecision(direct).mode, "direct");
assert.equal(canTransitionTask("ready", "queued"), true);
assert.equal(canTransitionTask("completed", "running"), false);
assert.deepEqual(availableActions({ runStatus: "running" }), ["stop_run"]);
assert.equal(errorCatalog.RUN_TIMEOUT.retryable, true);
assert.equal(errorCatalog.PATH_POLICY_VIOLATION.retryable, false);
assert.equal(createAgentHubError("RUN_TIMEOUT").code, "RUN_TIMEOUT");

console.log("contract tests: passed");
