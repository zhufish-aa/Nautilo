import { useEffect, useState } from "react";
import { Check, ChevronRight, Copy, FolderOpen } from "lucide-react";
import type { AccountEnrichedMeta, RuntimeConnection } from "@agenthub/domain";
import { accountQuotaSource, type AccountQuota } from "@agenthub/schemas";
import { getBridge } from "../../lib/bridge";
import { useAccountQuota } from "../../lib/account-quota";
import { useI18n } from "../../lib/i18n";
import { toast } from "../../stores/toast";

const timeLabel = (time: string, locale: string) => new Date(time).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });

function relativeTime(time: string, locale: string, now: number): string {
  const minutes = (Date.parse(time) - now) / 60_000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (Math.abs(minutes) >= 1440) return format.format(Math.round(minutes / 1440), "day");
  if (Math.abs(minutes) >= 60) return format.format(Math.round(minutes / 60), "hour");
  return format.format(Math.round(minutes), "minute");
}

export function AccountSummary({ connection, modelCount, defaultModel, onModels, now }: { connection: RuntimeConnection; modelCount: number; defaultModel?: string; onModels: () => void; now: number }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const meta = connection.accountMeta;
  const source = accountQuotaSource(connection);
  const { id, revision, enabled } = connection;
  const { quota, status: quotaStatus } = useAccountQuota({ connectionId: id, revision }, !!source && enabled, meta?.lastVerifiedAt);
  const window = quota?.windows.reduce<AccountQuota["windows"][number] | undefined>((most, item) => !most || item.usedPercent > most.usedPercent ? item : most, undefined);
  const coolingUntil = meta?.rateLimitedUntil;
  const cooling = coolingUntil && Date.parse(coolingUntil) > now;
  const auth = meta?.authStatus ?? "unverified";
  const status = { valid: ["有效", "Valid"], expiring: ["即将过期", "Expiring"], expired: ["已失效", "Expired"], unverified: ["待确认", "Unconfirmed"], error: ["异常", "Error"] }[auth][zh ? 0 : 1];
  const checkDetail = meta?.lastCheckedAt && !meta.lastErrorSummary && meta.lastLatencyMs !== undefined
    ? `${zh ? "目录可读" : "Catalog reachable"} · ${meta.lastLatencyMs} ms` : undefined;
  const usage = meta?.localUsage;
  const number = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 });
  const requests = usage && (zh ? `今日 ${usage.requestsToday} 次` : `${usage.requestsToday} today`);
  const usageDetail = [requests, usage?.cacheHitRate7d === undefined ? undefined : `${zh ? "缓存命中" : "Cache hit"} ${Math.round(usage.cacheHitRate7d)}%`].filter(Boolean).join(" · ");
  const activeUsage = usage && (usage.requestsToday > 0 || usage.tokens7d > 0);
  const usagePercent = window && Math.min(100, Math.max(0, window.usedPercent));
  const minutes = window?.windowMinutes;
  const period = minutes === 10_080 ? (zh ? "周额度" : "Weekly")
    : minutes && minutes % 1440 === 0 ? (zh ? `${minutes / 1440} 天` : `${minutes / 1440}d`)
    : minutes && minutes % 60 === 0 ? (zh ? `${minutes / 60} 小时` : `${minutes / 60}h`)
    : minutes ? (zh ? `${minutes} 分钟` : `${minutes} min`) : undefined;
  const quotaLabel = [window?.label, period].filter(Boolean).join(" · ") || (zh ? "额度" : "Quota");
  const reset = window?.resetsAt && Date.parse(window.resetsAt) > now
    ? `${zh ? "重置 " : "Resets "}${relativeTime(window.resetsAt, locale, now)}` : undefined;
  const quotaNote = quotaStatus === "ready" ? reset : quotaStatus === "loading"
    ? (zh ? "上次额度 · 正在刷新" : "Last reading · refreshing") : quotaStatus === "failed"
      ? (zh ? "上次额度 · 刷新失败" : "Last reading · refresh failed") : (zh ? "上次额度" : "Last reading");
  return <section className="connection-overview" aria-label={zh ? "额度与运行概览" : "Quota and activity"}>
    {cooling && <div className="connection-quota-heading"><strong data-tone="warn">{zh ? "限流冷却中" : "Rate limited"}</strong><small>{zh ? "预计恢复 " : "Resumes "}{relativeTime(coolingUntil, locale, now)}</small></div>}
    {window && usagePercent !== undefined ? <div className="connection-quota">
      <div className="connection-quota-heading"><strong title={quotaLabel}>{quotaLabel} {Math.round(usagePercent)}% {zh ? "已用" : "used"}</strong>{quotaNote && <small title={reset}>{quotaNote}</small>}</div>
      <progress value={usagePercent} max={100} aria-label={quotaLabel} data-tone={usagePercent > 85 ? "warn" : "blue"}/>
    </div> : source && enabled && !cooling && <p className="connection-quota-status" role="status">{quotaStatus === "loading" ? (zh ? "正在读取额度…" : "Reading limits…") : quotaStatus === "failed" ? (zh ? "额度读取失败" : "Could not read limits") : (zh ? "服务商未返回额度" : "Provider returned no limits")}</p>}
    <dl className="connection-overview-stats">
      <div><dt>{zh ? "CLI 凭证" : "CLI credentials"}</dt><dd><strong title={meta?.tokenExpiresAt ? timeLabel(meta.tokenExpiresAt, locale) : undefined}><i className="connection-status-dot" data-tone={auth === "valid" ? "ok" : auth === "expired" || auth === "error" ? "danger" : "warn"}/>{status}</strong>{checkDetail && <small>{checkDetail}</small>}</dd></div>
      <div><dt>{zh ? "已配模型" : "Configured models"}</dt><dd><button type="button" onClick={onModels}><strong>{modelCount}{zh ? " 个模型" : " models"}<ChevronRight size={13}/></strong></button>{defaultModel && <small title={defaultModel}>{defaultModel}</small>}</dd></div>
      {activeUsage && <div><dt>{zh ? "本地用量（7日）" : "Local usage (7d)"}</dt><dd><strong>{usage.tokens7d ? `${number.format(usage.tokens7d)} tokens` : requests}</strong>{usage.tokens7d > 0 && <small title={usageDetail}>{usageDetail}</small>}</dd></div>}
    </dl>
  </section>;
}

