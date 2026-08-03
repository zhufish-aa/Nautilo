import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderGit2, FolderPlus, GitBranch } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/utils";
import type { UiProject } from "../../lib/types";
import { PageHeader } from "../../components/layout/AppShell";
import { MotionCard, StaggerGroup } from "../../components/ui/Card";
import { StatusChip, Tag } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { AddProjectDialog } from "./AddProjectDialog";
import { useProjectsStore } from "../../stores/projects";

function ProjectCard({ project }: { project: UiProject }): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const scan = project.scan;
  const dirty = scan?.git.isRepo && scan.git.dirtyFiles > 0;

  return (
    <MotionCard
      interactive
      onClick={() => navigate(`/projects/${project.id}`)}
      role="link"
      tabIndex={0}
      aria-label={project.name}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(`/projects/${project.id}`);
        }
      }}
      className="flex flex-col gap-4 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent-soft text-accent"
          >
            <FolderGit2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-ink">{project.name}</h3>
            <p className="truncate font-mono text-xs text-ink-3" title={project.rootPath}>
              {project.rootPath}
            </p>
          </div>
        </div>
        {project.scanning ? (
          <StatusChip tone="info" label={t("common.loading")} pulse />
        ) : dirty ? (
          <StatusChip tone="warn" label={t("status.git.dirty", { count: scan!.git.dirtyFiles })} />
        ) : scan?.git.isRepo ? (
          <StatusChip tone="ok" label={t("status.git.clean")} />
        ) : (
          <StatusChip tone="muted" label={t("projects.detail.noGit")} />
        )}
      </div>

      {scan && (
        <div className="flex flex-wrap items-center gap-1.5">
          {scan.git.branch && (
            <Tag label={scan.git.branch} className="font-mono" title={scan.git.branch} />
          )}
          {scan.stacks.slice(0, 3).map((stack) => (
            <Tag key={stack.name} label={stack.detail ? `${stack.name} ${stack.detail}` : stack.name} />
          ))}
          {scan.stacks.length > 3 && <Tag label={`+${scan.stacks.length - 3}`} />}
        </div>
      )}

      {project.activeRun && (
        <div className="flex items-center gap-2.5 rounded-xl border border-accent/20 bg-accent-soft/60 px-3 py-2.5">
          <StatusChip tone="accent" label={t(`status.run.${project.activeRun.status}`)} pulse />
          <p className="min-w-0 flex-1 truncate text-[13px] text-ink-2" title={project.activeRun.goal}>
            {project.activeRun.goal}
          </p>
        </div>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
          {project.repositoryType === "git" ? "Git" : t("projects.detail.noGit")}
        </span>
        {project.lastOpenedAt && (
          <span>{t("projects.card.lastOpened", { time: formatRelativeTime(project.lastOpenedAt, locale) })}</span>
        )}
      </div>
    </MotionCard>
  );
}

export function ProjectsPage(): JSX.Element {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <PageHeader
        title={t("projects.title")}
        subtitle={t("projects.subtitle")}
        actions={
          <>
            <StatusChip tone="muted" label={t("projects.count", { count: projects.length })} />
            <Button variant="primary" data-tour="projects-new" onClick={() => setAddOpen(true)}>
              <FolderPlus className="h-4 w-4" aria-hidden />
              {t("projects.add")}
            </Button>
          </>
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title={t("projects.empty.title")}
          description={t("projects.empty.desc")}
          action={
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <FolderPlus className="h-4 w-4" aria-hidden />
              {t("projects.empty.action")}
            </Button>
          }
        />
      ) : (
        <StaggerGroup className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </StaggerGroup>
      )}

      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
