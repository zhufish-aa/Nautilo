declare module "virtual:workflow-fixtures" {
  const state: Record<string, import("@agenthub/domain").WorkflowRun>;
  export default state;
  export const evidence: { artifacts: import("@agenthub/domain").Artifact[]; approvals: import("@agenthub/domain").ApprovalRecord[] };
}
