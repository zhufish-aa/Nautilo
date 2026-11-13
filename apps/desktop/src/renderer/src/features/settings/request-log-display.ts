export const ms = (n?: number) =>
  n === undefined ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`;
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
