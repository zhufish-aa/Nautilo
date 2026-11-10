import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Download,
  Gauge,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ChevronDown,
} from "lucide-react";
import type {
  ApprovalRecord,
  AuditRecord,
  DiagnosticExportResult,
  PermissionPolicy,
  ProjectRun,
  RecoverableProjectRun,
  RuntimeMetrics,
} from "@agenthub/domain";
import { StatusChip, type ChipTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SelectField } from "../../components/ui/Select";
import { requestCore } from "../../lib/bridge";
import {
  hydrateWorkbenchSessions,
  resumeWorkbenchRuns,
} from "../../lib/orchestration-runtime";
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
  averageRunDurationMs: 0,
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
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>({
    metrics: EMPTY_METRICS,
    recoverable: [],
    audit: [],
    policies: [],
    pendingApprovals: [],
  });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [busyRunId, setBusyRunId] = useState<string>();
  const [replacement, setReplacement] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [metrics, recoverable, audit, policies, pendingApprovals] =
        await Promise.all([
          requestCore<RuntimeMetrics>("metrics.get", {}),
          requestCore<RecoverableProjectRun[]>("recovery.list"),
          requestCore<AuditRecord[]>("audit.list", { limit: 12 }),
          requestCore<PermissionPolicy[]>("policy.list"),
          requestCore<ApprovalRecord[]>("approval.list", { status: "pending" }),
        ]);
      setSnapshot({ metrics, recoverable, audit, policies, pendingApprovals });
      setReplacement((current) =>
        Object.fromEntries(
          recoverable.map((item) => {
            const candidate =
              current[item.projectRun.id] ??
              item.enabledMemberIds.find(
                (id) => id !== item.currentMainMemberId,
              ) ??
              item.currentMainMemberId;
            return [item.projectRun.id, candidate];
          }),
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const policyCounts = useMemo(
    () =>
      snapshot.policies
        .flatMap((policy) => policy.commandRules)
        .reduce(
          (counts, rule) => ({
            ...counts,
            [rule.action]: counts[rule.action] + 1,
          }),
          { safe: 0, approval: 0, blocked: 0 },
        ),
    [snapshot.policies],
  );

  const recover = async (
    item: RecoverableProjectRun,
    mode: "resume" | "replace",
  ): Promise<void> => {
    const memberId =
      mode === "resume"
        ? item.currentMainMemberId
        : replacement[item.projectRun.id];
    if (!memberId || busyRunId) return;
    setBusyRunId(item.projectRun.id);
    try {
      await requestCore<ProjectRun>("orchestration.recover", {
        projectRunId: item.projectRun.id,
        memberId,
        mode,
      });
      await hydrateWorkbenchSessions();
      await resumeWorkbenchRuns();
      toast.success(
        zh ? "恢复任务已提交给 Core" : "Recovery was submitted to Core",
      );
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyRunId(undefined);
    }
  };

  const exportDiagnostics = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await requestCore<DiagnosticExportResult>(
        "diagnostics.export",
        {},
      );
      toast.success(
        zh
          ? `脱敏诊断包已导出：${result.path}`
          : `Redacted diagnostics exported: ${result.path}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };

  const { metrics } = snapshot;
  const verificationRate = metrics.verificationTotal
    ? `${Math.round((metrics.verificationPassed / metrics.verificationTotal) * 100)}%`
    : "—";

  return (
    <section
      className="settings-detail-card bg-card lg:col-span-2"
      aria-busy={loading}
    >
      <div className="py-1">
        <SectionHeader
          icon={Activity}
          title={zh ? "运行安全与恢复" : "Runtime safety & recovery"}
          description={
            zh
              ? "数据来自 Core Daemon、SQLite 审计日志和运行状态，不使用模拟数据。"
              : "Backed by Core Daemon state, SQLite audit records and real runs."
          }
          actions={
            <>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => void load()}
                disabled={loading}
              >
                <RefreshCw
                  className={cn(
                    "h-3.5 w-3.5",
                    loading && "motion-safe:animate-spin",
                  )}
                  aria-hidden
                />
                {zh ? "刷新" : "Refresh"}
              </Button>
            </>
          }
        />

        <div className="mt-6 space-y-5">
          <Panel
            className="rounded-none border-0 p-0"
            icon={RotateCcw}
            title={zh ? "待恢复运行" : "Recoverable runs"}
            count={snapshot.recoverable.length}
          >
            <div className="divide-y divide-line">
              {snapshot.recoverable.length === 0 && (
                <EmptyHint>
                  {zh
                    ? "当前没有因重启或故障暂停的运行。"
                    : "No interrupted runs need recovery."}
                </EmptyHint>
              )}
              {snapshot.recoverable.map((item) => {
                const team = teams.find(
                  (candidate) => candidate.id === item.projectRun.teamId,
                );
                const options = item.enabledMemberIds.map((id) => ({
                  value: id,
                  label:
                    team?.members.find((member) => member.id === id)
                      ?.displayName ?? id,
                }));
                const busy = busyRunId === item.projectRun.id;
                return (
                  <div
                    key={item.projectRun.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-3 py-4"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate text-[13px] font-medium text-ink">
                        {item.projectRun.goal}
                      </p>
                      <p className="mt-1 text-xs text-ink-3">
                        {item.projectRun.recoveryReason ??
                          item.projectRun.status}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => void recover(item, "resume")}
                        disabled={!!busyRunId}
                      >
                        {busy && (
                          <Loader2
                            className="h-3.5 w-3.5 motion-safe:animate-spin"
                            aria-hidden
                          />
                        )}
                        {item.canResumeProviderSession
                          ? zh
                            ? "恢复原会话"
                            : "Resume session"
                          : zh
                            ? "原成员重新规划"
                            : "Replan with current"}
                      </Button>
                      <div className="w-40 shrink-0">
                        <SelectField
                          aria-label={
                            zh ? "替换主 Agent" : "Replacement main agent"
                          }
                          value={replacement[item.projectRun.id]}
                          onValueChange={(value) =>
                            setReplacement((current) => ({
                              ...current,
                              [item.projectRun.id]: value,
                            }))
                          }
                          options={options}
                          disabled={!!busyRunId}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => void recover(item, "replace")}
                        disabled={
                          !!busyRunId || !replacement[item.projectRun.id]
                        }
                      >
                        {zh ? "更换主 Agent" : "Replace main"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <details className="group/audit border-t border-line pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
              <ShieldCheck className="h-4 w-4 text-ink-3" aria-hidden />
              {zh ? "权限与审计" : "Policy & audit"}
              <ChevronDown
                className="ml-auto h-4 w-4 text-ink-3 transition-transform group-open/audit:rotate-180"
                aria-hidden
              />
            </summary>
            <div className="pt-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusChip
                  tone="ok"
                  label={
                    zh
                      ? `安全 ${policyCounts.safe}`
                      : `Safe ${policyCounts.safe}`
                  }
                />
                <StatusChip
                  tone="warn"
                  label={
                    zh
                      ? `需审批 ${policyCounts.approval}`
                      : `Approval ${policyCounts.approval}`
                  }
                />
                <StatusChip
                  tone="danger"
                  label={
                    zh
                      ? `阻止 ${policyCounts.blocked}`
                      : `Blocked ${policyCounts.blocked}`
                  }
                />
                <StatusChip
                  tone="accent"
                  label={
                    zh
                      ? `待审批 ${snapshot.pendingApprovals.length}`
                      : `Pending ${snapshot.pendingApprovals.length}`
                  }
                />
              </div>
              <div className="mt-3 max-h-64 divide-y divide-line overflow-auto">
                {snapshot.audit.length === 0 && (
                  <EmptyHint>
                    {zh ? "暂无审计记录。" : "No audit records yet."}
                  </EmptyHint>
                )}
                {snapshot.audit.map((record) => (
                  <div
                    key={record.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-ink-2">
                        {record.action}
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-3">
                        {record.actorId} ·{" "}
                        {record.resourceId ?? record.resourceType}
                      </p>
                    </div>
                    <StatusChip
                      tone={auditTone(record.outcome)}
                      label={record.outcome}
                      className="shrink-0"
                    />
                  </div>
                ))}
              </div>
            </div>
          </details>
          <details className="group/metrics border-t border-line pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
              <Gauge className="h-4 w-4 text-ink-3" aria-hidden />
              {zh ? "运行指标" : "Runtime metrics"}
              <ChevronDown
                className="ml-auto h-4 w-4 text-ink-3 transition-transform group-open/metrics:rotate-180"
                aria-hidden
              />
            </summary>
            <dl className="mt-4 divide-y divide-line">
              {[
                [zh ? "运行" : "Runs", metrics.totalRuns],
                [zh ? "已完成" : "Completed", metrics.completedRuns],
                [zh ? "失败" : "Failures", metrics.failedRuns],
                [zh ? "冲突" : "Conflicts", metrics.conflicts],
                [zh ? "重试任务" : "Retried tasks", metrics.retriedTasks],
                [zh ? "验收通过率" : "Verification", verificationRate],
                [
                  zh ? "平均耗时" : "Average duration",
                  `${Math.round(metrics.averageRunDurationMs / 1000)} s`,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-4 py-3 text-sm"
                >
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="font-medium tabular-nums text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <span className="text-sm font-medium text-ink">
              {zh ? "导出诊断" : "Diagnostics"}
            </span>
            <Button
              size="sm"
              variant="subtle"
              onClick={() => void exportDiagnostics()}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden />
              )}
              {zh ? "导出脱敏诊断包" : "Export redacted diagnostics"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
