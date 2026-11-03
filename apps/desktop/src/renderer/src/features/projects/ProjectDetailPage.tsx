import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  FolderTree,
  GitBranch,
  Info,
  Layers,
  Loader2,
  OctagonAlert,
  PlayCircle,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import type { ProjectRisk } from "../../lib/types";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Tooltip } from "../../components/ui/Tooltip";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";
import { VerificationTemplatesCard } from "./VerificationTemplatesCard";
import { WorkspaceModeCard } from "./WorkspaceModeCard";
import { NonGitDiffModeCard } from "./NonGitDiffModeCard";

function InfoRow({
  icon: Icon,
  label,
  children
}: {
  icon: typeof GitBranch;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-line py-4 sm:grid-cols-[200px_minmax(0,1fr)]">
      <dt className="flex items-center gap-3 text-sm text-ink-2">
        <Icon className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 text-sm leading-relaxed text-ink">{children}</dd>
    </div>
  );
}
const riskStyles: Record<ProjectRisk["level"], { icon: typeof Info; color: string }> = {
  info: { icon: Info, color: "text-ink-3" },
  warning: { icon: AlertTriangle, color: "text-warn" },
  critical: { icon: OctagonAlert, color: "text-danger" }
};

export function ProjectDetailPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const project = useProjectsStore((state) => state.projects.find((item) => item.id === projectId));
  const rescanProject = useProjectsStore((state) => state.rescanProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const touchProject = useProjectsStore((state) => state.touchProject);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const mutation = useRef(false);

  useEffect(() => {
    if (projectId) touchProject(projectId);
  }, [projectId, touchProject]);
  const inspectedProject = useRef<string>();
  useEffect(() => {
    const current = useProjectsStore.getState().projects.find((item) => item.id === projectId);
    if (!current || current.scan || current.scanning || inspectedProject.current === projectId) return;
    inspectedProject.current = projectId;
    let cancelled = false;
    void rescanProject(current.id).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [projectId, project?.id, rescanProject]);

  useEffect(() => {
    setError("");
    setRemoveError("");
    setConfirmRemove(false);
  }, [projectId]);

  if (!project)
    return (
      <EmptyState
        icon={FolderTree}
        title={zh ? "项目不存在" : "Project not found"}
        description={
          zh
            ? "项目可能已被移除。返回项目列表继续。"
            : "This project may have been removed. Return to your projects to continue."
        }
        action={
          <Button variant="outline" onClick={() => navigate("/projects")}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t("projects.detail.back")}
          </Button>
        }
      />
    );

  const scan = project.scan;
  const handleRescan = async (): Promise<void> => {
    if (mutation.current || project.scanning) return;
    mutation.current = true;
    setError("");
    try {
      await rescanProject(project.id);
      toast.success(t("projects.rescanDoneToast", { name: project.name }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutation.current = false;
    }
  };
  const handleRemove = async (): Promise<void> => {
    if (mutation.current) return;
    mutation.current = true;
    setRemoving(true);
    setRemoveError("");
    try {
      await removeProject(project.id);
      setConfirmRemove(false);
      toast.info(t("projects.removedToast", { name: project.name }));
      navigate("/projects");
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutation.current = false;
      setRemoving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl py-3 sm:py-6">
      <Link
        to="/projects"
        className="mb-6 inline-flex items-center gap-2 rounded text-sm text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t("projects.detail.back")}
      </Link>
      <header className="mb-9 flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-ink">
            {project.name}
          </h1>
          <p className="mt-2 break-all font-mono text-sm text-ink-3">{project.rootPath}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void handleRescan()}
            disabled={project.scanning || removing}
          >
            <RefreshCw
              className={`h-4 w-4 ${project.scanning ? "motion-safe:animate-spin" : ""}`}
              aria-hidden
            />
            {project.scanning ? t("projects.scanning") : t("projects.card.rescan")}
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate(`/sessions?new=1&project=${encodeURIComponent(project.id)}`)}
          >
            <PlayCircle className="h-4 w-4" aria-hidden />
            {zh ? "开始会话" : "Start conversation"}
          </Button>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-lg border border-danger/20 bg-danger/5 p-4 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{error}</p>
        </div>
      )}
      {project.scanning && (
        <div
          role="status"
          className="mb-6 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-4 text-sm text-ink-3"
        >
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
          {t("projects.scanning")}
        </div>
      )}
      {!scan && !project.scanning ? (
        <EmptyState
          icon={ScanSearch}
          title={t("projects.detail.notScanned")}
          description={t("projects.scanHint")}
          action={
            <Button variant="outline" onClick={() => void handleRescan()}>
              <ScanSearch className="h-4 w-4" aria-hidden />
              {t("projects.detail.scanNow")}
            </Button>
          }
        />
      ) : (
        scan && (
          <div className="space-y-8">
            {project.activeRun && (
              <section className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
                <StatusChip tone="muted" label={t(`status.run.${project.activeRun.status}`)} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">{project.activeRun.goal}</p>
                  <p className="mt-1 text-sm text-ink-3">
                    {project.activeRun.agentName} ·{" "}
                    {formatRelativeTime(project.activeRun.startedAt, locale)}
                  </p>
                </div>
              </section>
            )}
            <section aria-labelledby="project-information">
              <h2 id="project-information" className="mb-3 text-[15px] font-medium">
                {zh ? "项目信息" : "Project information"}
              </h2>
              <dl className="border-t border-line">
                <InfoRow icon={GitBranch} label={t("projects.detail.gitTitle")}>
                  {scan.git.isRepo ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono">{scan.git.branch || "—"}</span>
                      <StatusChip
                        tone={scan.git.dirtyFiles ? "warn" : "muted"}
                        label={
                          scan.git.dirtyFiles
                            ? t("status.git.dirty", { count: scan.git.dirtyFiles })
                            : t("status.git.clean")
                        }
                      />
                    </div>
                  ) : (
                    <span className="text-ink-3">{t("projects.detail.noGit")}</span>
                  )}
                </InfoRow>
                <InfoRow icon={Layers} label={t("projects.detail.stackTitle")}>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {scan.stacks.length ? (
                      scan.stacks.map((stack) => (
                        <Tooltip
                          key={stack.name}
                          content={t("projects.detail.confidence", { value: stack.confidence })}
                        >
                          <button
                            type="button"
                            aria-label={`${stack.name} · ${t("projects.detail.confidence", { value: stack.confidence })}`}
                            className="rounded text-left focus-visible:ring-2 focus-visible:ring-accent/50"
                          >
                            {stack.name}
                            {stack.detail && (
                              <span className="ml-1.5 text-ink-3">{stack.detail}</span>
                            )}
                          </button>
                        </Tooltip>
                      ))
                    ) : (
                      <span className="text-ink-3">{t("common.none")}</span>
                    )}
                  </div>
                </InfoRow>
                <InfoRow icon={FolderTree} label={t("projects.detail.pathsTitle")}>
                  <div className="space-y-2">
                    {scan.frontendPaths.length > 0 && (
                      <p className="break-all">
                        <span className="mr-3 text-ink-3">
                          {t("projects.detail.frontendPaths")}
                        </span>
                        {scan.frontendPaths.join(" · ")}
                      </p>
                    )}
                    {scan.backendPaths.length > 0 && (
                      <p className="break-all">
                        <span className="mr-3 text-ink-3">{t("projects.detail.backendPaths")}</span>
                        {scan.backendPaths.join(" · ")}
                      </p>
                    )}
                    {!scan.frontendPaths.length && !scan.backendPaths.length && (
                      <span className="text-ink-3">{t("projects.detail.noPaths")}</span>
                    )}
                  </div>
                </InfoRow>
              </dl>
              {scan.git.isRepo && (
                <details className="mt-3 text-sm">
                  <summary className="w-fit cursor-pointer rounded py-2 text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
                    {zh ? "Git 详细信息" : "Git details"}
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-3 rounded-lg bg-panel p-4">
                    <dt className="text-ink-3">{t("projects.detail.defaultBranch")}</dt>
                    <dd className="break-all font-mono">{scan.git.defaultBranch || "—"}</dd>
                    <dt className="text-ink-3">{t("projects.detail.remote")}</dt>
                    <dd className="break-all font-mono">{scan.git.remote ?? t("common.none")}</dd>
                  </dl>
                </details>
              )}
            </section>
            <WorkspaceModeCard project={project} />
            <section aria-labelledby="project-risks">
              <h2 id="project-risks" className="mb-3 text-[15px] font-medium">
                {t("projects.detail.risksTitle")}
              </h2>
              {scan.risks.length === 0 ? (
                <p className="flex items-center gap-3 border-t border-line py-4 text-sm text-ink-3">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                  {t("projects.detail.noRisks")}
                </p>
              ) : (
                <ul className="divide-y divide-line border-t border-line">
                  {scan.risks.map((risk) => {
                    const { icon: Icon, color } = riskStyles[risk.level];
                    return (
                      <li key={risk.id} className="flex items-start gap-3 py-4 text-sm">
                        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} aria-hidden />
                        <span className="sr-only">
                          {t(`risk.level.${risk.level}` as MessageKey)}:{" "}
                        </span>
                        <span className="leading-relaxed text-ink-2">
                          {t(risk.textKey as MessageKey)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <VerificationTemplatesCard project={project} />
          </div>
        )
      )}
      <div className="mt-8">
        <NonGitDiffModeCard key={project.id} project={project} />
      </div>
      <div className="mt-10 border-t border-line pt-5">
        <Button
          variant="ghost"
          className="text-danger hover:text-danger"
          disabled={project.scanning || removing}
          onClick={() => {
            setRemoveError("");
            setConfirmRemove(true);
          }}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {t("projects.remove")}
        </Button>
      </div>
      <Dialog
        open={confirmRemove}
        onOpenChange={(open) => {
          if (!removing) setConfirmRemove(open);
        }}
        title={t("projects.removeTitle")}
        description={t("projects.removeDesc", { name: project.name })}
        footer={
          <>
            <Button variant="outline" disabled={removing} onClick={() => setConfirmRemove(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" disabled={removing} onClick={() => void handleRemove()}>
              {removing && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
              {t("projects.remove")}
            </Button>
          </>
        }
      >
        <p className="rounded-lg bg-panel p-3 font-mono text-sm break-all text-ink-3">
          {project.rootPath}
        </p>
        {removeError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {removeError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
