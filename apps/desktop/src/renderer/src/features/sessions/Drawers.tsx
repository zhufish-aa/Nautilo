import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { SessionTask } from "../../lib/types";
import { Drawer } from "../../components/ui/Drawer";
import { StatusChip } from "../../components/ui/Badge";
import { TabBar } from "../../components/ui/Tabs";
import { useSessionsStore } from "../../stores/sessions";

/* ---------------------------------------------------------------------------
 * F-033: raw terminal drawer — debug fallback only, never replaces chat.
 * ------------------------------------------------------------------------ */
export function TerminalDrawer({
  open,
  onClose,
  sessionId
}: {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const lines = useSessionsStore((state) => (sessionId ? (state.rawLog[sessionId] ?? []) : []));
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, open]);

  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.terminal")} subtitle={t("sessions.drawers.terminalNote")}>
      <div className="h-full overflow-y-auto bg-[#0a0c12] px-4 py-3">
        {lines.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-ink-3">
            <TerminalSquare className="h-6 w-6" aria-hidden />
            <p className="text-xs">{t("sessions.drawers.terminalEmpty")}</p>
          </div>
        ) : (
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {lines.map((line, index) => (
              <div key={index} className={line.startsWith("$ ") ? "mt-2 text-accent" : "text-[#a8e6a3]/90"}>
                {line}
              </div>
            ))}
            <div ref={bottomRef} />
          </pre>
        )}
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
 * F-035: diff / artifacts drawer.
 * ------------------------------------------------------------------------ */
