import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { ACCOUNT_HARNESSES, accountHarnessName, connectOfficialAccount, type AccountHarness, type ConnectStage } from "./account-connect";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";

type RecoverableProfile = { profileId: string; providerId: string; directory: string; createdAt: number };

function loginError(cause: unknown, zh: boolean): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ACCOUNT_PROFILE_PERMISSIONS|SeSecurityPrivilege|NAUTILO_ACCOUNT_DIR/.test(message)) {
    return zh ? "无法设置独立账号目录的访问权限。请确认目录归当前 Windows 用户所有且允许写入，然后重试。" : "Could not secure the account directory. Check that it is owned by your Windows user and writable, then retry.";
  }
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function AccountConnectDialog({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange(open: boolean): void; onConnected(connection: RuntimeConnection): void }): JSX.Element {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [recoverable, setRecoverable] = useState<RecoverableProfile[]>([]);
  const [stage, setStage] = useState<ConnectStage>(); const [error, setError] = useState("");
  const [activeHarness, setActiveHarness] = useState<AccountHarness>();
  const controller = useRef<AbortController>(); const generation = useRef(0);
  const loadRecoverable = async (): Promise<void> => {
    const request = generation.current;
    try {
      const profiles = await getBridge()?.accounts.recoverableLogins?.() ?? [];
      const saved = new Set(useConnectionsStore.getState().connections.map((connection) => connection.id));
      if (request === generation.current) setRecoverable(profiles.filter((profile) => !saved.has(profile.profileId) && ACCOUNT_HARNESSES.includes(profile.providerId as AccountHarness)));
    } catch { if (request === generation.current) setError((current) => current || (zh ? "无法读取未完成的登录记录，请稍后重试。" : "Could not read unfinished login records. Try again later.")); }
  };
  useEffect(() => {
    generation.current++; setStage(undefined); setError(""); setRecoverable([]);
    if (open) void loadRecoverable();
    return () => { generation.current++; controller.current?.abort(); };
  }, [open]);
  const close = (value: boolean): void => { if (stage === "saving") return; if (!value) controller.current?.abort(); onOpenChange(value); };
  const connect = async (harness: AccountHarness, recovered?: RecoverableProfile): Promise<void> => {
    if (controller.current && !controller.current.signal.aborted) return;
    const nativeAccount = harness === "antigravity" && useConnectionsStore.getState().connections.find(item => item.kind === "login" && item.harness === harness && item.nativeLogin);
    if (nativeAccount) { onConnected(nativeAccount); onOpenChange(false); return; }
    const accounts = getBridge()?.accounts;
    if (!accounts?.prepareLogin) { setError(zh ? "请在支持账号登录的桌面版本中使用此功能。" : "Use a desktop build that supports account login."); return; }
    const request = ++generation.current, abort = new AbortController(); controller.current = abort; setError(""); setActiveHarness(harness);
    const provider = accountHarnessName(harness);
    const count = useConnectionsStore.getState().connections.filter((item) => item.kind === "login" && item.harness === harness).length + 1;
    try {
      const result = await connectOfficialAccount(harness, `${provider} ${zh ? "账号" : "account"} ${count}`, abort.signal, (next) => { if (request === generation.current) setStage(next); }, {
        detect: async (id) => {
          await useAgentsStore.getState().redetect(id);
          const installation = useAgentsStore.getState().installations.find((item) => item.providerId === id);
          if (installation?.status !== "ready" || !installation.executable) throw new Error(zh ? `未找到可用的 ${provider} 官方 CLI。请先安装或在 Harness 管理中修复检测，再重试。` : `A working ${provider} CLI was not found. Install it or repair detection in Agent settings, then retry.`);
          return installation.executable;
        },
        reusePrepared: !!recovered,
        prepare: recovered ? async () => recovered : accounts.prepareLogin,
        acknowledge: (profileId, providerId) => accounts.acknowledgeLogin?.({ profileId, providerId }) ?? Promise.resolve(),
        start: accounts.startLogin, status: accounts.loginStatus, cancel: accounts.cancelLogin,
        save: (connection) => useConnectionsStore.getState().save(connection)
      });
      void useConnectionsStore.getState().loadModels(result.id, result.revision, true);
      if (request === generation.current && !abort.signal.aborted) { setStage(undefined); onConnected(result); onOpenChange(false); }
    } catch (cause) {
      if (request === generation.current && !abort.signal.aborted) { setStage(undefined); setError(`${loginError(cause, zh)} ${zh ? "已生成的账号空间会保留，可从未完成登录记录恢复。" : "Prepared account profiles are retained and can be recovered below."}`); void loadRecoverable(); }
    } finally { if (controller.current === abort) controller.current = undefined; }
  };
  const stages = zh ? { detecting: "检查官方 CLI…", preparing: activeHarness === "antigravity" ? "准备 Google 官方登录…" : "准备独立账号空间…", login: "等待官方浏览器登录完成…", saving: "添加账号连接…" } : { detecting: "Checking the official CLI…", preparing: activeHarness === "antigravity" ? "Preparing Google sign-in…" : "Preparing an isolated account profile…", login: "Waiting for official browser sign-in…", saving: "Adding the account connection…" };
  return <Dialog open={open} onOpenChange={close} title={zh ? "添加账号" : "Add account"} description={zh ? "选择官方登录方式" : "Choose an official sign-in"} footer={<Button variant="outline" disabled={stage === "saving"} onClick={() => close(false)}>{stage ? (zh ? "取消登录" : "Cancel sign-in") : (zh ? "关闭" : "Close")}</Button>}>
    <div className="space-y-5">
      {!stage ? <div className="space-y-2">{ACCOUNT_HARNESSES.map((harness) => <button key={harness} type="button" onClick={() => void connect(harness)} className="flex w-full items-center gap-3 rounded-xl border border-line p-4 text-left text-sm font-medium transition-colors hover:bg-hover focus-visible:outline-accent"><ProviderAvatar providerId={harness} /><span className="flex-1">{accountHarnessName(harness)}{harness === "antigravity" && <span className="ml-2 font-normal text-ink-2">Google</span>}</span><ExternalLink className="h-4 w-4" /></button>)}</div> : <div role="status" className="flex items-center gap-3 rounded-xl border border-line p-5 text-sm"><LoaderCircle className="h-5 w-5 animate-spin" />{stages[stage]}</div>}
      {!stage && recoverable.length > 0 && <div className="space-y-2 rounded-xl border border-line p-3"><p className="text-sm font-medium">{zh ? "未完成的登录" : "Unfinished sign-ins"}</p>{recoverable.map((profile) => <div key={profile.profileId} className="flex items-center justify-between gap-3 text-xs"><span>{accountHarnessName(profile.providerId)} · {new Date(profile.createdAt).toLocaleString(locale)}</span><Button variant="outline" size="sm" onClick={() => void connect(profile.providerId as AccountHarness, profile)}>{zh ? "继续" : "Continue"}</Button></div>)}</div>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-xs leading-relaxed text-ink-3">{zh ? "由官方 CLI 打开浏览器并处理授权。登录流程成功结束后账号会自动出现在这里，无需填写目录、API Key 或端点。" : "The official CLI opens your browser and handles authorization. After it finishes successfully, the account appears here automatically. No directory, API key or endpoint is required."}</p>
      {stage === "login" && <p className="text-xs leading-relaxed text-ink-3">{zh ? "若浏览器没有打开，或 CLI 要求终端输入，请取消后检查官方 CLI 安装。Windows 需要原生可执行文件，当前不执行 .cmd/.bat 登录脚本。" : "If the browser does not open or the CLI requires terminal input, cancel and check the CLI installation. Windows requires a native executable; .cmd/.bat login scripts are not executed."}</p>}
      <p className="text-xs leading-relaxed text-ink-3">{zh ? "取消只停止本地等待，不会撤销已完成的服务端授权。未完成账号空间会保留，稍后可在此恢复。列表仅扫描前 128 个账号目录，较多目录时可能不完整。" : "Cancel stops the local wait; it does not revoke server authorization. Unfinished profiles are retained. Recovery scans the first 128 account directories, so large collections may be incomplete."}</p>
      <p className="text-xs leading-relaxed text-ink-2">{zh ? "Antigravity 使用系统凭据库中的官方统一账号，与本机 agy、Antigravity 共享登录；当前仅添加一个 Google 账号连接。Codex 与 Claude Code（claude.ai）仍使用独立账号目录。" : "Antigravity uses the official account in your OS keyring, shared with local agy and Antigravity. One Google account connection is supported. Codex and Claude Code (claude.ai) retain separate account directories."}</p>
    </div>
  </Dialog>;
}
