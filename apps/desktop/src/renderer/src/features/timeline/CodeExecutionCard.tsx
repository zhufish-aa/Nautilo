import { memo, useMemo, useState } from "react";
import { AlertTriangle, Check, Code2, Copy } from "lucide-react";
import type { TimelinePayload } from "../../lib/types";
import { codeExecutionInput } from "../../lib/tool-display";
import { toolOutput, toolCallTree, codeCallDescription, type ToolCallBranch } from "../../lib/process-display";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { ToolActivityIcon } from "./ToolActivityIcon";
import { WorkflowToolActivity, workflowTool } from "./WorkflowToolActivity";
import { VirtualList } from "../../components/ui/VirtualList";
import "./CodeExecutionCard.css";

type Activity = Extract<TimelinePayload, { kind: "tool_activity" }>;

function Output({ value, zh, failed }: { value?: string; zh: boolean; failed?: boolean }): JSX.Element | null {
  const result = useMemo(() => toolOutput(value, zh), [value, zh]);
  if (!value) return null;
  return <div className="ptc-output" data-error={failed || undefined}>
    <span className="ptc-output-label">{zh ? "输出" : "Output"}</span>
    <div className="ptc-output-content">
      {result.status && <p>{result.status}</p>}
      {result.fields.length > 0 && <dl className="ptc-fields">{result.fields.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>}
      {result.text && <pre>{result.text}</pre>}
    </div>
  </div>;
}

function Program({ code, zh, truncated }: { code: string; zh: boolean; truncated?: boolean }): JSX.Element {
  const [copied, setCopied] = useState<string>();
  const [error, setError] = useState(false);
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(code); setCopied(code); setError(false); }
    catch { setError(true); }
  };
  return <div className="ptc-code">
    <div className="ptc-code-toolbar"><span>JavaScript</span><button type="button" onClick={() => void copy()} aria-label={zh ? "复制代码" : "Copy code"}>
      {copied === code ? <Check size={13} /> : <Copy size={13} />}{zh ? (error ? "复制失败" : copied === code ? "已复制" : "复制") : (error ? "Copy failed" : copied === code ? "Copied" : "Copy")}
    </button></div>
    <pre><code>{code.trim()}</code></pre>
    {truncated && <p className="ptc-truncated">{zh ? "历史记录仅保存了部分代码" : "Only part of this historical code was saved"}</p>}
  </div>;
}

const ToolBranch = memo(function ToolBranch({ branch, sessionId, runId, zh }: { branch: ToolCallBranch; sessionId: string; runId?: string; zh: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const call = branch.call;
  const action = workflowTool(call.name);
  const description = codeCallDescription(call, zh);
  const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input as Record<string, unknown> : { input: call.input };
  return <div className="ptc-branch">
    {action ? <WorkflowToolActivity action={action} name={call.name} sessionId={sessionId} runId={runId} input={call.input} output={call.output} status={call.status} zh={zh} /> : <ProcessDisclosure icon={call.status === "failed" ? <AlertTriangle size={14}/> : <ToolActivityIcon name={call.name} input={JSON.stringify(call.input)} />} label={description.title}
      preview={description.summary} retainPreview open={open} onToggle={() => setOpen(value => !value)} running={call.status === "running"} failed={call.status === "failed"}>
      <div className="ptc-detail">
        {typeof input.code === "string" && <Program code={input.code} zh={zh} />}
        {call.input != null && <dl className="ptc-fields ptc-input">{Object.entries(input).filter(([key]) => !["description", "code"].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd></div>)}</dl>}
        <Output value={call.output} zh={zh} failed={call.status === "failed"} />
      </div>
    </ProcessDisclosure>}
  </div>;
});

export function CodeExecutionCard({ data, locale, sessionId, runId }: { data: Activity; locale: "zh-CN" | "en-US"; sessionId: string; runId?: string }): JSX.Element {
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const program = useMemo(() => codeExecutionInput(data.input), [data.input]);
  const branches = useMemo(() => toolCallTree(data.codeExecution?.calls ?? []), [data.codeExecution]);
  const calls = useMemo(() => {
    const rows: Array<{ branch: ToolCallBranch; depth: number }> = [];
    const append = (items: ToolCallBranch[], depth: number): void => { for (const branch of items) { rows.push({ branch, depth }); append(branch.children, depth + 1); } };
    append(branches, 0); return rows;
  }, [branches]);
  const result = useMemo(() => toolOutput(data.output, zh), [data.output, zh]);
  const actualCall = data.codeExecution?.calls.find(call => call.status === "running") ?? data.codeExecution?.calls.at(-1);
  const purpose = (program.description ?? data.codeExecution?.description)?.split(/\r?\n/, 1)[0];
  const activity = actualCall && codeCallDescription(actualCall, zh);
  const preview = [purpose, calls.length ? (zh ? `${calls.length} 个工具` : `${calls.length} tools`) : undefined,
    activity && (activity.summary || activity.title), result.status].filter(Boolean).join(" · ");
  const Icon = data.status === "failed" ? AlertTriangle : Code2;
  return <div className="ptc-execution">
    <ProcessDisclosure icon={<Icon size={14}/>} label={zh ? "执行代码" : "Run code"}
      preview={preview} retainPreview open={open} onToggle={() => setOpen(value => !value)} running={data.status === "running"} failed={data.status === "failed"}>
      <div className="ptc-detail">
        {calls.length > 0 && <VirtualList className="ptc-call-list" label={zh ? "实际工具调用" : "Observed tool calls"} keyboard rows={calls.map(({ branch, depth }) => ({
          key: branch.call.callId, size: workflowTool(branch.call.name) ? 38 : 30,
          render: () => <div style={{ paddingInlineStart: Math.min(depth, 8) * 12 }}><ToolBranch branch={branch} sessionId={sessionId} runId={runId} zh={zh}/></div>
        }))}/>}
        {program.code && <details className="ptc-source"><summary>{zh ? "源代码" : "Source code"}</summary><Program code={program.code} zh={zh} truncated={program.truncated} /></details>}
        <Output value={data.output} zh={zh} failed={data.status === "failed"} />
      </div>
    </ProcessDisclosure>
  </div>;
}