function DiffView({ content }: { content: string }): JSX.Element {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <pre className="min-w-full font-mono text-xs leading-relaxed">
        {content.split("\n").map((line, index) => (
          <div
            key={index}
            className={cn(
              "px-4 whitespace-pre-wrap break-all",
              line.startsWith("+") && !line.startsWith("+++")
                ? "bg-ok/10 text-ok"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "bg-danger/10 text-danger"
                  : line.startsWith("@@")
                    ? "bg-info/10 text-info"
                    : "text-ink-2"
            )}
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ArtifactsDrawer({
  open,
  onClose,
  sessionId
}: {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}): JSX.Element {
  const { t } = useI18n();
  const artifacts = useSessionsStore((state) => (sessionId ? (state.artifacts[sessionId] ?? []) : []));
  const events = useSessionsStore((state) => (sessionId ? (state.events[sessionId] ?? []) : []));

  const changedFiles = useMemo(
    () =>
      events
        .filter((event) => event.data.kind === "file_change")
        .flatMap((event) => (event.data.kind === "file_change" ? event.data.files : [])),
    [events]
  );

  const tabs = [
    { value: "diff", label: t("sessions.drawers.tabs.diff") },
    { value: "api_contract", label: t("sessions.drawers.tabs.contract") },
    { value: "test_report", label: t("sessions.drawers.tabs.test") },
    { value: "commit", label: t("sessions.drawers.tabs.commit") }
  ];
  const [tab, setTab] = useState("diff");
  const [selectedFile, setSelectedFile] = useState(0);

  const filtered = artifacts.filter((artifact) => artifact.kind === tab);

  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.artifacts")} defaultWidth={1200}>
      <div className="flex h-full flex-col">
        <div className="border-b border-line px-5 py-3">
          <TabBar aria-label={t("sessions.drawers.artifacts")} value={tab} onValueChange={setTab} items={tabs} />
        </div>

        {tab === "diff" ? (
          changedFiles.length === 0 && filtered.length === 0 ? (
            <p className="flex-1 px-5 py-10 text-center text-sm text-ink-3">{t("sessions.drawers.noArtifacts")}</p>
          ) : (
            <div className="flex min-h-0 flex-1">
              <ul className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-line p-3">
                {changedFiles.map((file, index) => (
                  <li key={`${file.path}-${index}`}>
                    <button
                      onClick={() => setSelectedFile(index)}
                      aria-current={selectedFile === index}
                      className={cn(
                        "w-full truncate rounded-lg px-2.5 py-2 text-left font-mono text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                        selectedFile === index ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-card-hover"
                      )}
                      title={file.path}
                    >
                      {file.path.split("/").pop()}
                      <span className="ml-1.5 font-mono text-[10px]">
                        <span className="text-ok">+{file.additions}</span>{" "}
                        <span className="text-danger">-{file.deletions}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="min-w-0 flex-1">
                {changedFiles[selectedFile]?.diff ? (
                  <DiffView content={changedFiles[selectedFile].diff!} />
                ) : (
                  <p className="px-5 py-10 text-sm text-ink-3">{t("sessions.drawers.noArtifacts")}</p>
                )}
              </div>
            </div>
          )
        ) : filtered.length === 0 ? (
          <p className="flex-1 px-5 py-10 text-center text-sm text-ink-3">{t("sessions.drawers.noArtifacts")}</p>
        ) : (
          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {filtered.map((artifact) => (
              <section key={artifact.id} className="overflow-hidden rounded-xl border border-line">
                <header className="border-b border-line bg-card-hover px-4 py-2.5 text-[13px] font-medium text-ink-2">
                  {artifact.name}
                </header>
                <pre className="overflow-x-auto bg-card px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
                  {artifact.content}
                </pre>
              </section>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
 * F-034: task DAG drawer — only rendered when a plan created tasks.
 * ------------------------------------------------------------------------ */
function layoutDag(tasks: SessionTask[]): { x: number; y: number }[] {
  const levels: number[] = tasks.map(() => 0);
  const indexOf = new Map(tasks.map((task, index) => [task.id, index]));
  let changed = true;
  let guard = 0;
  while (changed && guard < 16) {
    changed = false;
    guard += 1;
    tasks.forEach((task, index) => {
      const level = task.dependencies.length
        ? Math.max(...task.dependencies.map((dep) => (levels[indexOf.get(dep) ?? -1] ?? -1) + 1))
        : 0;
      if (level !== levels[index]) {
        levels[index] = level;
        changed = true;
      }
    });
  }
  const perLevel = new Map<number, number>();
  return tasks.map((_, index) => {
    const level = levels[index];
    const row = perLevel.get(level) ?? 0;
    perLevel.set(level, row + 1);
    return { x: 40 + level * 220, y: 40 + row * 96 };
  });
}

export function DagDrawer({
  open,
  onClose,
  tasks
}: {
  open: boolean;
  onClose: () => void;
  tasks: SessionTask[];
}): JSX.Element {
  const { t } = useI18n();
  const positions = useMemo(() => layoutDag(tasks), [tasks]);
  const indexOf = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks]);
  const maxX = Math.max(0, ...positions.map((pos) => pos.x)) + 220;
  const maxY = Math.max(0, ...positions.map((pos) => pos.y)) + 110;

  const statusTone: Record<string, string> = {
    queued: "text-ink-3 border-line",
    running: "text-accent border-accent/50",
    completed: "text-ok border-ok/50",
    failed: "text-danger border-danger/50",
    blocked_dependency: "text-warn border-warn/50"
  };

  return (
    <Drawer open={open} onClose={onClose} title={t("sessions.drawers.dag")} subtitle={t("sessions.drawers.dagNote")} defaultWidth={560}>
      <div className="h-full overflow-auto p-4">
        <svg width={maxX} height={maxY} role="img" aria-label={t("sessions.drawers.dag")}>
          <defs>
            <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-3)" />
            </marker>
          </defs>
          {tasks.flatMap((task, index) =>
            task.dependencies.map((dep) => {
              const from = positions[indexOf.get(dep) ?? -1];
              const to = positions[index];
              if (!from || !to) return null;
              const x1 = from.x + 180;
              const y1 = from.y + 30;
              const x2 = to.x;
              const y2 = to.y + 30;
              const midX = (x1 + x2) / 2;
              return (
                <path
                  key={`${dep}-${task.id}`}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--line-strong)"
                  strokeWidth="1.5"
                  markerEnd="url(#dag-arrow)"
                />
              );
            })
          )}
          {tasks.map((task, index) => {
            const pos = positions[index];
            const tone = statusTone[task.status] ?? statusTone.queued;
            return (
              <g key={task.id} transform={`translate(${pos.x}, ${pos.y})`}>
                <rect width="180" height="60" rx="12" fill="var(--card)" stroke="var(--line-strong)" strokeWidth="1" />
                <rect width="4" height="60" rx="2" fill="currentColor" className={tone.split(" ")[0]} />
                <text x="16" y="24" fill="var(--ink)" fontSize="12" fontWeight="600">
                  {task.title.length > 14 ? `${task.title.slice(0, 14)}…` : task.title}
                </text>
                <text x="16" y="44" fill="var(--ink-3)" fontSize="11">
                  {task.memberName ?? "—"} · {t(`sessions.taskStatus.${task.status}` as MessageKey)}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="mt-3 flex flex-wrap gap-2 px-1">
          {tasks.map((task) => (
            <StatusChip
              key={task.id}
              tone={task.status === "completed" ? "ok" : task.status === "running" ? "accent" : task.status === "failed" ? "danger" : "muted"}
              label={`${task.title} · ${t(`sessions.taskStatus.${task.status}` as MessageKey)}`}
              pulse={task.status === "running"}
            />
          ))}
        </div>
      </div>
    </Drawer>
  );
}
