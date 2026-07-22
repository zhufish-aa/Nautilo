import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Download, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import type {
  ApprovalRecord,
  AuditRecord,
  DiagnosticExportResult,
  PermissionPolicy,
  ProjectRun,
  RecoverableProjectRun,
  RuntimeMetrics
} from "@agenthub/domain";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { SelectField } from "../../components/ui/Select";
import { requestCore } from "../../lib/bridge";
import { hydrateWorkbenchSessions, resumeWorkbenchRuns } from "../../lib/orchestration-runtime";
import { useSettingsStore } from "../../stores/settings";
import { useTeamsStore } from "../../stores/teams";
import { toast } from "../../stores/toast";

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

  return (
    <Card className="p-5 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent-soft text-accent">
            <Activity className="h-4.5 w-4.5" aria-hidden />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-ink">{zh ? "运行安全与恢复" : "Runtime safety & recovery"}</h2>
            <p className="mt-0.5 text-xs text-ink-3">{zh ? "数据来自 Core Daemon、SQLite 审计日志和运行状态，不使用模拟数据。" : "Backed by Core Daemon state, SQLite audit records and real runs."}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {zh ? "刷新" : "Refresh"}
          </Button>
          <Button size="sm" variant="subtle" onClick={() => void exportDiagnostics()}>
            <Download className="h-3.5 w-3.5" aria-hidden />
            {zh ? "导出脱敏诊断包" : "Export diagnostics"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label={zh ? "运行" : "Runs"} value={snapshot.metrics.totalRuns} />
        <Metric label={zh ? "失败" : "Failures"} value={snapshot.metrics.failedRuns} />
        <Metric label={zh ? "冲突" : "Conflicts"} value={snapshot.metrics.conflicts} />
        <Metric label={zh ? "验收通过率" : "Verification"} value={snapshot.metrics.verificationTotal ? `${Math.round(snapshot.metrics.verificationPassed / snapshot.metrics.verificationTotal * 100)}%` : "—"} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-line bg-card-hover/40 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink"><RotateCcw className="h-4 w-4 text-accent" />{zh ? "待恢复运行" : "Recoverable runs"}</h3>
            <span className="text-xs text-ink-3">{snapshot.recoverable.length}</span>
          </div>
          <div className="mt-3 space-y-2">
            {snapshot.recoverable.length === 0 && <p className="text-xs text-ink-3">{zh ? "当前没有因重启或故障暂停的运行。" : "No interrupted runs need recovery."}</p>}
            {snapshot.recoverable.map((item) => {
              const team = teams.find((candidate) => candidate.id === item.projectRun.teamId);
              const options = item.enabledMemberIds.map((id) => ({ value: id, label: team?.members.find((member) => member.id === id)?.displayName ?? id }));
              return (
                <div key={item.projectRun.id} className="rounded-lg border border-line bg-card p-3">
                  <p className="truncate text-sm font-medium text-ink">{item.projectRun.goal}</p>
                  <p className="mt-1 text-xs text-ink-3">{item.projectRun.recoveryReason ?? item.projectRun.status}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void recover(item, "resume")} disabled={busyRunId === item.projectRun.id}>
                      {item.canResumeProviderSession ? (zh ? "恢复原会话" : "Resume session") : (zh ? "原成员重新规划" : "Replan with current")}
                    </Button>
                    <SelectField
                      aria-label={zh ? "替换主 Agent" : "Replacement main agent"}
                      value={replacement[item.projectRun.id]}
                      onValueChange={(value) => setReplacement((current) => ({ ...current, [item.projectRun.id]: value }))}
                      options={options}
                      className="min-w-40 flex-1"
                    />
                    <Button size="sm" variant="subtle" onClick={() => void recover(item, "replace")} disabled={busyRunId === item.projectRun.id || !replacement[item.projectRun.id]}>
                      {zh ? "更换主 Agent" : "Replace main"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-card-hover/40 p-3.5">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink"><ShieldCheck className="h-4 w-4 text-accent" />{zh ? "权限与审计" : "Policy & audit"}</h3>
          <p className="mt-2 text-xs text-ink-3">
            {zh
              ? `规则：安全 ${policyCounts.safe} / 需审批 ${policyCounts.approval} / 阻止 ${policyCounts.blocked}；待审批 ${snapshot.pendingApprovals.length}`
              : `Rules: ${policyCounts.safe} safe / ${policyCounts.approval} approval / ${policyCounts.blocked} blocked; ${snapshot.pendingApprovals.length} pending`}
          </p>
          <div className="mt-3 max-h-52 space-y-1.5 overflow-auto">
            {snapshot.audit.length === 0 && <p className="text-xs text-ink-3">{zh ? "暂无审计记录。" : "No audit records yet."}</p>}
            {snapshot.audit.map((record) => (
              <div key={record.id} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-ink-2">{record.action}</p>
                  <p className="truncate text-[11px] text-ink-3">{record.actorId} · {record.resourceId ?? record.resourceType}</p>
                </div>
                <span className={record.outcome === "success" ? "text-[11px] text-ok" : record.outcome === "denied" ? "text-[11px] text-warn" : "text-[11px] text-danger"}>{record.outcome}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }): JSX.Element {
  return <div className="rounded-xl border border-line bg-card-hover/40 px-3 py-2.5"><p className="text-[11px] text-ink-3">{label}</p><p className="mt-0.5 text-lg font-semibold text-ink">{value}</p></div>;
}
