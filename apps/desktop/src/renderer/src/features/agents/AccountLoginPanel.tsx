import { useEffect, useRef, useState } from "react";
import { Info, LogIn } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import type { AgentInstanceConfig } from "../../lib/types";

type LoginState = "idle" | "running" | "succeeded" | "failed" | "cancelled";
/** Login output deliberately stays inside the official CLI; no tokens reach UI. */
export function AccountLoginPanel({ instance, onLoginSuccess }: { instance: AgentInstanceConfig; onLoginSuccess?: () => void }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const google = instance.providerId === "antigravity";
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
    if (!accounts || !instance.loginProfileDirectory || busy || state === "running") return;
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
    idle: "尚未在本次应用运行中登录验证", running: "等待官方浏览器登录完成…", succeeded: "官方登录流程已完成；后续有效性由 CLI 检查", failed: "登录未完成", cancelled: "已取消登录"
  } : { idle: "Login has not been checked in this app session", running: "Waiting for official browser login…", succeeded: "Official login flow completed; the CLI checks continued validity", failed: "Login did not complete", cancelled: "Login cancelled" };
  return <div className="account-auth-card" data-state={state}>
    <div className="account-auth-heading"><span className="account-auth-symbol"><LogIn size={19} aria-hidden /></span><p role="status">{labels[state]}</p><Tooltip content={google ? (zh ? "由官方 agy 打开 Google 授权页面，凭据保存在系统凭据库。与 Antigravity 官方应用共享当前账号；切换账号会影响它们的登录。" : "Official agy opens Google OAuth and stores credentials in the OS keyring. The current account is shared with Antigravity. Switching accounts affects those apps too.") : (zh ? "使用独立目录登录一个账号。点击后由官方 CLI 打开浏览器；关闭此页面会取消等待。已有会话使用的目录不能改登其他账号。若 CLI 需要终端输入，请在终端设置 CODEX_HOME / CLAUDE_CONFIG_DIR 后登录。" : "The official CLI opens your browser. Leaving this page cancels the wait. Keep one account per directory. For terminal sign-in, set CODEX_HOME / CLAUDE_CONFIG_DIR to this directory.")}><button type="button" className="account-auth-help" aria-label={zh ? "登录说明" : "Login details"}><Info size={15} /></button></Tooltip></div>
    {instance.providerId === "claude-code" && <p className="account-auth-notice">{zh ? "支持 claude.ai 账号；不支持用目录隔离不带 API Key 的 Claude Console 登录。" : "Supports claude.ai accounts. Directory isolation does not separate Claude Console sign-ins without API keys."}</p>}
    {reason && <p role="alert" className="text-xs text-danger">{reason}</p>}
    <Button variant="outline" size="sm" disabled={busy || !getBridge()?.accounts} onClick={() => void (state === "running" ? cancel() : login())}><LogIn size={15} aria-hidden />{state === "running" ? (zh ? "取消登录" : "Cancel login") : (zh ? "通过官方 CLI 登录" : "Sign in with official CLI")}</Button>
  </div>;
}
