import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, ArrowUpRight, Check, CheckCircle2, Clock3, Copy, FileText, GitBranch, Loader2, Sparkles } from "lucide-react";
import type { WorkflowDefinition, WorkflowInstance, WorkflowNode, WorkflowRun } from "@agenthub/domain";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { providerMeta } from "../../lib/provider-catalog";
import { toast } from "../../stores/toast";
import { WorkflowWorkspace, type WorkspaceAction } from "./WorkflowAcceptance";
import { WorkflowIncoming } from "./WorkflowDispatchCard";
import { WorkflowSegments, WorkflowSelect } from "./WorkflowSelect";
import { findEdge } from "./workflow-geometry";
import { nodeLabel, nodeTone, statusLabels } from "./workflow-model";

type RunTab = "output" | "prompt" | "routing";

const APPROVED_SPLIT = /\r?\n\s*Task approved for this workflow run:\s*\r?\n/i;

function splitTaskPrompt(raw: string | undefined): { context?: string; approved?: string; plain?: string } {
  if (!raw?.trim()) return {};
  const trimmed = raw.trim();
  const match = APPROVED_SPLIT.exec(trimmed);
  if (!match || match.index === undefined) return { plain: trimmed };
  const before = trimmed.slice(0, match.index).trim();
  const after = trimmed.slice(match.index + match[0].length).trim();
  if (!after) return { plain: trimmed };
  return { context: before || undefined, approved: after };
}

function PromptTokens({ text }: { text?: string }): JSX.Element {
  return <>{text?.split(/(\{\{[^{}\r\n]+\}\})/g).map((part, index) => index % 2 ? <code key={index}>{part}</code> : part)}</>;
}

function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    summary: "核心结论",
    evidence: "核对依据",
    conclusion: "结论",
    findings: "发现项",
    recommendations: "建议",
    risks: "风险",
    files: "涉及文件",
    next_steps: "后续步骤"
  };
  return labels[key] ?? key;
}

