import { memo, useMemo, useState } from "react";
import { AlertTriangle, Check, Code2, Copy, Loader2 } from "lucide-react";
import type { TimelinePayload } from "../../lib/types";
import { codeExecutionInput } from "../../lib/tool-display";
import { toolOutput, toolCallTree, codeCallDescription, type ToolCallBranch } from "../../lib/process-display";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { ToolActivityIcon } from "./ToolActivityIcon";
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

const ToolBranch = memo(function ToolBranch({ branch, zh }: { branch: ToolCallBranch; zh: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const call = branch.call;
  const description = codeCallDescription(call, zh);
  const Icon = call.status === "running" ? Loader2 : AlertTriangle;
  const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input as Record<string, unknown> : { input: call.input };
  return <div className="ptc-branch">
    <ProcessDisclosure icon={call.status === "done" ? <ToolActivityIcon name={call.name} input={JSON.stringify(call.input)} /> : <Icon size={14} className={call.status === "running" ? "animate-spin" : undefined} />} label={description.title}
      preview={description.summary} retainPreview open={open} onToggle={() => setOpen(value => !value)} running={call.status === "running"} failed={call.status === "failed"}>
      <div className="ptc-detail">
        {typeof input.code === "string" && <Program code={input.code} zh={zh} />}
        {call.input != null && <dl className="ptc-fields ptc-input">{Object.entries(input).filter(([key]) => !["description", "code"].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd></div>)}</dl>}
        <Output value={call.output} zh={zh} failed={call.status === "failed"} />
      </div>
    </ProcessDisclosure>
    {branch.children.length > 0 && <div className="ptc-subcalls">{branch.children.map(child => <ToolBranch key={child.call.callId} branch={child} zh={zh} />)}</div>}
  </div>;
});

export function CodeExecutionCard({ data, locale }: { data: Activity; locale: "zh-CN" | "en-US" }): JSX.Element {
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const program = useMemo(() => codeExecutionInput(data.input), [data.input]);
  const branches = useMemo(() => toolCallTree(data.codeExecution?.calls ?? []), [data.codeExecution]);
  const result = useMemo(() => toolOutput(data.output, zh), [data.output, zh]);
  const actualCall = data.codeExecution?.calls.find(call => call.status === "running") ?? data.codeExecution?.calls[0];
  const preview = [(program.description ?? data.codeExecution?.description)?.split(/\r?\n/, 1)[0] || (actualCall ? codeCallDescription(actualCall, zh).summary || codeCallDescription(actualCall, zh).title : undefined), result.status].filter(Boolean).join(" · ");
  const Icon = data.status === "running" ? Loader2 : data.status === "failed" ? AlertTriangle : Code2;
  return <div className="ptc-execution">
    <ProcessDisclosure icon={<Icon size={14} className={data.status === "running" ? "animate-spin" : undefined} />} label={zh ? "执行代码" : "Run code"}
      preview={preview} retainPreview open={open} onToggle={() => setOpen(value => !value)} running={data.status === "running"} failed={data.status === "failed"}>
      <div className="ptc-detail">
        {program.code && <Program code={program.code} zh={zh} truncated={program.truncated} />}
        <Output value={data.output} zh={zh} failed={data.status === "failed"} />
      </div>
    </ProcessDisclosure>
    {branches.length > 0 && <div className="ptc-subcalls">{branches.map(branch => <ToolBranch key={branch.call.callId} branch={branch} zh={zh} />)}</div>}
  </div>;
}