export function AccountStorage({ storage }: { storage: NonNullable<AccountEnrichedMeta["storageMeta"]> }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [copied, setCopied] = useState(false);
  const directory = storage.configDir;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyPath = async (path: string): Promise<void> => {
    try { await navigator.clipboard.writeText(path); setCopied(true); }
    catch { toast.error(zh ? "无法复制目录路径" : "Could not copy the directory path"); }
  };
  const openPath = async (path: string): Promise<void> => {
    try {
      const error = await getBridge()?.shell.openPath(path);
      if (error) toast.error(error);
    } catch (error) { toast.error(String(error)); }
  };
  const methods = { system_keyring: ["系统凭据库 · Google 登录", "OS keyring · Google sign-in"], cli_oauth: ["官方 CLI OAuth", "Official CLI OAuth"], console_oauth: ["OpenCode Console 浏览器授权", "OpenCode Console OAuth"] };
  const copyLabel = copied ? (zh ? "已复制" : "Copied") : (zh ? "复制路径" : "Copy path");
  const openLabel = zh ? "打开目录" : "Open directory";
  return <section className="connection-storage">
    <h3>{zh ? "隔离存储与凭证详情" : "Account storage and credentials"}</h3>
    {directory && <div className="connection-storage-path">
      <div><span>{zh ? "隔离目录" : "Profile directory"}</span><code title={directory}>{directory}</code></div>
      <button type="button" title={copyLabel} aria-label={copyLabel} onClick={() => void copyPath(directory)}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
      <button type="button" title={openLabel} aria-label={openLabel} disabled={!getBridge()?.shell} onClick={() => void openPath(directory)}><FolderOpen size={15}/></button>
    </div>}
    {(storage.authMethod || storage.credentialUpdatedAt) && <dl>
      {storage.authMethod && <div><dt>{zh ? "认证方式" : "Authentication"}</dt><dd>{methods[storage.authMethod][zh ? 0 : 1]}</dd></div>}
      {storage.credentialUpdatedAt && <div><dt>{zh ? "凭证更新时间" : "Credential updated"}</dt><dd className="connection-mono">{timeLabel(storage.credentialUpdatedAt, locale)}</dd></div>}
    </dl>}
  </section>;
}
