import { useEffect, useRef, useState } from "react";
import { LogIn } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import type { AgentInstanceConfig } from "../../lib/types";

type LoginState = "idle" | "running" | "succeeded" | "failed" | "cancelled";
/** Login output deliberately stays inside the official CLI; no tokens reach UI. */
export function AccountLoginPanel({ instance }: { instance: AgentInstanceConfig }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const profileId = `${instance.id}:${instance.loginProfileDirectory ?? ""}`;
  const [state, setState] = useState<LoginState>("idle");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const activeId = useRef<string>();
  const operation = useRef(false);
  useEffect(() => {
    let active = true;
    activeId.current = profileId;
    const accounts = getBridge()?.accounts;
    setState("idle"); setReason(""); setBusy(false);
    const poll = async (): Promise<void> => {
      if (operation.current) return;
      try { const status = await accounts?.loginStatus(profileId); if (active && !operation.current && status) { setState(status.state); setReason(status.reason ?? ""); } }
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
  return <div className="space-y-3 rounded-xl border border-line p-4">
    <p role="status" className="text-sm text-ink-2">{labels[state]}</p>
    <p className="text-xs leading-relaxed text-ink-3">{zh ? "使用独立目录登录一个账号。点击后由官方 CLI 打开浏览器；关闭此页面会取消等待。不要把已有会话使用的目录改登为另一个账号。" : "Sign in to one account per directory. The official CLI opens your browser; leaving this page cancels the wait. Do not sign a different account into a directory used by existing conversations."}</p>
    {instance.providerId === "claude-code" && <p className="text-xs text-ink-3">{zh ? "支持 claude.ai 账号；不支持用目录隔离不带 API Key 的 Claude Console 登录。" : "Supports claude.ai accounts. Directory isolation does not separate Claude Console sign-ins without API keys."}</p>}
    {reason && <p role="alert" className="text-xs text-danger">{reason}</p>}
    <Button variant="outline" size="sm" disabled={busy || !getBridge()?.accounts} onClick={() => void (state === "running" ? cancel() : login())}><LogIn className="h-4 w-4" aria-hidden />{state === "running" ? (zh ? "取消登录" : "Cancel login") : (zh ? "通过官方 CLI 登录" : "Sign in with official CLI")}</Button>
    <p className="text-xs text-ink-3">{zh ? "需要原生可执行文件。若 CLI 需要终端输入，请在终端设置该目录对应的 CODEX_HOME / CLAUDE_CONFIG_DIR 后登录。未读取或复制任何令牌。" : "Requires a native executable. If the CLI requires terminal input, set CODEX_HOME / CLAUDE_CONFIG_DIR to this directory in a terminal and sign in there. Tokens are never read or copied."}</p>
  </div>;
}
