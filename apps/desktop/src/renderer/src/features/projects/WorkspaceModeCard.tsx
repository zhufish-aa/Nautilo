import { useRef, useState } from "react";
import type { WorkspaceMode } from "@agenthub/domain";
import { CircleHelp, Loader2 } from "lucide-react";
import { Tooltip } from "../../components/ui/Tooltip";
import { useI18n } from "../../lib/i18n";
import type { UiProject } from "../../lib/types";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";

export function WorkspaceModeCard({ project }: { project: UiProject }): JSX.Element {
  const { t } = useI18n();
  const setWorkspaceMode = useProjectsStore((state) => state.setWorkspaceMode);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const changeMode = async (mode: WorkspaceMode): Promise<void> => {
    if (inFlight.current || mode === project.workspaceMode) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await setWorkspaceMode(project.id, mode);
      toast.success(t("projects.workspaceMode.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const options: Array<{ value: WorkspaceMode; label: string }> = [
    { value: "direct", label: t("projects.workspaceMode.direct") },
    { value: "git_isolated", label: t("projects.workspaceMode.gitIsolated") }
  ];
  const description =
    project.workspaceMode === "git_isolated"
      ? t("projects.workspaceMode.gitIsolatedDesc")
      : t("projects.workspaceMode.directDesc");
  return (
    <section aria-labelledby="project-workspace-mode" className="py-2">
      <div className="mb-4 flex items-center gap-2">
        <h2 id="project-workspace-mode" className="text-[15px] font-medium text-ink">
          {t("projects.workspaceMode.title")}
        </h2>
        <Tooltip content={t("projects.workspaceMode.nextRunHint")}>
          <button
            type="button"
            aria-label={t("projects.workspaceMode.nextRunHint")}
            className="rounded p-1 text-ink-3 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <CircleHelp className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
        {pending && <Loader2 className="h-4 w-4 motion-safe:animate-spin text-ink-3" aria-hidden />}
      </div>
      <div
        className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-line-strong p-1"
        role="group"
        aria-label={t("projects.workspaceMode.title")}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={project.workspaceMode === option.value}
            disabled={pending}
            onClick={() => void changeMode(option.value)}
            className={`rounded-md px-5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${project.workspaceMode === option.value ? "bg-panel font-medium text-ink" : "text-ink-3 hover:bg-panel/60 hover:text-ink"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-3">{description}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
