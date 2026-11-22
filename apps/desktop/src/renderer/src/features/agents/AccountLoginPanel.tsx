import { useEffect, useRef, useState } from "react";
import { Info, LogIn } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import type { AgentInstanceConfig } from "../../lib/types";
import { useConnectionsStore } from "../../stores/connections";

type LoginState = "idle" | "running" | "succeeded" | "failed" | "cancelled";
/** Login output deliberately stays inside the official CLI; no tokens reach UI. */
export function AccountLoginPanel({ instance, onLoginSuccess, disabled }: { instance: AgentInstanceConfig; onLoginSuccess?: () => void; disabled?: boolean }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const google = instance.providerId === "antigravity";
  const meta = useConnectionsStore(store => store.connections.find(item => item.id === instance.id)?.accountMeta);
  const profileId = `${instance.id}:${instance.loginProfileDirectory ?? ""}`;
  const [state, setState] = useState<LoginState>("idle");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const activeId = useRef<string>();
  const operation = useRef(false);
  const successCallback = useRef(onLoginSuccess);
  successCallback.current = onLoginSuccess;
  useEffect(() => {
    let active = true;
    let reportedSuccess = false;
    activeId.current = profileId;
    const accounts = getBridge()?.accounts;
    setState("idle"); setReason(""); setBusy(false);
    const poll = async (): Promise<void> => {
      if (operation.current) return;
      try {
        const status = await accounts?.loginStatus(profileId);
        if (active && !operation.current && status) {
          setState(status.state); setReason(status.reason ?? "");
          if (status.state === "succeeded" && !reportedSuccess) successCallback.current?.();
          reportedSuccess = status.state === "succeeded";
        }
      }
      catch { if (active) setReason(zh ? "无法读取登录进度" : "Unable to read login progress"); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => { active = false; activeId.current = undefined; clearInterval(timer); void accounts?.cancelLogin(profileId).catch(() => undefined); };
  }, [profileId, zh]);
  const login = async (): Promise<void> => {
    const accounts = getBridge()?.accounts;
    if (!accounts || !instance.executable || !instance.loginProfileDirectory || disabled || busy || state === "running") return;
    operation.current = true; setBusy(true); setReason("");
    try {
      const result = await accounts.startLogin({ profileId: profileId, providerId: instance.providerId, executable: instance.executable, directory: instance.loginProfileDirectory });
      if (activeId.current !== profileId) { if (result.ok) await accounts.cancelLogin(profileId); return; }
      setState(result.ok ? "running" : "failed"); setReason(result.reason ?? "");
    } catch { setState("failed"); setReason(zh ? "桌面登录功能暂不可用" : "Desktop login is unavailable"); }
    finally { operation.current = false; if (activeId.current === profileId) setBusy(false); }
  };
  const cancel = async (): Promise<void> => {
    operation.current = true; setBusy(true);
    try { const accounts = getBridge()?.accounts; await accounts?.cancelLogin(profileId); const status = await accounts?.loginStatus(profileId); if (status && activeId.current === profileId) { setState(status.state); setReason(status.reason ?? ""); } }
    catch { setReason(zh ? "未能取消，请在官方登录窗口退出" : "Could not cancel. Close the official login window."); }
    finally { operation.current = false; if (activeId.current === profileId) setBusy(false); }
  };
  const labels: Record<LoginState, string> = zh ? {
    idle: "本机 CLI 登录待确认", running: "等待官方浏览器登录完成…", succeeded: "官方登录流程已完成", failed: "登录未完成", cancelled: "已取消登录"
  } : { idle: "Local CLI sign-in unconfirmed", running: "Waiting for official browser login…", succeeded: "Official login completed", failed: "Login did not complete", cancelled: "Login cancelled" };
  const savedTitle = { valid: ["本机 CLI 凭证可用", "Local CLI credentials available"], expiring: ["登录凭证即将过期", "Login credentials are expiring"], expired: ["登录凭证已失效，需重新验证", "Login credentials expired"], error: ["认证异常，需重新验证", "Authentication failed"], unverified: [labels.idle, labels.idle] }[meta?.authStatus ?? "unverified"][zh ? 0 : 1];
  const persisted = state === "idle" || state === "succeeded";
  const status = persisted && meta?.authStatus && meta.authStatus !== "unverified" ? savedTitle : labels[state];
  const subtitle = !instance.executable ? (zh ? "安装对应官方 CLI 后可重新登录" : "Install the official CLI to sign in")
    : persisted && meta?.authStatus === "error" ? (zh ? "服务拒绝了当前凭证" : "The service rejected these credentials")
    : meta?.lastVerifiedAt && meta.authStatus !== "unverified" ? `${zh ? "上次验证" : "Last verified"} ${new Date(meta.lastVerifiedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}`
    : google ? (zh ? "Google 登录 · 系统凭据库" : "Google sign-in · OS keyring") : (zh ? "官方 CLI OAuth · 独立账号目录" : "Official CLI OAuth · isolated profile");
  return <div className="account-auth-card" data-state={persisted && meta?.authStatus === "valid" ? "succeeded" : state}>
    <div className="account-auth-heading"><span className="account-auth-symbol"><LogIn size={17} aria-hidden /></span><div className="account-auth-copy"><p role="status">{status}</p><small>{subtitle}</small></div><Tooltip content={google ? (zh ? "由官方 agy 打开 Google 授权页面，凭据保存在系统凭据库。与 Antigravity 官方应用共享当前账号；切换账号会影响它们的登录。" : "Official agy opens Google OAuth and stores credentials in the OS keyring. The current account is shared with Antigravity. Switching accounts affects those apps too.") : (zh ? "使用独立目录登录一个账号。点击后由官方 CLI 打开浏览器；关闭此页面会取消等待。已有会话使用的目录不能改登其他账号。若 CLI 需要终端输入，请在终端设置 CODEX_HOME / CLAUDE_CONFIG_DIR 后登录。" : "The official CLI opens your browser. Leaving this page cancels the wait. Keep one account per directory. For terminal sign-in, set CODEX_HOME / CLAUDE_CONFIG_DIR to this directory.")}><button type="button" className="account-auth-help" aria-label={zh ? "登录说明" : "Login details"}><Info size={15} /></button></Tooltip></div>
    {instance.providerId === "claude-code" && <p className="account-auth-notice">{zh ? "支持 claude.ai 账号；不支持用目录隔离不带 API Key 的 Claude Console 登录。" : "Supports claude.ai accounts. Directory isolation does not separate Claude Console sign-ins without API keys."}</p>}
    {reason && (state === "running"
      ? <p role="status" className="whitespace-pre-wrap break-words text-xs text-ink-2">{reason}</p>
      : <p role="alert" className="text-xs text-danger">{reason}</p>)}
    <Button variant="outline" size="sm" disabled={busy || !getBridge()?.accounts || state !== "running" && (disabled || !instance.executable)} onClick={() => void (state === "running" ? cancel() : login())}><LogIn size={15} aria-hidden />{state === "running" ? (zh ? "取消登录" : "Cancel login") : meta?.authStatus === "valid" ? (zh ? "重新验证" : "Verify again") : (zh ? "通过官方 CLI 登录" : "Sign in with official CLI")}</Button>
  </div>;
}
