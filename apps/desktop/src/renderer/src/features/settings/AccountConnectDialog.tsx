import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, UserRound } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { connectOfficialAccount, type AccountHarness, type ConnectStage } from "./account-connect";

type RecoverableProfile = { profileId: string; providerId: string; directory: string; createdAt: number };

export function AccountConnectDialog({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange(open: boolean): void; onConnected(connection: RuntimeConnection): void }): JSX.Element {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [recoverable, setRecoverable] = useState<RecoverableProfile[]>([]);
  const [stage, setStage] = useState<ConnectStage>(); const [error, setError] = useState("");
  const controller = useRef<AbortController>(); const generation = useRef(0);
  const loadRecoverable = async (): Promise<void> => {
    const request = generation.current;
    try {
      const profiles = await getBridge()?.accounts.recoverableLogins?.() ?? [];
      const saved = new Set(useConnectionsStore.getState().connections.map((connection) => connection.id));
      if (request === generation.current) setRecoverable(profiles.filter((profile) => !saved.has(profile.profileId) && ["codex", "claude-code"].includes(profile.providerId)));
    } catch { if (request === generation.current) setError(zh ? "无法读取未完成的登录记录，请稍后重试。" : "Could not read unfinished login records. Try again later."); }
  };
  useEffect(() => {
    generation.current++; setStage(undefined); setError(""); setRecoverable([]);
    if (open) void loadRecoverable();
    return () => { generation.current++; controller.current?.abort(); };
  }, [open]);
  const close = (value: boolean): void => { if (stage === "saving") return; if (!value) controller.current?.abort(); onOpenChange(value); };
  const connect = async (harness: AccountHarness, recovered?: RecoverableProfile): Promise<void> => {
    if (controller.current && !controller.current.signal.aborted) return;
    const accounts = getBridge()?.accounts;
    if (!accounts?.prepareLogin) { setError(zh ? "请在支持账号登录的桌面版本中使用此功能。" : "Use a desktop build that supports account login."); return; }
    const request = ++generation.current, abort = new AbortController(); controller.current = abort; setError("");
    const provider = harness === "codex" ? "Codex" : "Claude Code";
    const count = useConnectionsStore.getState().connections.filter((item) => item.kind === "login" && item.harness === harness).length + 1;
    try {
      const result = await connectOfficialAccount(harness, `${provider} ${zh ? "账号" : "account"} ${count}`, abort.signal, (next) => { if (request === generation.current) setStage(next); }, {
        detect: async (id) => {
          await useAgentsStore.getState().redetect(id);
          const installation = useAgentsStore.getState().installations.find((item) => item.providerId === id);
          if (installation?.status !== "ready" || !installation.executable) throw new Error(zh ? `未找到可用的 ${provider} 官方 CLI。请先安装或在 Agent 设置中修复检测，再重试。` : `A working ${provider} CLI was not found. Install it or repair detection in Agent settings, then retry.`);
          return installation.executable;
        },
        reusePrepared: !!recovered,
        prepare: recovered ? async () => recovered : accounts.prepareLogin,
        acknowledge: (profileId, providerId) => accounts.acknowledgeLogin?.({ profileId, providerId }) ?? Promise.resolve(),
        start: accounts.startLogin, status: accounts.loginStatus, cancel: accounts.cancelLogin,
        save: (connection) => useConnectionsStore.getState().save(connection)
      });
      if (request === generation.current && !abort.signal.aborted) { setStage(undefined); onConnected(result); onOpenChange(false); }
    } catch (cause) {
      if (request === generation.current && !abort.signal.aborted) { setStage(undefined); setError(`${cause instanceof Error ? cause.message : String(cause)} ${zh ? "已生成的账号空间会保留，可从未完成登录记录恢复。" : "Prepared account profiles are retained and can be recovered below."}`); void loadRecoverable(); }
    } finally { if (controller.current === abort) controller.current = undefined; }
  };
  const stages = zh ? { detecting: "检查官方 CLI…", preparing: "准备独立账号空间…", login: "等待官方浏览器登录完成…", saving: "添加账号连接…" } : { detecting: "Checking the official CLI…", preparing: "Preparing an isolated account profile…", login: "Waiting for official browser sign-in…", saving: "Adding the account connection…" };
  return <Dialog open={open} onOpenChange={close} title={zh ? "添加账号" : "Add account"} description={zh ? "选择账号类型后开始官方登录。应用会自动管理独立目录。" : "Choose an account type to start official sign-in. The app manages its isolated directory."} footer={<Button variant="outline" disabled={stage === "saving"} onClick={() => close(false)}>{stage ? (zh ? "取消登录" : "Cancel sign-in") : (zh ? "关闭" : "Close")}</Button>}>
    <div className="space-y-5">
      {!stage ? <div className="grid grid-cols-2 gap-3">{(["codex", "claude-code"] as const).map((harness) => <button key={harness} type="button" onClick={() => void connect(harness)} className="flex flex-col items-center gap-3 rounded-xl border border-line p-5 text-sm font-medium hover:bg-hover focus-visible:outline-accent"><UserRound className="h-6 w-6 text-ink-2" />{harness === "codex" ? "Codex" : "Claude Code"}<span className="flex items-center gap-1 text-xs font-normal text-ink-3">{zh ? "打开官方登录" : "Open official sign-in"}<ExternalLink className="h-3 w-3" /></span></button>)}</div> : <div role="status" className="flex items-center gap-3 rounded-xl border border-line p-5 text-sm"><LoaderCircle className="h-5 w-5 animate-spin" />{stages[stage]}</div>}
      {!stage && recoverable.length > 0 && <div className="space-y-2 rounded-xl border border-line p-3"><p className="text-sm font-medium">{zh ? "未完成的登录" : "Unfinished sign-ins"}</p><p className="text-xs text-ink-3">{zh ? "取消或保存失败后，独立账号空间仍保留。继续会复用原目录，不会创建重复账号；进程未退出时不会启动另一登录。" : "Cancelled sign-ins and failed saves retain their isolated profiles. Continue reuses that profile and waits for any active process."}</p>{recoverable.map((profile) => <div key={profile.profileId} className="flex items-center justify-between gap-3 text-xs"><span>{profile.providerId === "codex" ? "Codex" : "Claude Code"} · {new Date(profile.createdAt).toLocaleString(locale)}</span><Button variant="outline" size="sm" onClick={() => void connect(profile.providerId as AccountHarness, profile)}>{zh ? "继续" : "Continue"}</Button></div>)}</div>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-xs leading-relaxed text-ink-3">{zh ? "由官方 CLI 打开浏览器并处理授权。登录流程成功结束后账号会自动出现在这里，无需填写目录、API Key 或端点。" : "The official CLI opens your browser and handles authorization. After it finishes successfully, the account appears here automatically. No directory, API key or endpoint is required."}</p>
      {stage === "login" && <p className="text-xs leading-relaxed text-ink-3">{zh ? "若浏览器没有打开，或 CLI 要求终端输入，请取消后检查官方 CLI 安装。Windows 需要原生可执行文件，当前不执行 .cmd/.bat 登录脚本。" : "If the browser does not open or the CLI requires terminal input, cancel and check the CLI installation. Windows requires a native executable; .cmd/.bat login scripts are not executed."}</p>}
      <p className="text-xs leading-relaxed text-ink-3">{zh ? "取消只停止本地等待，不会撤销已完成的服务端授权。未完成账号空间会保留，稍后可在此恢复。列表仅扫描前 128 个账号目录，较多目录时可能不完整。" : "Cancel stops the local wait; it does not revoke server authorization. Unfinished profiles are retained. Recovery scans the first 128 account directories, so large collections may be incomplete."}</p>
      <p className="text-xs leading-relaxed text-ink-3">{zh ? "Codex 与 Claude Code（claude.ai）账号分别隔离。其他 harness 暂不支持此登录入口；Claude Console 无 API Key 的登录不能用目录隔离。" : "Codex and Claude Code (claude.ai) profiles are isolated. Other harnesses are not supported here. Claude Console sign-ins without API keys cannot be isolated by directory."}</p>
    </div>
  </Dialog>;
}
