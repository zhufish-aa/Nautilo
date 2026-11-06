import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { ENV_POLICIES, permissionModesFor, useProviderMetas } from "../../lib/provider-catalog";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { toast } from "../../stores/toast";
import { ProviderCard } from "./ProvidersPanel";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";

export function HarnessPanel(): JSX.Element {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const providers = useProviderMetas();
  const { instances, installations, detecting, ensureHarness, updateInstance, redetect } = useAgentsStore();
  const { connections, hydrate: hydrateConnections } = useConnectionsStore();
  useEffect(() => { void hydrateConnections(); }, [hydrateConnections]);
  const imageAccounts = connections.filter(connection => connection.enabled && connection.kind === "login" && connection.harness === "codex");
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "ready" | "missing">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const selected = providers.find((item) => item.id === selectedId);
  const profile = instances.find((item) => item.configurationKind === "harness" && item.providerId === selected?.id);
  const installation = installations.find((item) => item.providerId === selected?.id);
  const [form, setForm] = useState({ executable: "", permissionMode: "", envPolicyId: "env-standard", poolSize: "", imageAccount: "", enabled: true });
  useEffect(() => {
    if (!selected || profile || installation?.status !== "ready") return;
    void ensureHarness(selected.id).catch((cause) => setError(String(cause)));
  }, [selected?.id, profile?.id, installation?.status, ensureHarness]);
  useEffect(() => {
    setForm({ executable: profile?.executable ?? installation?.executable ?? "", permissionMode: profile?.permissionMode ?? permissionModesFor(selected?.id ?? "")[0]?.value ?? "",
      envPolicyId: profile?.envPolicyId ?? "env-standard", poolSize: profile?.appServerPoolSize?.toString() ?? "", imageAccount: profile?.imageGenerationConnectionId ?? "", enabled: profile?.enabled ?? true });
    setDirty(false); setError("");
  }, [selected?.id, profile?.updatedAt, installation?.executable]);
  const patch = (value: Partial<typeof form>): void => { setForm((current) => ({ ...current, ...value })); setDirty(true); };
  const save = async (): Promise<void> => {
    if (!selected || busy) return;
    if (!form.executable.trim()) { setError(zh ? "请填写可执行文件" : "Enter an executable"); return; }
    const poolSize = form.poolSize.trim() ? Number(form.poolSize) : undefined;
    if (poolSize !== undefined && (!Number.isSafeInteger(poolSize) || poolSize < 1)) { setError(zh ? "并发上限需要正整数" : "Use a positive integer for concurrency"); return; }
    setBusy(true); setError("");
    try {
      const current = profile ?? await ensureHarness(selected.id, form.executable.trim());
      const { id, status: _status, createdAt: _created, updatedAt: _updated, ...draft } = current;
      await updateInstance(id, { ...draft, executable: form.executable.trim(), permissionMode: form.permissionMode || undefined,
        envPolicyId: form.envPolicyId, appServerPoolSize: selected.id === "codex" ? poolSize : undefined,
        imageGenerationConnectionId: selected.id === "codex" ? form.imageAccount || undefined : undefined, enabled: form.enabled });
      await redetect(selected.id);
      setDirty(false); toast.success(zh ? "Harness 已保存" : "Harness saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const readyCount = providers.filter((item) => installations.some((candidate) => candidate.providerId === item.id && candidate.status === "ready")).length;
  const visible = providers.filter((item) => {
    const ready = installations.some((candidate) => candidate.providerId === item.id && candidate.status === "ready");
    return `${item.name} ${item.id} ${item.vendor}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (filter === "all" || (filter === "ready" ? ready : !ready));
  });
  const closeEditor = (): void => {
    if (busy) return;
    setSelectedId("");
    setDirty(false);
    setError("");
  };
  return <div className="harness-panel harness-overview">
    <div className="harness-overview-toolbar"><nav className="harness-overview-filters" aria-label={zh ? "筛选 Harness" : "Filter harnesses"}>{(["all", "ready", "missing"] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? (zh ? "全部工具" : "All tools") : value === "ready" ? (zh ? "已就绪" : "Ready") : (zh ? "待检测" : "Not detected")}<span>{value === "all" ? providers.length : value === "ready" ? readyCount : providers.length - readyCount}</span></button>)}</nav><label className="harness-overview-search"><Search size={15} aria-hidden /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索 Harness" : "Search harnesses"} aria-label={zh ? "搜索 Harness" : "Search harnesses"} />{query && <button type="button" aria-label={zh ? "清除搜索" : "Clear search"} onClick={() => setQuery("")}><X size={14} /></button>}</label></div>
    <div className="harness-overview-body"><div className="harness-card-grid">{visible.map((item) => {
      const installed = installations.find((candidate) => candidate.providerId === item.id);
      const configured = instances.find((candidate) => candidate.configurationKind === "harness" && candidate.providerId === item.id);
      const ready = installed?.status === "ready";
      return <article className="harness-tool-card" key={item.id}>
        <header><ProviderAvatar providerId={item.id} /><div className="harness-tool-identity"><h3>{item.name}</h3><p>{item.vendor}</p></div></header>
        <div className="harness-tool-version" title={installed?.version}>{installed?.version || "—"}</div>
        <footer><span className="harness-tool-status" data-ready={ready && configured?.enabled !== false}><i aria-hidden />{configured?.enabled === false ? (zh ? "已停用" : "Disabled") : ready ? (zh ? "已安装" : "Installed") : (zh ? "待检测" : "Not detected")}</span><Button variant="ghost" size="sm" onClick={() => { setError(""); setSelectedId(item.id); }}><SlidersHorizontal size={14} aria-hidden />{zh ? "配置" : "Configure"}</Button></footer>
      </article>;
    })}</div>{!visible.length && <EmptyState icon={Search} title={zh ? "没有找到匹配的工具" : "No matching tools"} description={zh ? "试试其他关键词，或切换上方的筛选。" : "Try another search or change the filter above."} />}</div>
    <Dialog open={!!selected} onOpenChange={(open) => { if (open || busy) return; if (dirty) { setError(zh ? "更改尚未保存，请保存或点击“取消”放弃。" : "Save your changes or choose Cancel to discard them."); return; } closeEditor(); }} title={zh ? "Harness 运行配置" : "Harness runtime settings"} widthClass="max-w-[680px]" footer={<>{dirty && <span className="harness-dialog-save-state">{zh ? "有未保存的更改" : "Unsaved changes"}</span>}<Button variant="ghost" size="sm" disabled={busy} onClick={closeEditor}>{dirty ? t("common.cancel") : (zh ? "完成" : "Done")}</Button><Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void save()}>{busy && <LoaderCircle size={14} className="animate-spin" />}{zh ? "保存配置" : "Save changes"}</Button></>}>
      {selected && <div className="harness-detail harness-config-editor">
        <header className="harness-profile-header"><ProviderAvatar providerId={selected.id} size="lg" /><div className="harness-profile-copy"><div className="harness-profile-title"><h3>{selected.name}</h3><span className="runtime-status" data-ready={installation?.status === "ready"}>{installation?.status === "ready" ? (zh ? "已安装" : "Installed") : (zh ? "待检测" : "Not detected")}</span></div><p>{selected.vendor}</p><span className="harness-version">{installation?.version || (zh ? "版本未知" : "Version unknown")}</span></div><div className="harness-profile-maintenance">{installation ? <ProviderCard key={installation.providerId} installation={installation} actionsOnly /> : <Button disabled={busy || detecting[selected.id]} onClick={() => void redetect(selected.id)}><RefreshCw size={14} className={detecting[selected.id] ? "animate-spin" : ""} />{zh ? "检测 CLI" : "Detect CLI"}</Button>}</div></header>
        <div className="harness-enabled-row"><strong>{zh ? "启用此 Harness" : "Enable this harness"}</strong><Switch checked={form.enabled} onCheckedChange={(enabled) => patch({ enabled })} aria-label={zh ? "启用 Harness" : "Enable harness"} /></div>
        <section className="harness-config-section"><div className="harness-section-heading"><h4>{zh ? "运行配置" : "Runtime settings"}</h4></div>
        <Field label={zh ? "可执行文件" : "Executable"}><Input value={form.executable} onChange={(event) => patch({ executable: event.target.value })} aria-label={zh ? "可执行文件" : "Executable"} spellCheck={false} /></Field>
        <div className="harness-form-grid">
        <Field label={zh ? "默认权限" : "Default permissions"}><SelectField value={form.permissionMode || undefined} disabled={!permissionModesFor(selected.id).length} onValueChange={(permissionMode) => patch({ permissionMode })} options={permissionModesFor(selected.id).map((mode) => ({ value: mode.value, label: mode.name[locale], hint: mode.description[locale] }))} /></Field>
        <Field label={zh ? "环境变量策略" : "Environment policy"}><SelectField value={form.envPolicyId} onValueChange={(envPolicyId) => patch({ envPolicyId })} options={ENV_POLICIES.map((policy) => ({ value: policy.id, label: t(policy.nameKey as MessageKey) }))} /></Field>
        </div></section>
        {selected.id === "codex" && <section className="harness-config-section"><div className="harness-section-heading"><h4>{zh ? "并发与图片生成" : "Concurrency & images"}</h4></div>
        {selected.id === "codex" && <Field label={zh ? "并发进程上限" : "Concurrent process limit"}><Input type="number" min={1} value={form.poolSize} onChange={(event) => patch({ poolSize: event.target.value })} placeholder={zh ? "自动" : "Automatic"} /></Field>}
        {selected.id === "codex" && <Field label={zh ? "图片生成账号" : "Image generation account"}>
          <SelectField value={form.imageAccount || "__auto"} onValueChange={(value) => patch({ imageAccount: value === "__auto" ? "" : value })}
            options={[{ value: "__auto", label: zh ? "自动选择 Codex 登录账号" : "Automatically choose a Codex account" },
              ...imageAccounts.map(account => ({ value: account.id, label: account.name })),
              { value: "off", label: zh ? "不启用图片生成" : "Disable image generation" }]} />
          <p className="mt-2 text-xs leading-5 text-ink-2">{zh ? "图片使用此官方账号，聊天使用会话模型。" : "Images use this account; chat uses the session model."}</p>
        </Field>}
        </section>}
        {installation?.status !== "ready" && <p className="text-sm text-ink-3">{installation?.message || (zh ? "安装对应 CLI 后点击检测。" : "Install the CLI, then detect it.")}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>}
    </Dialog>
  </div>;
}
