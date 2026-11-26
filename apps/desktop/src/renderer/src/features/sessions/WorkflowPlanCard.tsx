import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowUpRight, Check, ChevronDown, Clock3, Loader2, PanelRightOpen, Play, RotateCcw, Square, Workflow, X } from "lucide-react";
import { create } from "zustand";
import type { WorkflowInstance, WorkflowNodeStatus, WorkflowPlan, WorkflowPlanAssignment, WorkflowRun } from "@agenthub/domain";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { formatDurationMs } from "../../lib/subagent-result";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { useAgentsStore } from "../../stores/agents";
import { useComposerDraftsStore } from "../../stores/composer-drafts";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { useSessionsStore } from "../../stores/sessions";
import type { AgentInstanceConfig } from "../../lib/types";
import { nodeTone, workflowEventText } from "../workflows/workflow-model";
import { SessionModelControl, type ComposerConfiguration } from "./SessionModelControl";
import "./workflow-plan.css";

type Assignments = Record<string, WorkflowPlanAssignment>;
const NO_EDITS: Assignments = {};
const usePlanEdits = create<{ edits: Record<string, Assignments> }>(() => ({ edits: {} }));

const ACTIVE_RUN_STATUSES = new Set(["running", "paused", "finalizing"]);
const RUNNING_NODE_STATUSES = new Set<WorkflowNodeStatus>(["starting", "running", "verifying"]);

const executionLabels: Record<string, readonly [string, string, string]> = {
  running: ["执行中", "Running", "indigo"],
  paused: ["已暂停", "Paused", "amber"],
  finalizing: ["收尾中", "Finalizing", "indigo"],
  completed: ["已完成", "Completed", "emerald"],
  failed: ["执行失败", "Failed", "danger"],
  cancelled: ["已停止", "Stopped", "neutral"],
  needs_decision: ["待处理", "Needs attention", "amber"]
};

const nodeStatusMeta: Record<WorkflowNodeStatus, readonly [string, string, "running" | "completed" | "failed" | "waiting" | "idle"]> = {
  ready: ["等待派发", "Queued", "waiting"],
  starting: ["派发中", "Starting", "running"],
  running: ["执行中", "Running", "running"],
  verifying: ["验收中", "Verifying", "running"],
  waiting_submission: ["待补交", "Awaiting submit", "waiting"],
  waiting_approval: ["待批准", "Needs approval", "waiting"],
  waiting_retry: ["等待重试", "Retrying", "waiting"],
  waiting_join: ["等待汇合", "Joining", "waiting"],
  completed: ["已完成", "Completed", "completed"],
  failed: ["失败", "Failed", "failed"],
  cancelled: ["已停止", "Stopped", "idle"]
};

function isAssignmentEdited(base: WorkflowPlanAssignment, current: WorkflowPlanAssignment): boolean {
  return base.agentInstanceId !== current.agentInstanceId
    || (base.model ?? "") !== (current.model ?? "")
    || (base.reasoningEffort ?? "") !== (current.reasoningEffort ?? "")
    || (base.connectionId ?? null) !== (current.connectionId ?? null);
}

function formatEffortTag(effort: string | undefined): string | undefined {
  if (!effort?.trim()) return undefined;
  const key = effort.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const labels: Record<string, string> = {
    xhigh: "Extra High",
    extra_high: "Extra High",
    high: "High",
    medium: "Medium",
    low: "Low",
    minimal: "Minimal",
    max: "Max"
  };
  return labels[key] ?? effort.trim();
}

function unescapeSlotKey(key: string): string {
  const leaf = key.split("/").at(-1) ?? key;
  return leaf.replace(/~1/g, "/").replace(/~0/g, "~");
}

function formatLiveSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function instanceResultPreview(instance: WorkflowInstance | undefined): string | undefined {
  if (!instance) return undefined;
  if (instance.error?.trim()) return instance.error.replace(/\s+/g, " ").trim();
  const res = instance.result;
  if (typeof res === "string" && res.trim()) return res.replace(/\s+/g, " ").trim();
  if (res && typeof res === "object" && !Array.isArray(res)) {
    const rec = res as Record<string, unknown>;
    for (const key of ["summary", "conclusion", "answer", "message", "text", "output"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
    }
  }
  if (instance.lastOutput?.trim()) return instance.lastOutput.replace(/\s+/g, " ").trim();
  return undefined;
}

/** Polls the live WorkflowRun graph while active and stops automatically once terminal. */
function useWorkflowPlanRun(runId: string | undefined): WorkflowRun | undefined {
  const [run, setRun] = useState<WorkflowRun>();

  useEffect(() => {
    if (!runId) {
      setRun(undefined);
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const snapshot = await requestCore<WorkflowRun>("workflow.get", { runId });
        if (disposed) return;
        if (snapshot?.id === runId) {
          setRun((prev) => (prev && prev.id === snapshot.id && prev.revision === snapshot.revision ? prev : snapshot));
          if (!ACTIVE_RUN_STATUSES.has(snapshot.status)) return;
        }
      } catch {
        if (disposed) return;
      }
      if (!disposed) {
        timer = window.setTimeout(() => void poll(), document.hidden ? 6000 : 1200);
      }
    };
    void poll();
    const onVisible = () => {
      if (!document.hidden && !disposed) {
        if (timer !== undefined) window.clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runId]);

  return run?.id === runId ? run : undefined;
}

function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Custom obsidian glass Harness selector that avoids harsh OS-native <select> popups. */
function HarnessPicker({
  value,
  current,
  options,
  disabled,
  ariaLabel,
  onSelect
}: {
  value: string;
  current?: AgentInstanceConfig;
  options: readonly AgentInstanceConfig[];
  disabled: boolean;
  ariaLabel: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number; placeAbove: boolean }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = options.some(item => item.id === value)
    ? options
    : current
      ? [current, ...options]
      : options;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const estimatedHeight = Math.min(items.length * 36 + 12, 260);
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const placeAbove = spaceBelow < estimatedHeight && rect.top > estimatedHeight;
      setCoords({
        top: placeAbove ? rect.top - 6 : rect.bottom + 6,
        left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 210) - 12),
        width: Math.max(rect.width, 200),
        placeAbove
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = current?.displayName ?? value;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="wf-harness-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
      >
        {current && (
          <span className="wf-harness-trigger-avatar" aria-hidden>
            <ProviderAvatar providerId={current.providerId} size="sm" />
          </span>
        )}
        <span className="wf-harness-trigger-label">{label}</span>
        <ChevronDown size={13} className="wf-harness-trigger-caret" aria-hidden />
      </button>
      {open && coords && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          className="wf-harness-popover"
          data-above={coords.placeAbove || undefined}
          style={{
            top: coords.top,
            left: coords.left,
            minWidth: coords.width
          }}
        >
          {items.map(item => {
            const active = item.id === value;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={active}
                className="wf-harness-option"
                data-active={active || undefined}
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
              >
                <span className="wf-harness-option-avatar" aria-hidden>
                  <ProviderAvatar providerId={item.providerId} size="sm" />
                </span>
                <span className="wf-harness-option-name">{item.displayName}</span>
                {active && <Check size={13} className="wf-harness-option-check" aria-hidden />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

export function WorkflowPlanCard({
  plan,
  runStatus,
  onViewExecution,
  onOpenSession
}: {
  plan: WorkflowPlan;
  runStatus?: string;
  onViewExecution?: (id: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const zh = useI18n().locale === "zh-CN";
  const reducedMotion = useUiReducedMotion();
  const instances = useAgentsStore(state => state.instances);
  const modelCatalogs = useAgentsStore(state => state.modelCatalogs);
  const connectionCatalogs = useConnectionsStore(state => state.modelCatalogs);
  const archived = useSessionsStore(state => state.sessions.find(session => session.id === plan.sessionId)?.status === "archived");
  const edits = usePlanEdits(state => state.edits[plan.id] ?? NO_EDITS);
  const pending = plan.status === "pending";
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject">();
  const [launchedRunId, setLaunchedRunId] = useState<string>();
  const sending = useRef(false);

  const effectiveRunId = plan.runId ?? launchedRunId;
  const liveRun = useWorkflowPlanRun(effectiveRunId);

  const enabled = instances.filter(item => item.enabled && item.status !== "disabled" && item.configurationKind === "harness");
  const selected = (key: string, base: WorkflowPlanAssignment) => pending ? edits[key] ?? base : base;
  const mutate = (key: string, assignment: WorkflowPlanAssignment) => {
    setError("");
    usePlanEdits.setState(state => ({
      edits: { ...state.edits, [plan.id]: { ...state.edits[plan.id], [key]: assignment } }
    }));
  };
  const decide = async (action: "approve" | "reject") => {
    if (sending.current || !pending || archived) return;
    sending.current = true;
    setBusy(action);
    setError("");
    try {
      const updated = await requestCore<WorkflowPlan>("workflow.plan.decide", {
        sessionId: plan.sessionId, planId: plan.id, action, ...(action === "approve" ? { assignments: edits } : {})
      });
      if (action === "approve" && updated?.runId) setLaunchedRunId(updated.runId);
      usePlanEdits.setState(state => {
        const next = { ...state.edits };
        delete next[plan.id];
        return { edits: next };
      });
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      setError(detail.replace(/^Error invoking remote method '[^']+': Error:\s*/i, ""));
    } finally {
      sending.current = false;
      setBusy(undefined);
    }
  };

  // Map each plan node to its latest WorkflowInstance in the live run.
  const nodeInstances = useMemo(() => {
    const map = new Map<string, WorkflowInstance>();
    if (!liveRun) return map;
    for (const inst of liveRun.instances) {
      const prev = map.get(inst.nodeId);
      if (!prev || inst.createdAt >= prev.createdAt) map.set(inst.nodeId, inst);
    }
    return map;
  }, [liveRun]);

  const effectiveRunStatus = liveRun?.status ?? runStatus;
  const execution = effectiveRunId && effectiveRunStatus ? executionLabels[effectiveRunStatus] : undefined;
  const [statusZh, statusEn, tone] = pending ? ["待确认", "Awaiting approval", "amber"]
    : plan.status === "approved" || effectiveRunId ? execution ?? ["已确认", "Approved", "neutral"] : ["已拒绝", "Rejected", "danger"];
  const pulse = pending || tone === "indigo";
  const activeRun = tone === "indigo";
  const StatusIcon = tone === "danger" ? X : tone === "amber" ? Clock3 : execution && effectiveRunStatus === "cancelled" ? Square : Check;

  const hasLiveTick = Boolean(
    liveRun && (ACTIVE_RUN_STATUSES.has(liveRun.status) || liveRun.instances.some(inst => RUNNING_NODE_STATUSES.has(inst.status)))
  );
  const now = useLiveClock(hasLiveTick);

  const rows = plan.nodes.map(node => {
    const assignment = selected(node.key, node.assignment);
    const liveInstance = nodeInstances.get(node.key) ?? nodeInstances.get(unescapeSlotKey(node.key));
    return {
      node,
      assignment,
      liveInstance,
      edited: pending && isAssignmentEdited(node.assignment, assignment),
      instance: instances.find(item => item.id === assignment.agentInstanceId)
    };
  });

  const editedCount = rows.filter(row => row.edited).length;

  // Live execution aggregates across the plan's nodes
  const liveStats = useMemo(() => {
    if (!liveRun) return undefined;
    let completed = 0;
    let running = 0;
    let failed = 0;
    for (const { liveInstance } of rows) {
      if (!liveInstance) continue;
      if (liveInstance.status === "completed") completed++;
      else if (RUNNING_NODE_STATUSES.has(liveInstance.status)) running++;
      else if (liveInstance.status === "failed") failed++;
    }
    const total = rows.length || 1;
    const progress = liveRun.status === "completed"
      ? 100
      : Math.min(100, Math.round(((completed + running * 0.35) / total) * 100));
    const latestEvent = liveRun.events.at(-1);
    const latestCaption = latestEvent ? workflowEventText(latestEvent, liveRun.definition) : undefined;
    const runDurationMs = ACTIVE_RUN_STATUSES.has(liveRun.status)
      ? Math.max(0, now - liveRun.createdAt)
      : Math.max(0, liveRun.updatedAt - liveRun.createdAt);
    return {
      completed,
      running,
      failed,
      total: rows.length,
      progress,
      latestCaption,
      durationLabel: ACTIVE_RUN_STATUSES.has(liveRun.status)
        ? formatLiveSeconds(runDurationMs)
        : formatDurationMs(runDurationMs)
    };
  }, [liveRun, rows, now]);

  const harnesses = new Map<string, string>();
  for (const { instance } of rows) {
    if (instance && !harnesses.has(instance.providerId)) harnesses.set(instance.providerId, instance.displayName);
  }
  const teamLabel = [...harnesses.values()].join(" · ") + (harnesses.size > 1 ? (zh ? " 协同" : " working together") : "");

  const handlePointerMove = (event: MouseEvent<HTMLElement>): void => {
    if (reducedMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  return (
    <article
      className="conversation-workflow-plan"
      data-status={plan.status}
      data-tone={tone}
      data-running={activeRun || undefined}
      data-reduced={reducedMotion || undefined}
      aria-label={zh ? "工作流执行计划" : "Workflow execution plan"}
      onMouseMove={handlePointerMove}
    >
      <div className="wf-plan-chrome" aria-hidden />

      <header className="wf-plan-header" data-tone={tone}>
        <div className="wf-plan-eyebrow-row">
          <span className="wf-plan-eyebrow">
            <Workflow size={13} strokeWidth={1.9} aria-hidden />
            <span>{zh ? "执行计划" : "Execution plan"}</span>
            <span className="wf-plan-eyebrow-sep" aria-hidden>·</span>
            <span>
              {liveStats
                ? (zh ? `${liveStats.completed}/${liveStats.total} 已完成` : `${liveStats.completed}/${liveStats.total} done`)
                : (zh ? `${plan.nodes.length} 个节点` : `${plan.nodes.length} nodes`)}
            </span>
            {liveStats && liveStats.running > 0 && (
              <>
                <span className="wf-plan-eyebrow-sep" aria-hidden>·</span>
                <span className="wf-plan-eyebrow-live">
                  {zh ? `${liveStats.running} 运行中` : `${liveStats.running} running`}
                </span>
              </>
            )}
          </span>

          <span className="wf-plan-status-cluster">
            {liveStats?.durationLabel && (
              <span className="wf-plan-run-duration">{liveStats.durationLabel}</span>
            )}
            <span className="wf-plan-status" data-tone={tone} role="status">
              {pulse
                ? <span className="wf-plan-status-dot" aria-hidden />
                : <StatusIcon size={12} strokeWidth={2.2} aria-hidden />}
              <span>{zh ? statusZh : statusEn}</span>
            </span>
          </span>
        </div>

        <h3 className="wf-plan-title">{plan.template.name}</h3>
        {plan.summary && <p className="wf-plan-summary">{plan.summary}</p>}

        {liveStats && (
          <div className="wf-plan-live-strip" data-running={activeRun || undefined}>
            <div className="wf-plan-progress-track" role="progressbar" aria-valuenow={liveStats.progress} aria-valuemin={0} aria-valuemax={100}>
              <span
                className="wf-plan-progress-fill"
                data-tone={tone}
                style={{ transform: `scaleX(${liveStats.progress / 100})` }}
              />
            </div>
            {liveStats.latestCaption && (
              <p className="wf-plan-live-caption" title={liveStats.latestCaption}>
                {liveStats.latestCaption}
              </p>
            )}
          </div>
        )}
      </header>

      {!!rows.length && (
        <ol className="wf-plan-timeline">
          {rows.map(({ node, assignment, liveInstance, edited, instance }, index) => {
            const defaultModel = zh ? "默认模型" : "Default model";
            const modelCatalog = assignment.connectionId && assignment.connectionRevision
              ? connectionCatalogs[connectionModelKey(assignment.connectionId, assignment.connectionRevision)]
              : modelCatalogs[assignment.agentInstanceId];
            const harnessName = instance?.displayName ?? assignment.agentInstanceId;
            const modelName = modelCatalog?.models.find(model => model.id === assignment.model)?.displayName || assignment.model || defaultModel;
            const effortLabel = formatEffortTag(assignment.reasoningEffort);
            const context = [node.scope, node.memberName !== node.role ? node.memberName : undefined].filter(Boolean).join(" · ");
            const open = expanded === node.key;
            const stepTone = nodeTone({ id: node.key, kind: "agent", role: node.role });
            const isLast = index === rows.length - 1;
            const configure = (patch: ComposerConfiguration) => mutate(node.key, {
              ...assignment, ...patch,
              ...("connectionId" in patch && !patch.connectionId ? { connectionId: null, connectionRevision: null } : {})
            });

            const liveStatus = liveInstance?.status;
            const statusInfo = liveStatus ? nodeStatusMeta[liveStatus] : undefined;
            const execState = statusInfo?.[2] ?? (liveRun ? "idle" : undefined);
            const nodeRunning = execState === "running";
            const nodeCompleted = execState === "completed";
            const nodeFailed = execState === "failed";
            const nodeWaiting = execState === "waiting";
            const nodeDurationMs = liveInstance
              ? (nodeRunning
                ? Math.max(0, now - liveInstance.createdAt)
                : liveInstance.completedAt
                  ? Math.max(0, liveInstance.completedAt - liveInstance.createdAt)
                  : liveInstance.updatedAt >= liveInstance.createdAt
                    ? liveInstance.updatedAt - liveInstance.createdAt
                    : undefined)
              : undefined;
            const nodeDurationLabel = nodeDurationMs !== undefined
              ? (nodeRunning ? formatLiveSeconds(nodeDurationMs) : formatDurationMs(nodeDurationMs))
              : undefined;
            const resultPreview = instanceResultPreview(liveInstance);
            const collapsedPreview = resultPreview ?? node.task;

            return (
              <li
                key={node.key}
                className="wf-plan-node"
                data-tone={stepTone}
                data-exec={execState}
                data-open={open || undefined}
                data-edited={edited || undefined}
                data-last={isLast || undefined}
                style={{ "--step-index": Math.min(index, 6) } as CSSProperties}
              >
                <div className="wf-plan-rail" aria-hidden>
                  <span className="wf-plan-node-index" data-exec={execState}>
                    {nodeCompleted ? (
                      <Check size={12} strokeWidth={2.5} />
                    ) : nodeFailed ? (
                      <AlertCircle size={12} strokeWidth={2.3} />
                    ) : nodeRunning ? (
                      <Loader2 size={12} strokeWidth={2.3} className="wf-plan-node-spin" />
                    ) : (
                      String(index + 1).padStart(2, "0")
                    )}
                  </span>
                  {!isLast && <span className="wf-plan-rail-line" data-lit={nodeCompleted || nodeRunning || undefined} />}
                </div>

                <div className="wf-plan-node-card">
                  <button
                    type="button"
                    className="wf-plan-node-trigger"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? undefined : node.key)}
                  >
                    <div className="wf-plan-node-head">
                      <div className="wf-plan-node-identity">
                        <span className="wf-plan-role-dot" data-exec={execState} aria-hidden />
                        <span className="wf-plan-node-name">{node.name}</span>
                        {node.role && <span className="wf-plan-role-tag">{node.role}</span>}
                        {statusInfo ? (
                          <span className="wf-plan-node-exec-badge" data-exec={execState}>
                            {nodeRunning && <span className="wf-plan-exec-pulse" aria-hidden />}
                            <span>{zh ? statusInfo[0] : statusInfo[1]}</span>
                            {liveInstance && liveInstance.attempt > 1 && (
                              <span className="wf-plan-node-attempt">#{liveInstance.attempt}</span>
                            )}
                          </span>
                        ) : (
                          context && <span className="wf-plan-node-context">{context}</span>
                        )}
                      </div>

                      <div className="wf-plan-node-trailing">
                        {nodeDurationLabel && (
                          <span className="wf-plan-node-duration" data-exec={execState}>
                            {nodeDurationLabel}
                          </span>
                        )}
                        <span className="wf-plan-assignment-chip" data-edited={edited || undefined}>
                          {instance && (
                            <span className="wf-plan-chip-avatar" aria-hidden>
                              <ProviderAvatar providerId={instance.providerId} size="sm" />
                            </span>
                          )}
                          <span className="wf-plan-chip-harness" title={harnessName}>{harnessName}</span>
                          <span className="wf-plan-chip-sep" aria-hidden>·</span>
                          <span className="wf-plan-chip-model" title={modelName}>{modelName}</span>
                          {effortLabel && (
                            <>
                              <span className="wf-plan-chip-sep" aria-hidden>·</span>
                              <span className="wf-plan-chip-effort">{effortLabel}</span>
                            </>
                          )}
                        </span>
                        <ChevronDown size={15} strokeWidth={1.8} className="wf-plan-node-chevron" aria-hidden />
                      </div>
                    </div>

                    {collapsedPreview && !open && (
                      <p
                        className="wf-plan-node-preview"
                        data-result={Boolean(resultPreview) || undefined}
                        data-error={Boolean(liveInstance?.error) || undefined}
                      >
                        {collapsedPreview}
                      </p>
                    )}
                  </button>

                  <div className="wf-plan-node-fold" data-open={open || undefined} aria-hidden={!open || undefined}>
                    <div className="wf-plan-node-clip" ref={(el) => { if (el) el.inert = !open; }}>
                      <div className="wf-plan-node-body">
                        {resultPreview && (
                          <div className="wf-plan-node-outcome" data-error={Boolean(liveInstance?.error) || undefined}>
                            <span className="wf-plan-outcome-label">
                              {liveInstance?.error
                                ? (zh ? "执行异常" : "Error")
                                : (zh ? "节点输出" : "Output")}
                            </span>
                            <p>{resultPreview}</p>
                          </div>
                        )}

                        {node.task && <p className="wf-plan-node-task">{node.task}</p>}

                        {!pending && (liveInstance?.sessionId || nodeWaiting) && (
                          <div className="wf-plan-node-links">
                            {liveInstance?.sessionId && onOpenSession && (
                              <button
                                type="button"
                                className="wf-plan-open-session"
                                onClick={() => onOpenSession(liveInstance.sessionId!)}
                              >
                                <span>{zh ? "打开子 Agent 会话" : "Open subagent conversation"}</span>
                                <ArrowUpRight size={13} aria-hidden />
                              </button>
                            )}
                          </div>
                        )}

                        {pending && (
                          <div className="wf-plan-config-bar">
                            <div className="wf-plan-config-group">
                              <span className="wf-plan-config-label">Harness</span>
                              <HarnessPicker
                                value={assignment.agentInstanceId}
                                current={instance}
                                options={enabled}
                                disabled={!!busy || archived}
                                ariaLabel={zh ? `${node.name}的 Harness` : `Harness for ${node.name}`}
                                onSelect={(id) => {
                                  mutate(node.key, id === node.assignment.agentInstanceId ? node.assignment : {
                                    agentInstanceId: id, connectionId: null, connectionRevision: null, model: "", reasoningEffort: "", serviceTier: ""
                                  });
                                }}
                              />
                            </div>

                            <div className="wf-plan-config-model">
                              <SessionModelControl
                                disabled={!!busy || archived}
                                inline
                                draft={{
                                  instanceId: assignment.agentInstanceId,
                                  configuration: {
                                    ...assignment,
                                    connectionId: assignment.connectionId ?? undefined,
                                    connectionRevision: assignment.connectionRevision ?? undefined
                                  },
                                  onChange: configure
                                }}
                              />
                            </div>

                            {edited && (
                              <button
                                type="button"
                                className="wf-plan-reset-node"
                                disabled={!!busy || archived}
                                onClick={() => mutate(node.key, node.assignment)}
                              >
                                <RotateCcw size={11} aria-hidden />
                                <span>{zh ? "恢复默认" : "Reset"}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {error && <p role="alert" className="wf-plan-error">{error}</p>}

      {(pending || (effectiveRunId && onViewExecution) || (plan.status === "rejected" && !archived)) && (
        <footer className="wf-plan-footer">
          <div className="wf-plan-team">
            {harnesses.size > 0 && (
              <>
                <span className="wf-plan-team-stack" aria-hidden>
                  {Array.from(harnesses.keys(), (providerId, idx) => (
                    <span key={providerId} className="wf-plan-team-badge" style={{ zIndex: idx + 1 }}>
                      <ProviderAvatar providerId={providerId} size="sm" />
                    </span>
                  ))}
                </span>
                <span className="wf-plan-team-meta">
                  <span className="wf-plan-team-label" title={teamLabel}>{teamLabel}</span>
                  {editedCount > 0 && (
                    <span className="wf-plan-edited-pill">
                      {zh ? `已微调 ${editedCount} 项` : `${editedCount} edited`}
                    </span>
                  )}
                </span>
              </>
            )}
          </div>

          <div className="wf-plan-actions">
            {pending ? (
              <>
                <button
                  type="button"
                  className="wf-plan-btn-reject"
                  disabled={!!busy || archived}
                  onClick={() => void decide("reject")}
                >
                  {busy === "reject" && <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden />}
                  <span>{busy === "reject" ? (zh ? "正在拒绝…" : "Rejecting…") : (zh ? "拒绝" : "Reject")}</span>
                </button>
                <button
                  type="button"
                  className="wf-plan-btn-confirm"
                  disabled={!!busy || archived}
                  onClick={() => void decide("approve")}
                >
                  {busy === "approve"
                    ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden />
                    : <Play size={12} fill="currentColor" aria-hidden />}
                  <span>{busy === "approve" ? (zh ? "正在启动…" : "Starting…") : (zh ? "确认执行" : "Approve and run")}</span>
                </button>
              </>
            ) : effectiveRunId && onViewExecution ? (
              <button
                type="button"
                className="wf-plan-btn-view"
                onClick={() => onViewExecution(effectiveRunId)}
              >
                <PanelRightOpen size={14} aria-hidden />
                <span>{zh ? "查看执行" : "View execution"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="wf-plan-btn-view"
                onClick={() => useComposerDraftsStore.getState().setWorkflow(plan.sessionId, plan.template)}
              >
                <RotateCcw size={13} aria-hidden />
                <span>{zh ? "重新引用" : "Reference again"}</span>
              </button>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}
