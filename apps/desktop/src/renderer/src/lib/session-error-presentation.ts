export function sessionErrorPresentation(code: string, message: string, zh: boolean): {
  title: string; description: string; stopped: boolean; settings?: "accounts" | "agents";
} {
  const stopped = code === "RUN_CANCELLED" || /CLI process cancel(?:led|ed)|run was cancel(?:led|ed)/i.test(message);
  if (stopped) return { title: zh ? "运行已停止" : "Run stopped", description: zh ? "可以从当前会话继续。" : "You can continue from this conversation.", stopped: true };
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}(?:api.?key|authorization|token)/i.test(message)) return {
    title: zh ? "连接未通过验证" : "Connection authentication failed",
    description: zh ? "服务端拒绝了连接，请检查当前供应商的 API Key 和接口地址。" : "The server rejected this connection. Check this provider’s API key and endpoint.", stopped: false, settings: "accounts"
  };
  if (code === "RUN_TIMEOUT") return { title: zh ? "运行超时" : "Run timed out", description: zh ? "本轮已达到运行时长上限，可以继续当前任务。" : "This run reached its time limit. You can continue the current task.", stopped: false };
  if (/ENOENT|os error [23]\b|系统找不到指定的路径|executable.*not found/i.test(message)) return {
    title: zh ? "运行环境未就绪" : "Runtime is unavailable",
    description: zh ? "找不到配置的可执行文件或工作目录，请检查 Harness 设置。" : "The configured executable or working directory could not be found. Check the harness settings.", stopped: false, settings: "agents"
  };
  return { title: zh ? "运行遇到问题" : "The run encountered a problem", description: message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim(), stopped: false };
}
