import type { RuntimeConnection } from "@agenthub/domain";
import type { AgentInstanceConfig } from "./types";

export function connectionSendError(error: string, zh: boolean): string {
  const message = error.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  if (/Confirm provider\/account switch|Confirm rebuilding text context/.test(message)) {
    return zh ? "账号切换尚未确认。请在模型菜单中选择账号并确认切换，然后重试。" : "Confirm the account change in the model menu, then retry your message.";
  }
  if (/database or disk is full|SQLITE_FULL|StorageFull|磁盘空间不足|os error 112/i.test(message)) {
    return zh ? "应用数据所在磁盘空间不足，无法保存会话或启动请求。请释放磁盘空间后重试，未发送的内容已保留。" : "The app's data disk is full. Free some space and retry; your unsent message is retained.";
  }
  if (/This harness\/protocol combination is not supported/.test(message)) {
    return zh ? "当前后台仍是旧版本。请重启 Nautilo 加载更新后重试。" : "The running backend is an older version. Restart Nautilo to load the update, then retry.";
  }
  return message;
}
/** A selectable account is enabled for its relay only when the user selects it. */
export function connectionCanBeSelected(connection: RuntimeConnection, instance: AgentInstanceConfig): boolean {
  if (!connection.enabled || instance.baseArgs.length > 0 || instance.profile?.trim()) return false;
  return connectionSupportsAgent(connection, instance) ||
    (instance.providerId !== "antigravity" && connection.kind === "login" && (connection.harness === "codex" || connection.harness === "claude-code"));
}
/** Native accounts keep their identity; other harnesses use an explicit account relay. */
export function connectionSupportsAgent(connection: RuntimeConnection, instance: AgentInstanceConfig): boolean {
  if (!connection.enabled || instance.baseArgs.length > 0 || instance.profile?.trim()) return false;
  if (instance.providerId === "antigravity") return connection.kind === "login" && connection.harness === "antigravity" && connection.nativeLogin === true;
  if (connection.kind === "login") return connection.accountGateway === true || (["codex", "claude-code"].includes(instance.providerId) && connection.harness === instance.providerId);
  // A provider plugin owns its native API configuration. There is no CLI allowlist.
  return ["responses", "chat", "anthropic"].includes(connection.protocol ?? "");
}
