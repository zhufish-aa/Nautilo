import { useRef, useState } from "react";
import { CircleHelp, Loader2 } from "lucide-react";
import { Tooltip } from "../../components/ui/Tooltip";
import { useI18n } from "../../lib/i18n";
import type { UiProject } from "../../lib/types";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";

type NonGitDiffMode = NonNullable<UiProject["nonGitDiffMode"]>;

export function NonGitDiffModeCard({ project }: { project: UiProject }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const saveMode = useProjectsStore((state) => state.setNonGitDiffMode);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mode = project.nonGitDiffMode ?? "full";
  const title = zh ? "非 Git 文件对比" : "Non-Git file comparison";
  const help = zh
    ? "仅影响非 Git 目录，从下一轮运行生效。新项目默认仅工具差异，旧项目保留原策略。工具未报告的 shell 或外部改动可能没有差异记录。可切换扫描并对比；扫描受数量和大小限制，不保证全部覆盖。Git diff 不受影响。"
    : "Applies to non-Git folders from the next run. New projects use tool diffs only; existing projects keep their strategy. Unreported shell or external edits may lack diffs. Scan and compare is available, with file-count and size limits. Git diff is unchanged.";
  const options: Array<{ value: NonGitDiffMode; label: string }> = [
    { value: "full", label: zh ? "扫描并对比" : "Scan and compare" },
    { value: "off", label: zh ? "仅工具差异" : "Tool diffs only" }
  ];

  const changeMode = async (next: NonGitDiffMode): Promise<void> => {
    if (inFlight.current || next === mode) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await saveMode(project.id, next);
      toast.success(zh ? "文件对比策略已保存" : "File comparison preference saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section aria-labelledby="project-non-git-diff-mode" className="py-2">
      <div className="mb-4 flex items-center gap-2">
        <h2 id="project-non-git-diff-mode" className="text-[15px] font-medium text-ink">
          {title}
        </h2>
        <Tooltip content={help}>
          <button
            type="button"
            aria-label={help}
            className="rounded p-1 text-ink-3 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <CircleHelp className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
        {pending && (
          <span role="status" className="text-ink-3">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            <span className="sr-only">{zh ? "正在保存" : "Saving"}</span>
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label={title}
        aria-busy={pending}
        className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-line-strong p-1"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            disabled={pending}
            onClick={() => void changeMode(option.value)}
            className={`rounded-md px-5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${mode === option.value ? "bg-panel font-medium text-ink" : "text-ink-3 hover:bg-panel/60 hover:text-ink"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-3">
        {mode === "full"
          ? zh
            ? "运行前扫描非 Git 目录，保留文件对比基线。"
            : "Scan non-Git folders before running to keep a file comparison baseline."
          : zh
            ? "跳过目录扫描，仅显示工具提供的差异。"
            : "Skip the folder scan and show only diffs provided by tools."}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
