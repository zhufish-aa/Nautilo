import { useEffect, useState } from "react";
import { Check, ChevronRight, FileDiff, GitBranch, GitMerge, ShieldCheck, X } from "lucide-react";
import type { ApprovalRecord, Artifact, WorkflowInstance, WorkflowRun } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { requestCore } from "../../lib/bridge";

export type WorkspaceAction = "approve_merge" | "reject_merge" | "approve_verification" | "reject_verification" | "recheck_workspace" | "retain_workspace";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.map(record) : [];
const stageLabels: Record<string, string> = {
  unplanned: "正在准备工作区", planning: "正在固定执行起点", planned: "正在准备工作区", preparing: "正在准备工作区",
  ready: "工作区已就绪", verifying: "正在验收变更", waiting_approval: "验收命令需要批准",
  waiting_merge: "变更已验收，等待合并", merging: "正在合入原项目", passed: "节点验收通过",
  complete: "验收已完成", retained: "已保留独立成果", failed: "验收未通过", uncertain: "执行结果需要核对", cancelled: "已停止验收", recheck_requested: "等待重新验收", rechecking: "正在核对工作区",
};

function ArtifactContent({ artifact }: { artifact: Artifact }): JSX.Element {
  let files: Array<Record<string, unknown>> = [];
  if (artifact.kind === "diff") { try { files = rows(record(JSON.parse(artifact.content || "{}")).files); } catch { /* The original content remains inspectable below. */ } }
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return <pre className="wf-artifact-text">{artifact.content || "这份记录没有内嵌文本。"}</pre>;
  return <div className="wf-change-review">{files.map((file, index) => {
    const diff = text(file.diff), limit = expanded ? diff.length : 120_000;
    return <details key={index} open={files.length <= 3}>
      <summary><FileDiff size={14}/><span>{text(file.path)}</span><small>+{Number(file.additions) || 0} / −{Number(file.deletions) || 0}</small></summary>
      <pre>{diff.slice(0, limit) || "二进制文件或无文本差异。"}{diff.length > limit && "\n…此文件较大，当前展示前 120 KB。"}</pre>
      {diff.length > limit && <button onClick={() => setExpanded(true)}>显示完整差异</button>}
    </details>;
  })}</div>;
}

