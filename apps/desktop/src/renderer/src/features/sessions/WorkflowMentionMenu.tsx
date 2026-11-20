import { useEffect, useRef } from "react";
import { Workflow } from "lucide-react";
import type { WorkflowTemplate } from "@agenthub/domain";

export interface WorkflowQuery { start: number; end: number; text: string }

export function workflowQueryAt(value: string, cursor: number): WorkflowQuery | undefined {
  const before = value.slice(0, cursor);
  const start = before.lastIndexOf("@");
  if (start < 0 || /[a-z0-9_.+-]/i.test(before[start - 1] ?? "")) return;
  const text = before.slice(start + 1);
  if (text.includes("\n")) return;
  return { start, end: cursor, text: text.trim().toLowerCase() };
}

export function WorkflowMentionMenu({ id, templates, active, loaded, error, zh, onSelect, onHighlight }: {
  id: string;
  templates: WorkflowTemplate[];
  active: number;
  loaded: boolean;
  error: boolean;
  zh: boolean;
  onSelect(template: WorkflowTemplate): void;
  onHighlight(index: number): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const option = list.current?.children[active] as HTMLElement | undefined;
    option?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, templates]);
  return (
    <div className="workflow-mention-menu" onMouseDown={event => event.preventDefault()}>
      <div className="workflow-mention-header"><Workflow size={14} aria-hidden />{zh ? "引用工作流" : "Reference a workflow"}</div>
      <div ref={list} id={id} className="workflow-mention-options" role="listbox" aria-label={zh ? "已保存的工作流" : "Saved workflows"}>
        {templates.map((template, index) => <button type="button" role="option" id={id + "-" + index}
          aria-selected={index === active} key={template.id} onMouseEnter={() => onHighlight(index)} onClick={() => onSelect(template)}>
          <span className="workflow-mention-icon"><Workflow size={15} aria-hidden /></span>
          <span className="workflow-mention-title">{template.name}</span>
          <span className="workflow-mention-revision">v{template.revision}</span>
        </button>)}
      </div>
      {!templates.length && <p role="status" className="workflow-mention-empty">
        {error ? (zh ? "暂时无法读取流程库" : "Could not load workflows")
          : !loaded ? (zh ? "正在读取流程库…" : "Loading workflows…")
          : (zh ? "没有匹配的已保存流程" : "No matching saved workflows")}
      </p>}
    </div>
  );
}
