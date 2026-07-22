import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  FolderTree,
  GitBranch,
  Info,
  Layers,
  OctagonAlert,
  PlayCircle,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import type { ProjectRisk, UiProject } from "../../lib/types";
import { Card, StaggerGroup, MotionCard } from "../../components/ui/Card";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SkeletonCard } from "../../components/ui/Skeleton";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";
import { VerificationTemplatesCard } from "./VerificationTemplatesCard";

function SectionCard({
  icon: Icon,
  title,
  children
}: {
  icon: typeof GitBranch;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <MotionCard className="p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/20 bg-accent-soft text-accent">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </div>
      {children}
    </MotionCard>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className={cnValue(mono)}>{value}</span>
    </div>
  );
}

function cnValue(mono?: boolean): string {
  return mono ? "min-w-0 truncate font-mono text-[13px] text-ink-2" : "min-w-0 truncate text-ink-2";
}

const riskStyles: Record<ProjectRisk["level"], { icon: typeof Info; color: string }> = {
  info: { icon: Info, color: "text-info" },
  warning: { icon: AlertTriangle, color: "text-warn" },
  critical: { icon: OctagonAlert, color: "text-danger" }
};

export function ProjectDetailPage(): JSX.Element {
  const { t, locale } = useI18n();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const project = useProjectsStore((state) =>
    state.projects.find((item) => item.id === projectId)
  );
  const rescanProject = useProjectsStore((state) => state.rescanProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const touchProject = useProjectsStore((state) => state.touchProject);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (projectId) touchProject(projectId);
    // Only on mount / id change — touching updates lastOpenedAt which would retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!project) {
    return (
      <EmptyState
        icon={FolderTree}
        title={t("projects.title")}
        description={t("projects.empty.desc")}
        action={
          <Button variant="outline" onClick={() => navigate("/projects")}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t("projects.detail.back")}
          </Button>
        }
      />
    );
  }

  const scan = project.scan;
  const handleRescan = async (): Promise<void> => {
    await rescanProject(project.id);
    toast.success(t("projects.rescanDoneToast", { name: project.name }));
  };
  const handleRemove = async (): Promise<void> => {
    await removeProject(project.id);
    setConfirmRemove(false);
    toast.info(t("projects.removedToast", { name: project.name }));
    navigate("/projects");
  };

  return (
    <>
      <button
        onClick={() => navigate("/projects")}
        className="mb-4 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13px] text-ink-3 transition-colors hover:bg-accent-soft hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("projects.detail.back")}
      </button>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{project.name}</h1>
          <p className="mt-1 font-mono text-[13px] break-all text-ink-3">{project.rootPath}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <Button variant="outline" onClick={() => void handleRescan()} disabled={project.scanning}>
            <RefreshCw className={project.scanning ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
            {project.scanning ? t("projects.scanning") : t("projects.card.rescan")}
          </Button>
          <Button variant="danger" onClick={() => setConfirmRemove(true)}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("projects.remove")}
          </Button>
        </div>
      </div>

      {project.scanning ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !scan ? (
        <EmptyState
          icon={ScanSearch}
          title={t("projects.detail.notScanned")}
          description={t("projects.scanHint")}
          action={
            <Button variant="primary" onClick={() => void handleRescan()}>
              <ScanSearch className="h-4 w-4" aria-hidden />
              {t("projects.detail.scanNow")}
            </Button>
          }
        />
      ) : (
        <StaggerGroup className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {project.activeRun && (
            <div className="lg:col-span-2">
              <SectionCard icon={PlayCircle} title={t("projects.detail.runTitle")}>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusChip
                    tone="accent"
                    label={t(`status.run.${project.activeRun.status}`)}
                    pulse
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{project.activeRun.goal}</p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {t("projects.detail.agent")} · {project.activeRun.agentName} ·{" "}
                      {t("projects.detail.startedAt", {
                        time: formatRelativeTime(project.activeRun.startedAt, locale)
                      })}
                    </p>
                  </div>
                </div>
              </SectionCard>
            </div>
          )}

          <SectionCard icon={GitBranch} title={t("projects.detail.gitTitle")}>
            {scan.git.isRepo ? (
              <div className="divide-y divide-line">
                <InfoRow label={t("projects.detail.branch")} value={scan.git.branch} mono />
                <InfoRow label={t("projects.detail.defaultBranch")} value={scan.git.defaultBranch} mono />
                <InfoRow
                  label={t("projects.detail.remote")}
                  value={scan.git.remote ?? t("common.none")}
                  mono
                />
                <InfoRow
                  label={t("projects.detail.worktree")}
                  value={
                    scan.git.dirtyFiles > 0 ? (
                      <StatusChip tone="warn" label={t("status.git.dirty", { count: scan.git.dirtyFiles })} />
                    ) : (
                      <StatusChip tone="ok" label={t("status.git.clean")} />
                    )
                  }
                />
              </div>
            ) : (
              <p className="text-sm text-ink-3">{t("projects.detail.noGit")}</p>
            )}
          </SectionCard>

          <SectionCard icon={Layers} title={t("projects.detail.stackTitle")}>
            <ul className="space-y-3">
              {scan.stacks.map((stack) => (
                <li key={stack.name} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-sm text-ink-2">
                    {stack.name}
                    {stack.detail && <span className="ml-1.5 text-xs text-ink-3">{stack.detail}</span>}
                  </span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
                    <span
                      className="block h-full rounded-full bg-gradient-to-r from-accent to-accent-2"
                      style={{ width: `${stack.confidence}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs text-ink-3">
                    {t("projects.detail.confidence", { value: stack.confidence })}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard icon={FolderTree} title={t("projects.detail.pathsTitle")}>
            {scan.frontendPaths.length === 0 && scan.backendPaths.length === 0 ? (
              <p className="text-sm text-ink-3">{t("projects.detail.noPaths")}</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">
                    {t("projects.detail.frontendPaths")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {scan.frontendPaths.length > 0 ? (
                      scan.frontendPaths.map((path) => (
                        <Tag key={path} label={path} className="font-mono" />
                      ))
                    ) : (
                      <span className="text-sm text-ink-3">—</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">
                    {t("projects.detail.backendPaths")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {scan.backendPaths.length > 0 ? (
                      scan.backendPaths.map((path) => (
                        <Tag key={path} label={path} className="font-mono" />
                      ))
                    ) : (
                      <span className="text-sm text-ink-3">—</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard icon={ShieldCheck} title={t("projects.detail.risksTitle")}>
            {scan.risks.length === 0 ? (
              <div className="flex items-center gap-2.5 text-sm text-ok">
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {t("projects.detail.noRisks")}
              </div>
            ) : (
              <ul className="space-y-2.5">
                {scan.risks.map((risk) => {
                  const style = riskStyles[risk.level];
                  const Icon = style.icon;
                  return (
                    <li
                      key={risk.id}
                      className="flex items-start gap-2.5 rounded-xl border border-line bg-card-hover px-3 py-2.5"
                    >
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.color}`} aria-hidden />
                      <div className="min-w-0">
                        <span className={`mr-2 text-xs font-medium ${style.color}`}>
                          {t(`risk.level.${risk.level}` as MessageKey)}
                        </span>
                        <span className="text-[13px] leading-snug text-ink-2">
                          {t(risk.textKey as MessageKey)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          <div className="lg:col-span-2">
            <VerificationTemplatesCard project={project} />
          </div>
        </StaggerGroup>
      )}

      <Dialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("projects.removeTitle")}
        description={t("projects.removeDesc", { name: project.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void handleRemove()}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("projects.remove")}
            </Button>
          </>
        }
      >
        <p className="font-mono text-[13px] break-all text-ink-3">{project.rootPath}</p>
      </Dialog>
    </>
  );
}
