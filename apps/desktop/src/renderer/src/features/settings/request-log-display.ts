import type { RequestLog } from "@agenthub/schemas";

const recorded = (value?: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export const ms = (n?: number | null) =>
  !recorded(n) ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`;
export function duration(n?: number): string {
  if (!recorded(n) || n < 1000) return ms(n);
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const seconds = Math.floor(n / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
export const ttftTone = (n?: number) => !recorded(n) ? undefined : n < 3000 ? "good" : n <= 10_000 ? "slow" : "bad";
export function requestLogErrorMessage(error: unknown, zh: boolean): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error: /, "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  if (/IPC_NOT_FOUND|请求的资源不存在|requested resource (?:does not exist|was not found)/i.test(message)) {
    return zh ? "当前后台版本不包含请求日志接口。请重新启动 Nautilo，加载更新后的 Rust 后台。" : "The running backend does not include request logs. Restart Nautilo to load the updated Rust backend.";
  }
  return message;
}
export const stages = [
  ["queued", "排队", "Queue"],
  ["preparing", "准备请求", "Preparation"],
  ["prepared", "配置就绪", "Configuration ready"],
  ["dispatched", "交给 Harness", "Dispatched"],
  ["runtimeReady", "原生运行就绪", "Runtime ready"],
  ["firstEvent", "首个内容事件", "First content event"],
  ["firstThinking", "首段思考", "First reasoning"],
  ["firstText", "首段正文", "First text"],
  ["ended", "结束", "Finished"],
] as const;
export const statusLabel: Record<string, [string, string]> = {
  queued: ["排队中", "Queued"],
  preparing: ["准备中", "Preparing"],
  running: ["运行中", "Running"],
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  cancelled: ["已取消", "Cancelled"],
  interrupted: ["已中断", "Interrupted"],
};

export const liveRequest = (row: RequestLog) => ["queued", "preparing", "running"].includes(row.status);
export const abnormalRequest = (row: RequestLog) => ["failed", "cancelled", "interrupted"].includes(row.status);
export const phaseLabels = {
  local: ["本地调度", "Local setup"], waiting: ["首段内容等待", "First output wait"], output: ["思考、输出与工具", "Reasoning, output & tools"],
} as const;

export function requestTelemetry(rows: RequestLog[]) {
  const first = rows.map(row => row.milestones.firstText).filter(recorded).sort((a, b) => a - b);
  const totals = rows.map(row => row.milestones.ended).filter(recorded);
  const completed = rows.filter(row => row.status === "completed").length;
  const abnormal = rows.filter(abnormalRequest).length;
  const reused = rows.filter(row => row.runtime?.reused === true).length;
  const fresh = rows.filter(row => row.runtime?.reused === false).length;
  const percentile = (p: number) => {
    if (!first.length) return undefined;
    const rank = (first.length - 1) * p;
    const low = first[Math.floor(rank)]!;
    return Math.round(low + (first[Math.ceil(rank)]! - low) * (rank % 1));
  };
  return { completed, abnormal, reused, fresh, p50: percentile(.5), p95: percentile(.95), firstCount: first.length,
    maxFirst: first.at(-1), mean: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : undefined,
    longest: totals.length ? totals.reduce((max, n) => Math.max(max, n), 0) : undefined };
}

export function requestTrace(row: RequestLog) {
  const timing = row.milestones;
  const ready = recorded(timing.runtimeReady) ? timing.runtimeReady : undefined;
  const firstOutput = [timing.firstThinking, timing.firstText].filter(recorded).sort((a, b) => a - b)[0];
  const total = recorded(timing.ended) ? timing.ended : undefined;
  // Reasoning, text and tool callbacks may arrive in different orders on different Harnesses.
  const ordered = stages.map(([key, cn, en], index) => {
    const value = timing[key];
    const at = recorded(value) ? value : undefined;
    const next = stages.slice(index + 1).map(([nextKey]) => timing[nextKey]).find(recorded);
    return { key, cn, en, at, order: at ?? next ?? Infinity };
  }).sort((a, b) => a.order === b.order ? Number(a.at !== undefined) - Number(b.at !== undefined) : a.order - b.order);
  let previous = 0;
  const nodes = ordered.map(node => {
    const start = previous;
    if (node.at !== undefined) previous = node.at;
    const phase = ready !== undefined && node.at !== undefined && node.at <= ready ? "local"
      : firstOutput === undefined || (node.at !== undefined && node.at <= firstOutput) ? "waiting" : "output";
    return { ...node, start, delta: node.at === undefined ? undefined : node.at - start, phase };
  });
  const phases = [
    { key: "local", value: ready },
    { key: "waiting", value: ready !== undefined && firstOutput !== undefined && firstOutput >= ready ? firstOutput - ready : undefined },
    { key: "output", value: total !== undefined && firstOutput !== undefined && total >= firstOutput ? total - firstOutput : undefined },
  ] as const;
  const partitioned = total !== undefined && phases.every(phase => phase.value !== undefined)
    && phases.reduce((sum, phase) => sum + (phase.value ?? 0), 0) === total;
  const bottleneck = partitioned && total > 0
    ? [...phases].sort((a, b) => b.value! - a.value!)[0] : undefined;
  const longestNode = nodes.reduce<(typeof nodes)[number] | undefined>((max, node) => (node.delta ?? 0) > (max?.delta ?? 0) ? node : max, undefined);
  return { nodes, phases, total, partitioned, bottleneck, longestNode, horizon: previous };
}

export function tracePosition(value: number, horizon: number, logarithmic: boolean): number {
  if (horizon <= 0) return 0;
  return (logarithmic ? Math.log1p(value) / Math.log1p(horizon) : value / horizon) * 100;
}

export function traceReport(row: RequestLog, title: string, zh: boolean): string {
  const trace = requestTrace(row);
  const copy = (cn: string, en: string) => zh ? cn : en;
  const runtime = row.runtime;
  const tools = [
    [copy("实际观察的工具", "Observed tools"), row.observedTools],
    [copy("原生报告的工具", "Native-reported tools"), row.nativeTools],
    [copy("传入工具", "Supplied tools"), row.suppliedTools],
    [copy("传入 MCP", "Supplied MCP servers"), row.suppliedServers],
    [copy("原生 MCP", "Native MCP servers"), row.nativeServers?.map(server => [server.name, server.status].filter(Boolean).join(" · "))],
    [copy("已绑定 MCP", "Bound MCP servers"), row.mcp?.servers.map(server => server.name)],
  ] as const;
  return [
    `# ${title}`, "", `- Request ID: ${row.id}`, `- Session ID: ${row.sessionId}`,
    ...(row.runId ? [`- Run ID: ${row.runId}`] : []),
    ...(row.connectionId ? [`- ${copy("连接", "Connection")}: ${row.connectionId}${row.connectionRevision == null ? "" : ` / ${row.connectionRevision}`}`] : []),
    `- Harness: ${row.providerId}`, `- ${copy("模型", "Model")}: ${row.model ?? "—"}`,
    `- ${copy("状态", "Status")}: ${statusLabel[row.status]?.[zh ? 0 : 1] ?? row.status}`,
    `- ${copy("请求时间", "Started")}: ${row.createdAt}`,
    `- ${copy("总耗时", "Total")}: ${ms(trace.total)}`,
    ...(runtime?.pid != null ? [`- PID: ${runtime.pid}`] : []),
    ...(runtime?.reused != null ? [`- ${copy("进程", "Process")}: ${runtime.reused ? copy("复用", "Reused") : copy("冷启动", "Cold start")}`] : []),
    ...(runtime?.transport ? [`- Transport: ${runtime.transport}`] : []),
    ...(runtime?.attachMs != null ? [`- ${copy("进程附接", "Process attach")}: ${ms(runtime.attachMs)}`] : []),
    ...(trace.bottleneck ? [`- ${copy("主要耗时", "Bottleneck")}: ${phaseLabels[trace.bottleneck.key][zh ? 0 : 1]} · ${ms(trace.bottleneck.value)} (${Math.round(trace.bottleneck.value! / trace.total! * 100)}%)`]
      : trace.longestNode ? [`- ${copy("已观测最长节点间隔", "Longest observed interval")}: ${zh ? trace.longestNode.cn : trace.longestNode.en} · ${ms(trace.longestNode.delta)}`] : []),
    ...trace.phases.filter(phase => phase.value !== undefined).map(phase => `- ${phaseLabels[phase.key][zh ? 0 : 1]}: ${ms(phase.value)}`),
    "", `| ${copy("节点", "Milestone")} | +Δ | @t |`, "| --- | ---: | ---: |",
    ...trace.nodes.map(node => `| ${zh ? node.cn : node.en} | ${ms(node.delta)} | ${ms(node.at)} |`),
    "", ...tools.flatMap(([label, values]) => values?.length ? [`- ${label}: ${values.join(", ")}`] : []),
    ...(row.failure ? ["", `## ${[row.failure.stage, row.failure.code].filter(Boolean).join(" · ")}`, "", row.failure.message] : []),
  ].join("\n");
}
