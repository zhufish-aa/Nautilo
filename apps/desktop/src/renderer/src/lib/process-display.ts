import type { CodeExecution } from "@agenthub/event-protocol";

export type ToolCallBranch = { call: CodeExecution["calls"][number]; children: ToolCallBranch[] };

/** Apply native PTC dispatch patches without losing sibling calls or their order. */
export function mergeCodeExecution(previous: CodeExecution | undefined, next: CodeExecution | undefined): CodeExecution | undefined {
  if (!next) return previous;
  if (!next.partial) return next;
  if (!next.calls.length && previous) return previous;
  const calls = [...previous?.calls ?? []];
  const indices = new Map(calls.map((call, index) => [call.callId, index]));
  for (const patch of next.calls) {
    const index = indices.get(patch.callId);
    if (index === undefined) { indices.set(patch.callId, calls.length); calls.push(patch); continue; }
    const current = calls[index]!;
    calls[index] = { ...current, ...patch, input: patch.input ?? current.input, output: patch.output ?? current.output, meta: patch.meta ?? current.meta,
      status: current.status !== "running" && patch.status === "running" ? current.status : patch.status };
  }
  return { calls, description: next.description ?? previous?.description };
}

export function codeCallDescription(call: CodeExecution["calls"][number], zh: boolean): { title: string; summary: string } {
  let input = call.input;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* Show the original input in details. */ } }
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const name = call.name.replace(/^tools[.:/]/, "");
  const titles: Record<string, string> = zh
    ? { pwsh:"运行命令", bash:"运行命令", exec_command:"运行命令", write_stdin:"终端输入", read:"读取文件", read_file:"读取文件", read_image:"查看图片", write:"写入文件", write_file:"写入文件", edit:"编辑文件", apply_patch:"修改文件", glob:"查找文件", grep:"搜索内容", run_code:"执行代码", job_output:"查看任务输出", job_poll:"查看任务状态", job_list:"后台任务", job_cancel:"取消后台任务", job_kill:"取消后台任务" }
    : { pwsh:"Run command", bash:"Run command", exec_command:"Run command", write_stdin:"Terminal input", read:"Read file", read_file:"Read file", read_image:"View image", write:"Write file", write_file:"Write file", edit:"Edit file", apply_patch:"Patch file", glob:"Find files", grep:"Search", run_code:"Run code", job_output:"Job output", job_poll:"Job status", job_list:"Background jobs", job_cancel:"Cancel background job", job_kill:"Cancel background job" };
  const detail = [args.description, args.file_path, args.path, args.filePath, args.command, args.cmd, args.query, args.pattern, args.jobId, args.job_id].find(value => typeof value === "string" && value.trim());
  const status = toolOutput(call.output, zh).status;
  return { title: titles[name] ?? call.name, summary: [typeof detail === "string" ? detail.split(/\r?\n/, 1)[0] : "", status].filter(Boolean).join(" · ") };
}
/** Preserve dispatch ancestry while keeping malformed/cyclic records visible. */
export function toolCallTree(calls: CodeExecution["calls"]): ToolCallBranch[] {
  const byId = new Map(calls.map(call => [call.callId, call]));
  const children = new Map<string, CodeExecution["calls"]>();
  for (const call of calls) {
    if (call.parentCallId && call.parentCallId !== call.callId && byId.has(call.parentCallId)) {
      const siblings = children.get(call.parentCallId) ?? [];
      siblings.push(call); children.set(call.parentCallId, siblings);
    }
  }
  const seen = new Set<string>();
  const build = (call: CodeExecution["calls"][number], depth: number): ToolCallBranch => {
    seen.add(call.callId);
    const nested: ToolCallBranch[] = [];
    if (depth < 32) for (const child of children.get(call.callId) ?? []) if (!seen.has(child.callId)) nested.push(build(child, depth + 1));
    return { call, children: nested };
  };
  const result: ToolCallBranch[] = [];
  for (const call of calls) if ((!call.parentCallId || !byId.has(call.parentCallId) || call.parentCallId === call.callId) && !seen.has(call.callId)) result.push(build(call, 0));
  for (const call of calls) if (!seen.has(call.callId)) result.push(build(call, 0));
  return result;
}

/** Keep the collapsed preview steady while the next paragraph is streaming. */
export function reasoningPreview(text: string, streaming: boolean): string {
  const paragraphs = text.trimStart().split(/\r?\n[\t ]*\r?\n/);
  const paragraph = streaming && paragraphs.length > 1 ? paragraphs.at(-2) : paragraphs[0];
  return (paragraph?.split(/\r?\n/, 1)[0] ?? "").replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim().slice(0, 500);
}

export type ToolOutput = { status?: string; fields: Array<[string, string]>; text: string };
/** Format common terminal receipts without claiming their background job ended. */
export function toolOutput(output: string | undefined, zh: boolean): ToolOutput {
  if (!output) return { fields: [], text: "" };
  let value: unknown;
  try { value = JSON.parse(output); } catch {
    const cancelled = /^requested cancellation of job\s+(\S+)\s*$/i.exec(output.trim());
    if (cancelled) return { status: zh ? "已请求取消" : "Cancellation requested", fields: [[zh ? "任务" : "Job", cancelled[1]!]], text: "" };
    return { fields: [], text: output };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { fields: [], text: output };
  const record = value as Record<string, unknown>;
  const labels: Record<string, string> = zh ? { jobId: "任务", cwd: "目录", timeoutMs: "超时", exitCode: "退出码", status: "状态", kind: "类型" } : { jobId: "Job", cwd: "Directory", timeoutMs: "Timeout", exitCode: "Exit code", status: "Status", kind: "Type" };
  const status = record.outcome === "cancellation-requested" ? (zh ? "已请求取消" : "Cancellation requested")
    : record.outcome === "already-finished" ? (zh ? "任务已结束" : "Job already finished")
    : record.kind === "promoted" ? (zh ? "已转为后台任务" : "Moved to background")
    : record.status === "running" ? (zh ? "后台运行中" : "Running in background")
    : record.status === "stopping" ? (zh ? "正在停止" : "Stopping") : undefined;
  const fields: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (key === "output" || entry == null || entry === "" || (status && ["kind", "status", "outcome"].includes(key))) continue;
    fields.push([labels[key] ?? key, key === "timeoutMs" && typeof entry === "number" ? `${entry / 1000}s` : typeof entry === "string" ? entry : JSON.stringify(entry, null, 2)]);
  }
  return { status, fields, text: typeof record.output === "string" ? record.output : "" };
}
