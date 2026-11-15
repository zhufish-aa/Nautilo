import type { RemoteSettings } from "@agenthub/schemas";

export function relayConnectionFeedback(input: { ready: boolean; seenReady: boolean; elapsedMs: number; errors: string[] }, zh: boolean) {
  if (input.ready) return { label: zh ? "中继通道就绪" : "Relay ready", detail: "", retryable: false };
  if (input.errors.length) return { label: zh ? "中继连接失败" : "Relay connection failed", detail: input.errors[0]!, retryable: true };
  if (input.elapsedMs >= 15_000) return {
    label: zh ? "中继暂未连通" : "Relay unavailable",
    detail: zh ? "尚未建立可用的中继连接，可重试或检查节点与当前网络。" : "No relay connection is available. Retry or check the relay and current network.", retryable: true
  };
  return { label: input.seenReady ? (zh ? "正在恢复中继连接" : "Reconnecting to relay") : (zh ? "正在连接中继" : "Connecting to relay"), detail: "", retryable: input.seenReady };
}

export function normalizeRelayUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

export function relaySettingsError(settings: RemoteSettings, zh: boolean): string {
  if (!["custom", "direct", "local"].includes(settings.relayMode)) return "";
  const urls = normalizeRelayUrls(settings.relayUrls);
  if (urls.length > 4) return zh ? "最多填写 4 个中继地址。" : "Enter at most 4 relay URLs.";
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.search && !url.hash) continue;
    } catch { /* Show the same actionable message for malformed URLs. */ }
    return zh ? "请填写有效的 HTTPS 中继地址，或留空使用公共节点。" : "Enter a valid HTTPS relay URL, or leave blank to use public nodes.";
  }
  return "";
}
