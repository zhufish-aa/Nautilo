import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Folder, FolderPlus, Loader2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { PageHeader } from "../../components/layout/AppShell";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { AddProjectDialog } from "./AddProjectDialog";
import { useProjectsStore } from "../../stores/projects";

export function ProjectsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const projects = useProjectsStore((state) => state.projects);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="mx-auto max-w-5xl py-3 sm:py-6">
      <p className="mb-5 text-sm text-ink-3">{zh ? "通用 / 项目" : "General / Projects"}</p>
      <PageHeader
        title={t("projects.title")}
        actions={
          <Button variant="outline" data-tour="projects-new" onClick={() => setAddOpen(true)}>
            <FolderPlus className="h-4 w-4" aria-hidden />
            {t("projects.add")}
          </Button>
        }
      />
      {projects.length === 0 ? (
        <EmptyState
          icon={Folder}
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
        <div className="mt-8">
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 border-b border-line px-2 pb-3 text-sm text-ink-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_150px_20px]"
            aria-hidden
          >
            <span>{zh ? "名称" : "Name"}</span>
            <span className="hidden sm:block">{zh ? "路径" : "Path"}</span>
            <span>{zh ? "状态" : "Status"}</span>
            <span className="hidden sm:block" />
          </div>
          <ul className="divide-y divide-line">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/projects/${encodeURIComponent(project.id)}`}
                  className="grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-5 rounded-lg px-2 py-4 transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_150px_20px]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Folder className="h-5 w-5 shrink-0 text-ink-2" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium text-ink">
                        {project.name}
                      </span>
                      <span
                        className="mt-1 block truncate text-sm text-ink-3 sm:hidden"
                        title={project.rootPath}
                      >
                        {project.rootPath}
                      </span>
                    </span>
                  </span>
                  <span
                    className="hidden truncate text-sm text-ink-3 sm:block"
                    title={project.rootPath}
                  >
                    {project.rootPath}
                  </span>
                  <span className="flex items-center gap-2 text-sm text-ink-2">
                    {project.scanning ? (
                      <>
                        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                        {t("projects.scanning")}
                      </>
                    ) : project.activeRun ? (
                      <StatusChip
                        tone="muted"
                        label={t(`status.run.${project.activeRun.status}`)}
                      />
                    ) : (
                      <StatusChip
                        tone="muted"
                        label={
                          project.scan ? (zh ? "就绪" : "Ready") : t("projects.detail.notScanned")
                        }
                      />
                    )}
                  </span>
                  <ChevronRight className="hidden h-4 w-4 text-ink-3 sm:block" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