function StructuredResult({ result }: { result: unknown }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const rawJson = useMemo(() => {
    try { return typeof result === "string" ? result : JSON.stringify(result, null, 2); }
    catch { return String(result); }
  }, [result]);

  const copyResult = (): void => {
    void navigator.clipboard?.writeText(rawJson).then(() => {
      setCopied(true);
      toast.success("已复制节点结果");
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  if (typeof result === "string") {
    return (
      <div className="wf-run-result-card">
        <div className="wf-run-card-bar">
          <span className="wf-run-card-title"><Sparkles size={12} aria-hidden />产出结果</span>
          <button type="button" className="wf-run-copy-btn" onClick={copyResult}>
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
        </div>
        <p className="wf-run-prose">{result}</p>
      </div>
    );
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const entries = Object.entries(result as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (entries.length) {
      // Put summary/conclusion first for immediate readability
      const ordered = [...entries].sort(([a], [b]) => {
        const rank = (k: string) => k === "summary" || k === "conclusion" ? 0 : k === "evidence" || k === "findings" ? 1 : 2;
        return rank(a) - rank(b);
      });
      return (
        <div className="wf-run-result-stack">
          <div className="wf-run-card-bar">
            <span className="wf-run-card-title"><CheckCircle2 size={12} aria-hidden />结构化提交结果</span>
            <button type="button" className="wf-run-copy-btn" onClick={copyResult}>
              {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
              <span>{copied ? "已复制" : "复制 JSON"}</span>
            </button>
          </div>
          {ordered.map(([key, value]) => (
            <div key={key} className="wf-run-result-section" data-primary={key === "summary" || key === "conclusion" || undefined}>
              <span className="wf-run-field-tag">{fieldLabel(key)}</span>
              {typeof value === "string" ? (
                <p className="wf-run-prose">{value}</p>
              ) : Array.isArray(value) ? (
                <ul className="wf-run-evidence-list">
                  {value.map((item, idx) => (
                    <li key={idx}>
                      {typeof item === "string" ? item : <code>{JSON.stringify(item)}</code>}
                    </li>
                  ))}
                </ul>
              ) : (
                <pre className="wf-run-code">{JSON.stringify(value, null, 2)}</pre>
              )}
            </div>
          ))}
          <details className="wf-run-raw-toggle">
            <summary>查看原始 JSON</summary>
            <pre className="wf-run-code">{rawJson}</pre>
          </details>
        </div>
      );
    }
  }

  return (
    <div className="wf-run-result-card">
      <div className="wf-run-card-bar">
        <span className="wf-run-card-title">提交结果</span>
        <button type="button" className="wf-run-copy-btn" onClick={copyResult}>
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="wf-run-code">{rawJson}</pre>
    </div>
  );
}

export function WorkflowRunInspector({
  run,
  definition,
  node,
  selected,
  targetName,
  latestInstance,
  nodeInstances,
  assignment,
  taskPrompt,
  inspectorNodeChoices,
  sequence,
  busy,
  onSelectNode,
  onSelectInstance,
  onOpenSession,
  onInspectRun,
  onControl,
  onRetryInstance
}: {
  run?: WorkflowRun;
  definition: WorkflowDefinition;
  node?: WorkflowNode;
  selected: string;
  targetName: (id?: string) => string;
  latestInstance?: WorkflowInstance;
  nodeInstances: WorkflowInstance[];
  assignment?: { providerId?: string; model?: string };
  taskPrompt?: string;
  inspectorNodeChoices: { value: string; label: string }[];
  sequence?: number;
  busy: boolean;
  onSelectNode: (id: string) => void;
  onSelectInstance: (id: string) => void;
  onOpenSession: (id: string) => void;
  onInspectRun: (id: string) => void;
  onControl: (action: WorkspaceAction | "decline_retry", instanceId?: string) => Promise<void>;
  onRetryInstance: (instanceId: string) => void;
}): JSX.Element {
  const hasOutput = Boolean(
    latestInstance && (
      latestInstance.result !== undefined
      || latestInstance.lastOutput
      || latestInstance.submissionError
      || latestInstance.error
      || Object.keys(latestInstance.nativeWork?.children || {}).length > 0
    )
  );
  const needsApproval = Boolean(latestInstance?.workspace?.stage === "waiting_approval");
  const defaultTab: RunTab = needsApproval ? "routing" : hasOutput ? "output" : "prompt";
  const [tab, setTab] = useState<RunTab>(defaultTab);

  // Switch cleanly to output when user selects a completed node, or prompt when not yet done
  useEffect(() => {
    setTab(needsApproval ? "routing" : hasOutput ? "output" : "prompt");
  }, [selected, latestInstance?.id, hasOutput, needsApproval]);

  const parsedPrompt = useMemo(() => splitTaskPrompt(taskPrompt ?? node?.prompt), [taskPrompt, node?.prompt]);
  const durationLabel = latestInstance?.completedAt != null
    ? `${((latestInstance.completedAt - latestInstance.createdAt) / 1000).toFixed(1)}s`
    : undefined;
  const isRunning = Boolean(latestInstance && ["running", "starting", "verifying"].includes(latestInstance.status));
  const statusTone = !latestInstance ? "idle"
    : latestInstance.status === "completed" ? "ok"
      : latestInstance.status === "failed" ? "danger"
        : isRunning ? "running" : "warn";

  const hasRoutingOrAcceptance = Boolean(
    (run && latestInstance && (latestInstance.workspace || latestInstance.acceptance))
    || (node && node.exits.length > 0)
  );

  return (
    <div className="wf-run-inspector">
      <header className="wf-run-hero" data-tone={node ? nodeTone(node) : "neutral"}>
        <div className="wf-run-hero-main">
          <div className="wf-run-hero-title-row">
            <h2>{node ? nodeLabel(node) : targetName(selected)}</h2>
            {node?.role && <span className="wf-run-role-pill">{node.role}</span>}
            {latestInstance && (
              <span className="wf-run-status-inline" data-tone={statusTone}>
                {isRunning ? <Loader2 size={11} className="wf-plan-node-spin" aria-hidden /> : <i aria-hidden />}
                <span>{statusLabels[latestInstance.status]}</span>
                {durationLabel && <span className="wf-run-duration-sep">· {durationLabel}</span>}
                {latestInstance.iteration > 1 && <span className="wf-run-duration-sep">· 第 {latestInstance.iteration} 次</span>}
              </span>
            )}
          </div>

          <div className="wf-run-hero-sub">
            {assignment && latestInstance?.sessionId && (
              <span className="wf-run-model-chip">
                {assignment.providerId && <ProviderAvatar providerId={assignment.providerId} size="sm" />}
                <span>
                  {[assignment.providerId && providerMeta(assignment.providerId).name, assignment.model || "原生默认模型"].filter(Boolean).join(" · ")}
                </span>
              </span>
            )}
            {nodeInstances.length > 1 && latestInstance && (
              <WorkflowSelect
                label="选择节点执行实例"
                value={latestInstance.id}
                options={nodeInstances.map(inst => ({ value: inst.id, label: `第 ${inst.iteration} 次 · ${statusLabels[inst.status]}` }))}
                onChange={onSelectInstance}
              />
            )}
          </div>
        </div>

        <div className="wf-run-hero-actions">
          {latestInstance?.sessionId && (
            <button type="button" className="wf-run-session-btn" onClick={() => onOpenSession(latestInstance.sessionId!)}>
              <span>打开子会话</span>
              <ArrowUpRight size={13} aria-hidden />
            </button>
          )}
          {latestInstance?.childRunId && (
            <button type="button" className="wf-run-session-btn" onClick={() => onInspectRun(latestInstance.childRunId!)}>
              <span>展开子流程</span>
              <ArrowUpRight size={13} aria-hidden />
            </button>
          )}
          {!node && run && (
            <button type="button" className="wf-run-session-btn" onClick={() => onOpenSession(run.sessionId)}>
              <span>打开主会话</span>
              <ArrowUpRight size={13} aria-hidden />
            </button>
          )}
          <WorkflowSelect
            label="切换节点"
            placeholder="切换节点"
            value={selected || undefined}
            options={inspectorNodeChoices}
            onChange={onSelectNode}
          />
        </div>
      </header>

      {node?.kind === "agent" ? (
        <>
          <div className="wf-run-tabs">
            <WorkflowSegments<RunTab>
              label="节点执行详情"
              value={tab}
              onChange={setTab}
              options={[
                { value: "output", label: "结果产出" },
                { value: "prompt", label: "任务与传入" },
                { value: "routing", label: "路由与验收", warning: needsApproval }
              ]}
            />
          </div>

          <div className="wf-run-panel">
            {tab === "output" && (
              <div className="wf-run-tab-content">
                {run?.status === "running" && sequence === undefined && latestInstance?.status === "waiting_retry" && (
                  <div className="wf-run-alert-card">
                    <div className="wf-run-alert-head"><AlertTriangle size={14} aria-hidden /><strong>等待重试确认</strong></div>
                    <p>{latestInstance.error || "此节点执行中断，等待决定是否重试。"}</p>
                    <div className="wf-workspace-actions">
                      <button type="button" disabled={busy} onClick={() => void onControl("decline_retry", latestInstance.id)}>按失败处理</button>
                      <button type="button" disabled={busy} className="wf-primary" onClick={() => onRetryInstance(latestInstance.id)}>重试此节点</button>
                    </div>
                  </div>
                )}

                {latestInstance?.submissionError && (
                  <div className="wf-run-alert-card" data-tone="warn">
                    <div className="wf-run-alert-head"><AlertTriangle size={13} aria-hidden /><strong>提交校验提示</strong></div>
                    <p>{latestInstance.submissionError}</p>
                  </div>
                )}

                {latestInstance?.result !== undefined ? (
                  <StructuredResult result={latestInstance.result} />
                ) : latestInstance?.lastOutput ? (
                  <div className="wf-run-result-card">
                    <div className="wf-run-card-bar">
                      <span className="wf-run-card-title"><FileText size={12} aria-hidden />本轮已产出内容</span>
                    </div>
                    <pre className="wf-run-code">{latestInstance.lastOutput}</pre>
                  </div>
                ) : (
                  <div className="wf-run-empty-state">
                    {isRunning ? <Loader2 size={15} className="wf-plan-node-spin" aria-hidden /> : <Clock3 size={15} aria-hidden />}
                    <span>
                      {isRunning
                        ? "节点正在执行中，产出提交后将实时展示在这里"
                        : latestInstance
                          ? "该节点暂未提交结构化结果"
                          : "流程尚未推进到此节点"}
                    </span>
                  </div>
                )}

                {!!Object.keys(latestInstance?.nativeWork?.children || {}).length && (
                  <div className="wf-native-work">
                    <span>原生子 Agent</span>
                    {Object.entries(latestInstance!.nativeWork!.children).map(([id, st]) => (
                      <div key={id}>
                        <code title={id}>{id}</code>
                        <small>{latestInstance!.nativeWork!.released ? "已停止" : latestInstance!.nativeWork!.detached ? "已交回原会话" : st === "running" ? "仍在执行，流程等待中" : st === "done" ? "已完成" : "执行失败"}</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === "prompt" && (
              <div className="wf-run-tab-content">
                <div className="wf-run-prompt-card">
                  {parsedPrompt.approved ? (
                    <>
                      <div className="wf-run-prompt-block">
                        <span className="wf-run-field-tag is-accent"><Sparkles size={11} aria-hidden />当前节点指令</span>
                        <div className="wf-run-prose"><PromptTokens text={parsedPrompt.approved} /></div>
                      </div>
                      {parsedPrompt.context && (
                        <div className="wf-run-prompt-context">
                          <span className="wf-run-field-tag">任务背景</span>
                          <div className="wf-run-prose is-muted"><PromptTokens text={parsedPrompt.context} /></div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="wf-run-prompt-block">
                      <span className="wf-run-field-tag">{latestInstance?.taskText ? "任务正文" : "任务提示词"}</span>
                      <div className="wf-run-prose"><PromptTokens text={parsedPrompt.plain} /></div>
                    </div>
                  )}

                  {latestInstance?.prompt && latestInstance.prompt !== taskPrompt && (
                    <details className="wf-run-raw-toggle">
                      <summary>查看完整派发内容</summary>
                      <pre className="wf-run-code">{latestInstance.prompt}</pre>
                    </details>
                  )}
                </div>

                {run && latestInstance && <WorkflowIncoming dispatch={{ run, instance: latestInstance }} zh />}
              </div>
            )}

            {tab === "routing" && (
              <div className="wf-run-tab-content">
                {run && latestInstance && (
                  <WorkflowWorkspace
                    key={latestInstance.id}
                    run={run}
                    instance={latestInstance}
                    interactive={sequence === undefined}
                    busy={busy}
                    onControl={onControl}
                  />
                )}

                {node.exits.length > 0 && (
                  <div className="wf-run-routes-card">
                    <span className="wf-run-field-tag"><GitBranch size={11} aria-hidden />出口路由</span>
                    <div className="wf-run-routes-list">
                      {node.exits.map(exit => {
                        const conn = findEdge(definition, { source: node.id, exit: exit.id });
                        const taken = latestInstance?.branches?.includes(exit.id);
                        return (
                          <div key={exit.id} className="wf-run-route-chip" data-taken={taken || undefined}>
                            <span className="wf-run-route-name">{exit.name}</span>
                            <ArrowRight size={12} aria-hidden />
                            <span className="wf-run-route-target">{targetName(conn?.to)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!hasRoutingOrAcceptance && (
                  <div className="wf-run-empty-state"><span>此节点暂无验收或路由信息</span></div>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="wf-run-panel">
          <p className="wf-control-description">
            {node?.kind === "main"
              ? "从当前会话发起流程，同时派发已连接的出口。"
              : node?.kind === "dispatch"
                ? "将输入同时发送给所有已连接的出口，由引擎自动推进。"
                : node?.kind === "join"
                  ? "等待各并行分支结果汇齐后继续流转到下游节点。"
                  : "点击画布中的任意 Agent 节点查看详细产出、提示词与子会话。"}
          </p>
        </div>
      )}
    </div>
  );
}
