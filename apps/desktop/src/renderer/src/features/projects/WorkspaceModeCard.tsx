import type { WorkspaceMode } from "@agenthub/domain";
import { FolderGit2 } from "lucide-react";
import { MotionCard } from "../../components/ui/Card";
import { SelectField } from "../../components/ui/Select";
import { useI18n } from "../../lib/i18n";
import type { UiProject } from "../../lib/types";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";

export function WorkspaceModeCard({ project }: { project: UiProject }): JSX.Element {
  const { t } = useI18n();
  const setWorkspaceMode = useProjectsStore((state) => state.setWorkspaceMode);

  const changeMode = async (value: string): Promise<void> => {
    const mode = value as WorkspaceMode;
    await setWorkspaceMode(project.id, mode);
    toast.success(t("projects.workspaceMode.saved"));
  };

  const description = project.workspaceMode === "git_isolated"
    ? t("projects.workspaceMode.gitIsolatedDesc")
    : t("projects.workspaceMode.directDesc");

  return (
    <MotionCard className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent-soft text-accent">
            <FolderGit2 className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{t("projects.workspaceMode.title")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{description}</p>
            <p className="mt-1 text-[11px] text-ink-3">{t("projects.workspaceMode.nextRunHint")}</p>
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-56">
          <SelectField
            aria-label={t("projects.workspaceMode.title")}
            value={project.workspaceMode}
            onValueChange={(value) => void changeMode(value)}
            options={[
              { value: "direct", label: t("projects.workspaceMode.direct") },
              { value: "git_isolated", label: t("projects.workspaceMode.gitIsolated") }
            ]}
          />
        </div>
      </div>
    </MotionCard>
  );
}
