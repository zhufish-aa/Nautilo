import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Braces, Maximize2 } from "lucide-react";
import type { WorkflowDefinition, WorkflowNode } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { promptVariables, unknownPromptPaths } from "./workflow-editing";

export function WorkflowPrompt({ definition, node, onChange }: {
  definition: WorkflowDefinition; node: WorkflowNode; onChange(text: string): void;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [manual, setManual] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const text = node.prompt ?? "";
  const groups = promptVariables(definition, node);
  const invalid = unknownPromptPaths(definition, node);
  const prefix = text.slice(0, cursor).match(/(?<!\\)\{\{\s*([^{}\r\n]*)$/);
  const filter = prefix?.[1].trim().toLowerCase() ?? "";
  const matches = groups.map(group => ({ ...group, entries: group.entries.filter(entry => [entry.label, entry.path, entry.description].some(value => value?.toLowerCase().includes(filter))) }));
  const choices = matches.flatMap(group => group.entries);
  const open = !hidden && (manual || !!prefix);

  function updateCaret(element: HTMLTextAreaElement) {
    setCursor(element.selectionStart);
    setActive(0);
    const anchor = caret.current;
    if (anchor) setPosition({ x: Math.max(0, anchor.offsetLeft - element.scrollLeft), y: Math.max(0, anchor.offsetTop + anchor.offsetHeight - element.scrollTop) });
  }

  function insert(entry: { path: string; literal?: boolean }) {
    const element = input.current;
    if (!element) return;
    const start = prefix?.index ?? element.selectionStart;
    const end = prefix && text.startsWith("}}", element.selectionEnd) ? element.selectionEnd + 2 : element.selectionEnd;
    const value = entry.literal ? entry.path : "{{" + entry.path + "}}";
    onChange(text.slice(0, start) + value + text.slice(end));
    setManual(false); setHidden(true);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(start + value.length, start + value.length); updateCaret(element); });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setHidden(true); setManual(false); }
    if (!choices.length) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setActive((active + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length);
    }
    if (event.key === "Enter") { event.preventDefault(); insert(choices[active % choices.length]); }
  }

  const editor = <div className="wf-prompt-editor">
    <div ref={mirror} aria-hidden="true" className="wf-prompt-mirror">
      {text.split(/(\\\{\{|\{\{[^{}\r\n]*\}\})/g).map((part, index) => {
        const path = part.startsWith("{{") ? part.slice(2, -2).trim() : undefined;
        return path !== undefined ? <mark key={index} data-invalid={invalid.has(path)}>{part}</mark> : part;
      })}{" "}
      <div className="wf-caret-measure">{text.slice(0, cursor)}<span ref={caret}>​</span></div>
    </div>
    <textarea id={id} ref={input} aria-label="任务提示词" aria-expanded={open} aria-controls={open ? id + "-options" : undefined}
      value={text} spellCheck={false} placeholder="填写任务提示词，输入 {{ 插入变量"
      onChange={event => { onChange(event.target.value); setHidden(false); updateCaret(event.currentTarget); }}
      onSelect={event => updateCaret(event.currentTarget)} onKeyDown={onKeyDown}
      onBlur={() => { setHidden(true); setManual(false); }}
      onScroll={event => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; updateCaret(event.currentTarget); }}/>
    {open && <div className="wf-variable-menu" id={id + "-options"} style={{ top: Math.min(position.y + 4, 150), left: Math.min(position.x, 48) }}>
      {matches.filter(group => group.entries.length > 0).map(group => <div key={group.label}><small>{group.label}</small>
        {group.entries.map(entry => <button type="button" key={entry.path} data-active={entry === choices[active % choices.length]}
          title={entry.path} onMouseDown={event => event.preventDefault()} onClick={() => insert(entry)}>{entry.label}{entry.description && <span>{entry.description}</span>}</button>)}
      </div>)}
      {!choices.length && <small>没有匹配的字段</small>}
    </div>}
    {!!invalid.size && <small className="wf-variable-error" title="未声明的变量，可能导致运行时缺失">未声明的变量 {Array.from(invalid, path => "{{" + path + "}}").join(" · ")}</small>}
  </div>;

  const insertButton = <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
    if (input.current) { input.current.focus(); updateCaret(input.current); }
    setHidden(false); setManual(true);
  }}><Braces size={13}/>插入变量</button>;
  return <>
    <div className="wf-field-title"><label htmlFor={id}>任务提示词</label><div className="wf-field-tools">{insertButton}<button type="button" onClick={() => { setExpanded(true); setHidden(true); setManual(false); }}><Maximize2 size={12}/>放大编辑</button></div></div>
    {!expanded && editor}
    <Dialog open={expanded} onOpenChange={setExpanded} title="任务提示词" widthClass="max-w-5xl">
      <div className="wf-prompt-expanded">{editor}<aside>{groups.map(group => <section key={group.label}><strong>{group.label}</strong>
        {group.entries.map(entry => <button key={entry.path} type="button" title={entry.path} onMouseDown={event => event.preventDefault()} onClick={() => insert(entry)}>{entry.label}{entry.description && <span>{entry.description}</span>}</button>)}
        {!group.entries.length && <small>暂无字段</small>}
      </section>)}</aside></div>
    </Dialog>
  </>;
}
