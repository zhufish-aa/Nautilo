import type { ReactNode } from "react";
import { Bot, FilePenLine, FilePlus2, FileText, FileX, Globe, Plug, Search, Terminal, Wrench } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { formatToolClusterSummary, isToolClusterStep, type ToolClusterStep } from "../../lib/tool-display";
import type { TimelineEvent } from "../../lib/types";
import { BrowserActivityIcon } from "./BrowserActivity";
import { ProcessDisclosure } from "./ProcessDisclosure";

const icons = { read: FileText, edit: FilePenLine, write: FilePlus2, delete: FileX, command: Terminal,
  browser: BrowserActivityIcon, web: Globe, search: Search, agent: Bot, mcp: Plug, tool: Wrench };

export function ToolStepGroup({ steps, open, onToggle, children }: {
  steps: ToolClusterStep[]; open: boolean; onToggle: () => void; children: ReactNode;
}): JSX.Element {
  const { locale } = useI18n();
  const { label, kind, running, failed, standalone } = formatToolClusterSummary(steps, locale);
  if (standalone) return <>{children}</>;
  const Icon = icons[kind];
  return <ProcessDisclosure className="tool-step-group" label={label}
    icon={kind === "browser" ? <BrowserActivityIcon /> : <Icon size={14} />} open={open} onToggle={onToggle}
    accessory={failed > 0 && <span className="tool-step-group-failures">
      · {locale === "zh-CN" ? `${failed} 项失败` : `${failed} failed`}
    </span>}
    running={running}>
    {children}
  </ProcessDisclosure>;
}

function isNativeSubagentEvent(event: TimelineEvent | undefined): event is TimelineEvent & { data: { kind: "tool_activity" } } {
  return Boolean(event && event.data.kind === "tool_activity" && event.data.subagent);
}

export function TurnProcess({ events, liveTail, choices, setChoice, renderEvent, renderSubagentGroup }: {
  events: (TimelineEvent | undefined)[];
  liveTail: boolean;
  choices: Readonly<Record<string, boolean>>;
  setChoice: (id: string, open: boolean) => void;
  renderEvent: (event: TimelineEvent) => ReactNode;
  renderSubagentGroup?: (events: readonly (TimelineEvent & { data: { kind: "tool_activity" } })[]) => ReactNode;
}): JSX.Element {
  const nodes: ReactNode[] = [];
  for (let index = 0; index < events.length;) {
    const event = events[index++];
    if (!event) continue;
    if (isNativeSubagentEvent(event) && renderSubagentGroup) {
      const group: (TimelineEvent & { data: { kind: "tool_activity" } })[] = [event];
      while (isNativeSubagentEvent(events[index])) {
        group.push(events[index++] as TimelineEvent & { data: { kind: "tool_activity" } });
      }
      nodes.push(<div key={event.id}>{renderSubagentGroup(group)}</div>);
      continue;
    }
    if (!isToolClusterStep(event.data)) {
      const commentary = event.data.kind === "message" && event.data.sender === "agent";
      nodes.push(<div key={event.id} className={commentary ? "conversation-commentary" : undefined}>{renderEvent(event)}</div>);
      continue;
    }
    const steps = [event.data];
    const rows = [event];
    let next = events[index];
    while (next && isToolClusterStep(next.data) && !(renderSubagentGroup && isNativeSubagentEvent(next))) {
      steps.push(next.data);
      rows.push(next);
      next = events[++index];
    }
    const open = choices[event.id] ?? (liveTail && index === events.length);
    nodes.push(<ToolStepGroup key={event.id} steps={steps} open={open} onToggle={() => setChoice(event.id, !open)}>
      {rows.map(row => <div key={row.id}>{renderEvent(row)}</div>)}
    </ToolStepGroup>);
  }
  return <>{nodes}</>;
}
