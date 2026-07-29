import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  Download,
  Gauge,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  XCircle,
  type LucideIcon
} from "lucide-react";
import type {
  ApprovalRecord,
  AuditRecord,
  DiagnosticExportResult,
  PermissionPolicy,
  ProjectRun,
  RecoverableProjectRun,
  RuntimeMetrics
} from "@agenthub/domain";
import { StatusChip, type ChipTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { MotionCard } from "../../components/ui/Card";
import { SelectField } from "../../components/ui/Select";
import { requestCore } from "../../lib/bridge";
import { hydrateWorkbenchSessions, resumeWorkbenchRuns } from "../../lib/orchestration-runtime";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";
import { toast } from "../../stores/toast";
import { EmptyHint, Panel, SectionHeader } from "./parts";

interface RuntimeSnapshot {
  metrics: RuntimeMetrics;
  recoverable: RecoverableProjectRun[];
  audit: AuditRecord[];
  policies: PermissionPolicy[];
  pendingApprovals: ApprovalRecord[];
}

const EMPTY_METRICS: RuntimeMetrics = {
  totalRuns: 0,
  completedRuns: 0,
  failedRuns: 0,
  retriedTasks: 0,
  conflicts: 0,
  verificationTotal: 0,
  verificationPassed: 0,
  averageRunDurationMs: 0
};

type MetricTone = "accent" | "ok" | "warn" | "danger" | "muted";

const METRIC_TONES: Record<MetricTone, { chip: string; value: string }> = {
  accent: { chip: "border-accent/20 bg-accent-soft text-accent", value: "text-ink" },
  ok: { chip: "border-ok/25 bg-ok/10 text-ok", value: "text-ink" },
  warn: { chip: "border-warn/25 bg-warn/10 text-warn", value: "text-warn" },
  danger: { chip: "border-danger/25 bg-danger/10 text-danger", value: "text-danger" },
  muted: { chip: "border-line bg-card text-ink-3", value: "text-ink" }
};

function auditTone(outcome: string): ChipTone {
  if (outcome === "success") return "ok";
  if (outcome === "denied") return "warn";
  return "danger";
}

/** Real Core-backed recovery, audit, policy and diagnostics surface. */
export function RuntimeOperationsCard(): JSX.Element {
  const locale = useSettingsStore((state) => state.locale);
  const teams = useTeamsStore((state) => state.teams);
  const zh = locale === "zh-CN";
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>({ metrics: EMPTY_METRICS, recoverable: [], audit: [], policies: [], pendingApprovals: [] });
  const [loading, setLoading] = useState(true);
  const [busyRunId, setBusyRunId] = useState<string>();
  const [replacement, setReplacement] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [metrics, recoverable, audit, policies, pendingApprovals] = await Promise.all([
        requestCore<RuntimeMetrics>("metrics.get", {}),
        requestCore<RecoverableProjectRun[]>("recovery.list"),
        requestCore<AuditRecord[]>("audit.list", { limit: 12 }),
        requestCore<PermissionPolicy[]>("policy.list"),
        requestCore<ApprovalRecord[]>("approval.list", { status: "pending" })
      ]);
      setSnapshot({ metrics, recoverable, audit, policies, pendingApprovals });
      setReplacement((current) => Object.fromEntries(recoverable.map((item) => {
        const candidate = current[item.projectRun.id] ?? item.enabledMemberIds.find((id) => id !== item.currentMainMemberId) ?? item.currentMainMemberId;
        return [item.projectRun.id, candidate];
      })));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const policyCounts = useMemo(() => snapshot.policies.flatMap((policy) => policy.commandRules).reduce(
    (counts, rule) => ({ ...counts, [rule.action]: counts[rule.action] + 1 }),
    { safe: 0, approval: 0, blocked: 0 }
  ), [snapshot.policies]);

  const recover = async (item: RecoverableProjectRun, mode: "resume" | "replace"): Promise<void> => {
    const memberId = mode === "resume" ? item.currentMainMemberId : replacement[item.projectRun.id];
    if (!memberId) return;
    setBusyRunId(item.projectRun.id);
    try {
      await requestCore<ProjectRun>("orchestration.recover", { projectRunId: item.projectRun.id, memberId, mode });
      await hydrateWorkbenchSessions();
      await resumeWorkbenchRuns();
      toast.success(zh ? "恢复任务已提交给 Core" : "Recovery was submitted to Core");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyRunId(undefined);
    }
  };

  const exportDiagnostics = async (): Promise<void> => {
    try {
      const result = await requestCore<DiagnosticExportResult>("diagnostics.export", {});
      toast.success(zh ? `脱敏诊断包已导出：${result.path}` : `Redacted diagnostics exported: ${result.path}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const { metrics } = snapshot;
  const verificationRate = metrics.verificationTotal
    ? `${Math.round(metrics.verificationPassed / metrics.verificationTotal * 100)}%`
    : "—";

  return (
    <MotionCard className="card-glow lg:col-span-2">
      <div className="p-5">
        <SectionHeader
          icon={Activity}
          title={zh ? "运行安全与恢复" : "Runtime safety & recovery"}
          description={zh ? "数据来自 Core Daemon、SQLite 审计日志和运行状态，不使用模拟数据。" : "Backed by Core Daemon state, SQLite audit records and real runs."}
          actions={
            <>
              <Button size="sm" variant="subtle" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "motion-safe:animate-spin")} aria-hidden />
                {zh ? "刷新" : "Refresh"}
              </Button>
              <Button size="sm" onClick={() => void exportDiagnostics()}>
                <Download className="h-3.5 w-3.5" aria-hidden />
                {zh ? "导出脱敏诊断包" : "Export diagnostics"}
              </Button>
            </>
          }
        />

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric icon={Gauge} tone="accent" label={zh ? "运行" : "Runs"} value={metrics.totalRuns} />
          <Metric icon={XCircle} tone={metrics.failedRuns > 0 ? "danger" : "muted"} label={zh ? "失败" : "Failures"} value={metrics.failedRuns} />
          <Metric icon={AlertTriangle} tone={metrics.conflicts > 0 ? "warn" : "muted"} label={zh ? "冲突" : "Conflicts"} value={metrics.conflicts} />
          <Metric icon={BadgeCheck} tone={metrics.verificationTotal > 0 ? "ok" : "muted"} label={zh ? "验收通过率" : "Verification"} value={verificationRate} />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <Panel icon={RotateCcw} title={zh ? "待恢复运行" : "Recoverable runs"} count={snapshot.recoverable.length}>
            <div className="space-y-2">
              {snapshot.recoverable.length === 0 && (
                <EmptyHint>{zh ? "当前没有因重启或故障暂停的运行。" : "No interrupted runs need recovery."}</EmptyHint>
              )}
              {snapshot.recoverable.map((item) => {
                const team = teams.find((candidate) => candidate.id === item.projectRun.teamId);
                const options = item.enabledMemberIds.map((id) => ({ value: id, label: team?.members.find((member) => member.id === id)?.displayName ?? id }));
                const busy = busyRunId === item.projectRun.id;
                return (
                  <div
                    key={item.projectRun.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-card px-3 py-2.5 transition-colors hover:border-line-strong"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate text-[13px] font-medium text-ink">{item.projectRun.goal}</p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-3">
                        {item.projectRun.recoveryReason ?? item.projectRun.status}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => void recover(item, "resume")} disabled={busy}>
                        {busy && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />}
                        {item.canResumeProviderSession ? (zh ? "恢复原会话" : "Resume session") : (zh ? "原成员重新规划" : "Replan with current")}
                      </Button>
                      <div className="w-40 shrink-0">
                        <SelectField
                          aria-label={zh ? "替换主 Agent" : "Replacement main agent"}
                          value={replacement[item.projectRun.id]}
                          onValueChange={(value) => setReplacement((current) => ({ ...current, [item.projectRun.id]: value }))}
                          options={options}
                          disabled={busy}
                        />
                      </div>
                      <Button size="sm" variant="subtle" onClick={() => void recover(item, "replace")} disabled={busy || !replacement[item.projectRun.id]}>
                        {zh ? "更换主 Agent" : "Replace main"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel icon={ShieldCheck} title={zh ? "权限与审计" : "Policy & audit"}>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusChip tone="ok" label={zh ? `安全 ${policyCounts.safe}` : `Safe ${policyCounts.safe}`} />
              <StatusChip tone="warn" label={zh ? `需审批 ${policyCounts.approval}` : `Approval ${policyCounts.approval}`} />
              <StatusChip tone="danger" label={zh ? `阻止 ${policyCounts.blocked}` : `Blocked ${policyCounts.blocked}`} />
              <StatusChip tone="accent" label={zh ? `待审批 ${snapshot.pendingApprovals.length}` : `Pending ${snapshot.pendingApprovals.length}`} />
            </div>
            <div className="mt-3 max-h-52 space-y-1.5 overflow-auto">
              {snapshot.audit.length === 0 && (
                <EmptyHint>{zh ? "暂无审计记录。" : "No audit records yet."}</EmptyHint>
              )}
              {snapshot.audit.map((record) => (
                <div
                  key={record.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2 transition-colors hover:border-line-strong"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-ink-2">{record.action}</p>
                    <p className="truncate font-mono text-[11px] text-ink-3">
                      {record.actorId} · {record.resourceId ?? record.resourceType}
                    </p>
                  </div>
                  <StatusChip tone={auditTone(record.outcome)} label={record.outcome} className="shrink-0" />
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </MotionCard>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone: MetricTone;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-card-hover/40 px-3.5 py-3 transition-colors hover:border-line-strong">
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", METRIC_TONES[tone].chip)}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-ink-3">{label}</p>
        <p className={cn("truncate text-lg leading-tight font-semibold tabular-nums", METRIC_TONES[tone].value)}>{value}</p>
      </div>
    </div>
  );
}