export function WorkflowWorkspace({ run, instance, interactive, busy, onControl }: {
  run: WorkflowRun; instance?: WorkflowInstance; interactive: boolean; busy: boolean;
  onControl: (action: WorkspaceAction, instanceId?: string) => Promise<void>;
}): JSX.Element | null {
  const workspace = instance ? instance.workspace : run.workspace;
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [approvals, setApprovals] = useState<Array<ApprovalRecord & { cwd?: string; command?: string; args?: string[] }>>([]);
  const [approvalError, setApprovalError] = useState("");
  const [artifact, setArtifact] = useState<Artifact>(), [artifactError, setArtifactError] = useState(""), [artifactOpen, setArtifactOpen] = useState(false);
  const [loadingArtifact, setLoadingArtifact] = useState(false);
  const approvalIds = JSON.stringify(workspace?.stage === "waiting_approval" ? workspace.context.approvalIds || [] : []);
  useEffect(() => {
    let disposed = false; setApprovals([]); setApprovalError("");
    const ids = JSON.parse(approvalIds) as string[];
    if (interactive && ids.length) void requestCore<typeof approvals>("approval.list", {}).then(records => {
      if (!disposed) setApprovals(records.filter(record => ids.includes(record.id)));
    }).catch(error => { if (!disposed) setApprovalError(String(error)); });
    return () => { disposed = true; };
  }, [approvalIds, interactive]);
  // A replay may display past evidence; it must never expose live approvals.
  useEffect(() => { setArtifactOpen(false); setArtifact(undefined); }, [run.id, instance?.id]);
  if (!workspace) return null;
  const outcome = record(workspace.outcome), checkpoint = record(outcome.taskCheckpoint);
  const verification = [...rows(outcome.verificationResults), ...rows(checkpoint.verificationResults), ...rows(outcome.mergeVerificationResults)];
  const files = rows(outcome.files), stage = workspace.stage;
  const recover = stage === "uncertain" || (!instance && stage === "failed");
  const canRecheck = instance ? run.status === "running" && instance.status === "verifying" : !!run.acceptance && ["finalizing", "needs_decision"].includes(run.status);
  const isolated = workspace.context.workspaceMode === "git_isolated" || run.workspace?.context.workspaceMode === "git_isolated";
  const merge = !instance && stage === "waiting_merge";
  const pending = stage === "waiting_approval";
  const approvalCount = (JSON.parse(approvalIds) as string[]).length;
  const readyToApprove = approvalCount > 0 && approvals.length === approvalCount && approvals.every(approval => approval.status === "pending");
  async function openArtifact(id: string): Promise<void> {
    setArtifactOpen(true); setArtifact(undefined); setArtifactError(""); setLoadingArtifact(true);
    try {
      const artifacts = await requestCore<Artifact[]>("artifact.list", { projectRunId: run.workspace?.context.artifactProjectRunId || run.workspace?.ownerRunId || run.id });
      const match = artifacts.find(artifact => artifact.id === id);
      if (!match) throw new Error("未找到这份验收记录，请刷新后重试。");
      setArtifact(match);
    } catch (error) { setArtifactError(String(error)); }
    finally { setLoadingArtifact(false); }
  }
  return <section className={"wf-workspace " + (instance ? "wf-workspace-node" : "wf-workspace-run")} aria-label={instance ? "节点工作区与验收" : "流程工作区与验收"} data-stage={stage}>
    <div className="wf-workspace-heading">
      <span className="wf-workspace-symbol">{merge ? <GitMerge size={17}/> : stage === "passed" || stage === "complete" ? <ShieldCheck size={17}/> : <GitBranch size={17}/>}</span>
      <div><strong>{stageLabels[stage] || stage}</strong><p>{merge ? "合入 " + text(workspace.context.baseBranch) + " · " + files.length + " 个文件" : isolated ? instance ? "独立节点工作区" : "独立工作区 · 验收后交给下游" : "沿用项目工作区与验收规则"}</p></div>
      {typeof outcome.diffArtifactId === "string" && <button className="wf-evidence-button" onClick={() => void openArtifact(outcome.diffArtifactId as string)}><FileDiff size={13}/>查看变更</button>}
    </div>
    {(merge || instance || recover) && <dl className="wf-workspace-facts">
      {!!workspace.context.workspacePath && <><dt>目录</dt><dd title={text(workspace.context.workspacePath)}>{text(workspace.context.workspacePath)}</dd></>}
      {!!workspace.context.branchName && <><dt>分支</dt><dd>{text(workspace.context.branchName)}</dd></>}
      {merge && <><dt>提交</dt><dd className="wf-commit-range"><code title={text(workspace.context.baseCommit)}>{text(workspace.context.baseCommit).slice(0, 10)}</code><ChevronRight size={11}/><code title={text(outcome.sourceCommit)}>{text(outcome.sourceCommit).slice(0, 10)}</code></dd></>}
    </dl>}
    {!!verification.length && <div className="wf-verification-results">{verification.map((check, index) => <div key={text(check.id) || index}>
      {check.passed ? <Check size={13}/> : <X size={13}/>}<span>{text(check.commandTemplateId)}</span><small>{check.cancelled ? "已取消" : check.passed ? "通过" : check.required === false ? "未通过（可选）" : "未通过"} · {(Number(check.durationMs) / 1000).toFixed(1)}s</small>
      {typeof check.outputArtifactId === "string" && <button onClick={() => void openArtifact(check.outputArtifactId as string)}>日志</button>}
    </div>)}</div>}
    {pending && <div className="wf-command-review">
      {interactive ? approvals.map(approval => <div key={approval.id}><strong>{approval.command ? [approval.command, ...(approval.args || []).map(arg => JSON.stringify(arg))].join(" ") : approval.summary}</strong>{approval.cwd && <code>{approval.cwd}</code>}</div>) : <p>当时正在等待验收命令批准。</p>}
      {interactive && !approvals.length && !approvalError && <p>正在读取待批准的命令…</p>}
      {approvalError && <p role="alert">{approvalError}</p>}
      {interactive && <div className="wf-workspace-actions"><button disabled={busy} onClick={() => void onControl("reject_verification", instance?.id)}>拒绝验收</button><button className="wf-primary" disabled={busy || !readyToApprove} onClick={() => void onControl("approve_verification", instance?.id)}>批准这些命令</button></div>}
    </div>}
    {merge && interactive && <div className="wf-workspace-actions"><span>也可以保留独立成果，稍后处理。</span><button disabled={busy} onClick={() => void onControl("reject_merge")}>保留成果</button><button className="wf-primary" disabled={busy} onClick={() => void onControl("approve_merge")}><GitMerge size={13}/>合入原项目</button></div>}
    {recover && interactive && (canRecheck || !!instance) && <div className="wf-workspace-actions">
      <button disabled={busy} onClick={() => void onControl("retain_workspace", instance?.id)}>保留成果</button>
      {canRecheck && <button className="wf-primary" disabled={busy} onClick={() => setRecheckOpen(true)}>重新验收</button>}
    </div>}
    {!!(workspace.error || stage === "failed" && outcome.message) && <p className="wf-workspace-error" role="status">{workspace.error || text(outcome.message)}</p>}
    <Dialog open={artifactOpen} onOpenChange={setArtifactOpen} title={artifact?.name || "验收记录"} widthClass="max-w-5xl">
      <div className="wf-artifact-review" aria-busy={loadingArtifact}>{loadingArtifact ? <p>正在读取保存的记录…</p> : artifactError ? <p role="alert">{artifactError}</p> : artifact && <ArtifactContent artifact={artifact}/>}</div>
    </Dialog>
    <Dialog open={recheckOpen} onOpenChange={setRecheckOpen} title="重新验收" description={instance ? "确认上次验收命令已经结束。引擎会核对旧进程，再检查节点现有的成果。" : "确认上次验收命令已经结束。引擎会核对原分支与独立成果，然后重新执行验收。通过后会重新请你确认合入。"}>
      <div className="wf-dialog-actions"><button onClick={() => setRecheckOpen(false)}>取消</button><button className="wf-primary" disabled={busy} onClick={() => { setRecheckOpen(false); void onControl("recheck_workspace", instance?.id); }}>确认重新验收</button></div>
    </Dialog>
  </section>;
}
