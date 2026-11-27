import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  Folder,
  Maximize2,
  Minimize2,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolFileDiff } from "@agenthub/event-protocol";
import { highlightCode, highlightCodeLines, languageForPath } from "../../lib/highlight";
import type { ToolActivityKind } from "../../lib/tool-display";
import { ToolFileDiffView } from "./ToolFileDiffView";
import "./tool-call-details.css";

function parseJsonObject(raw?: string): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    const nested = obj.arguments ?? obj.input;
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return obj;
  } catch {
    return undefined;
  }
}

function tryPrettyJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return undefined;
  }
}

function compactCwd(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

function formatTimeout(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function numberOf(obj: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringOf(obj: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function countLines(text?: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split(/\r?\n/).length;
}

function useCopyFlag(): [string, (tag: string, value: string) => void] {
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(""), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (tag: string, value: string): void => {
    void navigator.clipboard.writeText(value).then(() => setCopied(tag)).catch(() => {});
  };
  return [copied, copy];
}

/** Crisp obsidian terminal output card shared by CommandCard & command-kind ToolActivityCard. */
export function CommandDetails({
  command,
  shell,
  cwd,
  timeoutLabel,
  output,
  exitCode,
  failed = false,
  locale,
}: {
  command: string;
  shell?: string;
  cwd?: string;
  timeoutLabel?: string;
  output?: string;
  exitCode?: number;
  failed?: boolean;
  locale: "zh-CN" | "en-US";
}): JSX.Element {
  const zh = locale === "zh-CN";
  const [copied, copy] = useCopyFlag();
  const [expanded, setExpanded] = useState(false);

  const isPowerShell = /pwsh|powershell/i.test(shell ?? "") || /\$(?:env:|_|\w+\s*=)|Get-ChildItem|Select-Object|Test-Path/i.test(command);
  const isCmd = /^cmd$/i.test(shell ?? "");
  const promptMark = isPowerShell ? "PS>" : isCmd ? "CMD>" : "$";
  const shellName = shell || (isPowerShell ? "pwsh" : "shell");
  const highlightedCmd = useMemo(
    () => highlightCode(command, "", isPowerShell ? "powershell" : "bash"),
    [command, isPowerShell],
  );
  const outLines = useMemo(() => countLines(output), [output]);
  const isLongOutput = outLines > 14;

  return (
    <div className="tc-card tc-card-command" data-failed={failed || undefined} data-running={(!output && exitCode === undefined && !failed) || undefined}>
      <div className="tc-header">
        <span className="tc-shell-badge" data-ps={isPowerShell || undefined}>
          <Terminal size={11} aria-hidden />
          {shellName}
        </span>
        {cwd && (
          <span className="tc-meta-pill" title={cwd}>
            <Folder size={11} aria-hidden />
            <code>{compactCwd(cwd)}</code>
          </span>
        )}
        {timeoutLabel && <span className="tc-meta-pill tc-meta-mono">{timeoutLabel}</span>}
        {exitCode !== undefined && (
          <span className="tc-exit-pill" data-failed={exitCode !== 0 || undefined}>
            exit {exitCode}
          </span>
        )}
        <div className="tc-header-actions">
          <button
            type="button"
            className="tc-action-btn"
            data-copied={copied === "cmd" || undefined}
            onClick={() => copy("cmd", command)}
            title={zh ? "复制命令" : "Copy command"}
          >
            {copied === "cmd" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
            <span>{copied === "cmd" ? (zh ? "已复制" : "Copied") : (zh ? "复制命令" : "Copy")}</span>
          </button>
        </div>
      </div>

      <div className="tc-cmd-line">
        <span className="tc-cmd-prompt" aria-hidden>{promptMark}</span>
        <pre className="tc-cmd-code"><code dangerouslySetInnerHTML={{ __html: highlightedCmd }} /></pre>
      </div>

      {output && (
        <div className="tc-section">
          <div className="tc-subbar">
            <span className="tc-subbar-label">
              {zh ? "输出" : "Output"}
              <small>{outLines} {zh ? "行" : "lines"}</small>
            </span>
            <div className="tc-header-actions">
              {isLongOutput && (
                <button type="button" className="tc-action-btn" onClick={() => setExpanded(v => !v)}>
                  {expanded ? <Minimize2 size={11} aria-hidden /> : <Maximize2 size={11} aria-hidden />}
                  <span>{expanded ? (zh ? "收起" : "Compact") : (zh ? "展开全部" : "Expand")}</span>
                </button>
              )}
              <button
                type="button"
                className="tc-action-btn"
                data-copied={copied === "out" || undefined}
                onClick={() => copy("out", output)}
                title={zh ? "复制输出" : "Copy output"}
              >
                {copied === "out" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
                <span>{copied === "out" ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}</span>
              </button>
            </div>
          </div>
          <pre className="tc-output-pre" data-expanded={expanded || undefined}>{output}</pre>
        </div>
      )}
    </div>
  );
}

function FileReadDetails({
  toolName,
  parsed,
  path,
  output,
  failed,
  locale,
  onOpenFile,
}: {
  toolName: string;
  parsed?: Record<string, unknown>;
  path?: string;
  output?: string;
  failed: boolean;
  locale: "zh-CN" | "en-US";
  onOpenFile?: (path: string) => void;
}): JSX.Element {
  const zh = locale === "zh-CN";
  const [copied, copy] = useCopyFlag();
  const [expanded, setExpanded] = useState(false);

  const startLine = numberOf(parsed, ["offset", "start_line", "startLine", "StartLine", "from"]) ?? 1;
  const limit = numberOf(parsed, ["limit", "max_lines", "maxLines"]);
  const endLine = numberOf(parsed, ["end_line", "endLine", "EndLine", "to"])
    ?? (limit ? startLine + limit - 1 : undefined);
  const rangeLabel = endLine ? `L${startLine}–${endLine}` : startLine > 1 ? `L${startLine}+` : undefined;
  const lang = languageForPath(path);
  const cleanOutput = output?.replace(/\r?\n$/, "") ?? "";

  const highlightedLines = useMemo(() => {
    if (!cleanOutput) return [];
    if (cleanOutput.length > 60_000) {
      return cleanOutput.split(/\r?\n/).map(line => line.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
    }
    return highlightCodeLines(cleanOutput, path ?? "");
  }, [cleanOutput, path]);
  const isLong = highlightedLines.length > 16;

  return (
    <div className="tc-card tc-card-read" data-failed={failed || undefined}>
      <div className="tc-header">
        <span className="tc-file-title" title={path}>
          <FileCode2 size={12} aria-hidden />
          {path && onOpenFile ? (
            <button type="button" className="tc-file-link" onClick={() => onOpenFile(path)}>
              {path}
            </button>
          ) : (
            <code>{path || toolName}</code>
          )}
        </span>
        {rangeLabel && <span className="tc-meta-pill tc-meta-mono">{rangeLabel}</span>}
        {lang && <span className="tc-meta-pill tc-meta-mono">{lang}</span>}
        {highlightedLines.length > 0 && (
          <span className="tc-meta-pill tc-meta-mono">{highlightedLines.length} {zh ? "行" : "L"}</span>
        )}
        <div className="tc-header-actions">
          {isLong && (
            <button type="button" className="tc-action-btn" onClick={() => setExpanded(v => !v)}>
              {expanded ? <Minimize2 size={11} aria-hidden /> : <Maximize2 size={11} aria-hidden />}
              <span>{expanded ? (zh ? "收起" : "Compact") : (zh ? "展开" : "Expand")}</span>
            </button>
          )}
          {output && (
            <button
              type="button"
              className="tc-action-btn"
              data-copied={copied === "read" || undefined}
              onClick={() => copy("read", output)}
            >
              {copied === "read" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
              <span>{copied === "read" ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}</span>
            </button>
          )}
        </div>
      </div>
      {highlightedLines.length > 0 ? (
        <div className="tc-code-scroll" data-expanded={expanded || undefined}>
          <table className="tc-code-table">
            <tbody>
              {highlightedLines.map((html, idx) => (
                <tr key={idx}>
                  <td className="tc-line-no" aria-hidden>{startLine + idx}</td>
                  <td className="tc-line-code"><code dangerouslySetInnerHTML={{ __html: html || " " }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : output !== undefined ? (
        <p className="tc-empty-note">{zh ? "（空文件）" : "(Empty file)"}</p>
      ) : null}
    </div>
  );
}

function GenericToolDetails({
  kind,
  parsed,
  input,
  output,
  failed,
  locale,
}: {
  kind: ToolActivityKind;
  parsed?: Record<string, unknown>;
  input?: string;
  output?: string;
  failed: boolean;
  locale: "zh-CN" | "en-US";
}): JSX.Element {
  const zh = locale === "zh-CN";
  const [copied, copy] = useCopyFlag();
  const [expanded, setExpanded] = useState(false);

  const paramEntries = parsed ? Object.entries(parsed).filter(([, value]) => value !== undefined && value !== null && value !== "") : [];
  const prettyOutput = useMemo(() => (output ? tryPrettyJson(output) : undefined), [output]);
  const highlightedOutput = useMemo(
    () => (prettyOutput && prettyOutput.length <= 60_000 ? highlightCode(prettyOutput, "", "json") : undefined),
    [prettyOutput],
  );
  const outLines = useMemo(() => countLines(prettyOutput ?? output), [prettyOutput, output]);
  const isLongOut = outLines > 14;
  const HeaderIcon = kind === "search" ? Search : Wrench;

  return (
    <div className="tc-card tc-card-generic" data-failed={failed || undefined}>
      {paramEntries.length > 0 ? (
        <div className="tc-params-block">
          <div className="tc-header">
            <span className="tc-shell-badge">
              <HeaderIcon size={11} aria-hidden />
              {zh ? "调用参数" : "Arguments"}
            </span>
            <div className="tc-header-actions">
              {input && (
                <button
                  type="button"
                  className="tc-action-btn"
                  data-copied={copied === "in" || undefined}
                  onClick={() => copy("in", input)}
                >
                  {copied === "in" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
                  <span>{copied === "in" ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}</span>
                </button>
              )}
            </div>
          </div>
          <dl className="tc-kv-grid">
            {paramEntries.map(([key, value]) => {
              const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
              const isMultiline = formatted.includes("\n") || formatted.length > 84;
              return (
                <div key={key} className="tc-kv-row" data-block={isMultiline || undefined}>
                  <dt>{key}</dt>
                  <dd><code>{formatted}</code></dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : input ? (
        <div className="tc-section">
          <div className="tc-subbar">
            <span className="tc-subbar-label">{zh ? "输入" : "Input"}</span>
            <button type="button" className="tc-action-btn" data-copied={copied === "in" || undefined} onClick={() => copy("in", input)}>
              {copied === "in" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
              <span>{copied === "in" ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}</span>
            </button>
          </div>
          <pre className="tc-output-pre">{input}</pre>
        </div>
      ) : null}

      {output && (
        <div className="tc-section">
          <div className="tc-subbar">
            <span className="tc-subbar-label">
              {zh ? "返回结果" : "Output"}
              <small>{outLines} {zh ? "行" : "lines"}</small>
            </span>
            <div className="tc-header-actions">
              {isLongOut && (
                <button type="button" className="tc-action-btn" onClick={() => setExpanded(v => !v)}>
                  {expanded ? <Minimize2 size={11} aria-hidden /> : <Maximize2 size={11} aria-hidden />}
                  <span>{expanded ? (zh ? "收起" : "Compact") : (zh ? "展开全部" : "Expand")}</span>
                </button>
              )}
              <button
                type="button"
                className="tc-action-btn"
                data-copied={copied === "out" || undefined}
                onClick={() => copy("out", prettyOutput ?? output)}
              >
                {copied === "out" ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
                <span>{copied === "out" ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}</span>
              </button>
            </div>
          </div>
          {highlightedOutput ? (
            <pre className="tc-output-pre" data-expanded={expanded || undefined}>
              <code dangerouslySetInnerHTML={{ __html: highlightedOutput }} />
            </pre>
          ) : (
            <pre className="tc-output-pre" data-expanded={expanded || undefined}>{output}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Smart structured obsidian inspector for expanded tool calls. */
export function ToolCallDetails({
  toolName,
  kind,
  status,
  input,
  output,
  path,
  command,
  executor,
  resolvedFileDiff,
  locale,
  onOpenFile,
}: {
  toolName: string;
  kind: ToolActivityKind;
  status: "running" | "done" | "failed";
  input?: string;
  output?: string;
  path?: string;
  command?: string;
  executor?: string;
  resolvedFileDiff?: ToolFileDiff;
  locale: "zh-CN" | "en-US";
  onOpenFile?: (path: string) => void;
}): JSX.Element {
  const zh = locale === "zh-CN";
  const parsed = useMemo(() => parseJsonObject(input), [input]);
  const failed = status === "failed";

  if (resolvedFileDiff) {
    return (
      <div className="tc-card tc-card-diff" data-failed={failed || undefined}>
        <ToolFileDiffView diff={resolvedFileDiff} locale={locale} />
        {input && (
          <details className="tc-raw-disclosure">
            <summary><ChevronDown size={12} aria-hidden />{zh ? "原始参数" : "Raw arguments"}</summary>
            <pre className="tc-output-pre">{tryPrettyJson(input) ?? input}</pre>
          </details>
        )}
        {output && (
          <div className="tc-section">
            <div className="tc-subbar">
              <span className="tc-subbar-label">{zh ? "返回结果" : "Result"}</span>
            </div>
            <pre className="tc-output-pre">{output}</pre>
          </div>
        )}
      </div>
    );
  }

  if (kind === "command" && command) {
    const cwd = stringOf(parsed, ["cwd", "workdir", "working_directory", "workingDirectory", "directory"]);
    const timeoutLabel = formatTimeout(parsed?.timeoutMs ?? parsed?.timeout_ms ?? parsed?.timeout);
    const shell = /powershell|pwsh/i.test(toolName) ? "pwsh"
      : /bash/i.test(toolName) ? "bash"
      : /cmd/i.test(toolName) ? "cmd"
      : executor;
    return (
      <CommandDetails
        command={command}
        shell={shell}
        cwd={cwd}
        timeoutLabel={timeoutLabel}
        output={output}
        failed={failed}
        locale={locale}
      />
    );
  }

  if ((kind === "read" || kind === "skill") && (path || output)) {
    return (
      <FileReadDetails
        toolName={toolName}
        parsed={parsed}
        path={path}
        output={output}
        failed={failed}
        locale={locale}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <GenericToolDetails
      kind={kind}
      parsed={parsed}
      input={input}
      output={output}
      failed={failed}
      locale={locale}
    />
  );
}
