import { useEffect, useRef, useState } from "react";
import { ChevronDown, Puzzle, RefreshCw, Search } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import type { HarnessPluginAction, HarnessPluginChange, HarnessPluginInventory, HarnessPluginOperation } from "@agenthub/provider-sdk";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";

export function HarnessPluginsPanel({ instanceId, accounts }: { instanceId: string; accounts: RuntimeConnection[] }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState(accounts.length === 1 ? accounts[0]!.id : "");
  const selected = accounts.find(item => item.id === account);
  const [working, setWorking] = useState(false);
  return <section className="harness-config-section">
    <button type="button" className="flex w-full items-center gap-2 text-sm font-medium" aria-expanded={open} disabled={working}
      onClick={() => setOpen(value => !value)}><Puzzle size={15} />{zh ? "原生插件" : "Native plugins"}
      <ChevronDown size={15} className={open ? "ml-auto rotate-180" : "ml-auto"} /></button>
    {open && <div className="mt-3 space-y-3">
      {(accounts.length > 0 || account) && <SelectField aria-label={zh ? "插件配置范围" : "Plugin profile"} disabled={working}
        placeholder={zh ? "请选择配置范围" : "Choose a profile"} value={account ? (selected?.id ?? "") : "__default"}
        options={[{ value: "__default", label: zh ? "CLI 默认配置" : "Default CLI profile" }, ...accounts.map(item => ({ value: item.id, label: item.name }))]}
        onValueChange={value => setAccount(value === "__default" ? "" : value)} />}
      {account && !selected
        ? <p role="status" className="text-sm text-ink-2">{zh ? "原账号已不可用，请重新选择配置范围。" : "This account is unavailable. Choose a profile to continue."}</p>
        : <Inventory key={JSON.stringify([instanceId, selected?.id, selected?.revision])} instanceId={instanceId} connectionId={selected?.id} onWorking={setWorking} />}
    </div>}
  </section>;
}

function Inventory({ instanceId, connectionId, onWorking }: { instanceId: string; connectionId?: string; onWorking: (value: boolean) => void }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [inventory, setInventory] = useState<HarnessPluginInventory>();
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState(true);
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const request = <T,>(operation: HarnessPluginOperation) =>
    requestCore<T>("provider.harnessPlugins", { agentInstanceId: instanceId, connectionId, operation });
  useEffect(() => {
    mounted.current = true;
    let current = true;
    void request<HarnessPluginInventory>({ action: "list" }).then(result => {
      if (current) setInventory(result);
    }).catch(e => { if (current) setError(String(e)); })
      .finally(() => { if (current) setBusy(false); });
    return () => { mounted.current = false; current = false; onWorking(false); };
  }, [instanceId, connectionId, onWorking]);

  const run = async (operation: HarnessPluginOperation): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); onWorking(true); setError(""); setNotice("");
    try {
      if (operation.action !== "list") {
        const result = await request<HarnessPluginChange>(operation);
        if (!mounted.current) return;
        if (result.application === "restart-required") setNotice(zh ? "已保存，下次启动 Harness 时生效。" : "Saved. Restart the harness to apply.");
        if (result.application === "overridden") setNotice(zh ? "已保存，当前配置中有优先级更高的设置。" : "Saved. A higher-priority setting overrides this change.");
        if ("spec" in operation) setSpec("");
      }
      const updated = await request<HarnessPluginInventory>({ action: "list" });
      if (mounted.current) setInventory(updated);
    } catch (e) {
      if (mounted.current) { setError(String(e)); setInventory(undefined); }
    } finally {
      inFlight.current = false;
      if (mounted.current) { setBusy(false); onWorking(false); }
    }
  };
  const labels: Record<HarnessPluginAction, string> = {
    install: zh ? "安装" : "Install", remove: zh ? "卸载" : "Uninstall",
    enable: zh ? "启用" : "Enable", disable: zh ? "停用" : "Disable",
  };
  const items = (inventory?.items ?? []).filter(item => item.installed === installed &&
    [item.name, item.source, item.description].some(text => text?.toLowerCase().includes(query.trim().toLowerCase())));
  return <div className="space-y-3" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label={zh ? "筛选插件" : "Filter plugins"} className="flex gap-1">
        {[true, false].map(value => <Button key={String(value)} size="sm" variant={installed === value ? "subtle" : "ghost"}
          aria-pressed={installed === value} onClick={() => setInstalled(value)}>{value ? (zh ? "已安装" : "Installed") : (zh ? "可安装" : "Available")}</Button>)}
      </div>
      <Button variant="ghost" size="icon" className="ml-auto" disabled={busy} aria-label={zh ? "刷新原生插件" : "Refresh native plugins"}
        onClick={() => { void run({ action: "list" }); }}><RefreshCw size={14} className={busy ? "animate-spin" : ""} /></Button>
    </div>
    {inventory && <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" /><Input className="pl-9" value={query}
      placeholder={zh ? "搜索插件" : "Search plugins"} aria-label={zh ? "搜索插件" : "Search plugins"} onChange={e => setQuery(e.target.value)} /></div>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-ink-2">{notice}</p>}
    {!inventory && busy && <p role="status" className="text-sm text-ink-2">{zh ? "正在读取插件…" : "Loading plugins…"}</p>}
    {inventory && <ul className="max-h-72 overflow-y-auto divide-y divide-line">
      {items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0 flex-1"><p className="truncate text-sm" title={item.name}>{item.name}</p>
          <p className="truncate text-xs text-ink-3" title={item.description ?? undefined}>{[item.source, item.version, item.installed && item.enabled === false ? (zh ? "已停用" : "Disabled") : null].filter(Boolean).join(" · ")}</p></div>
        {item.actions.map(action => <Button key={action} variant="ghost" size="sm" disabled={busy} aria-label={labels[action] + " " + item.name}
          onClick={() => { void run({ action, id: item.id }); }}>{labels[action]}</Button>)}
      </li>)}
    </ul>}
    {inventory && !items.length && <p className="text-sm text-ink-3">{query ? (zh ? "未找到匹配的插件" : "No matching plugins") : installed ? (zh ? "暂无已安装插件" : "No installed plugins") : (zh ? "暂无可安装插件" : "No available plugins")}</p>}
    {inventory?.installBySpec && !installed && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (spec.trim() && !busy) void run({ action: "install", spec: spec.trim() }); }}>
      <Input value={spec} onChange={e => setSpec(e.target.value)} aria-label={zh ? "插件包名或来源" : "Plugin package or source"} placeholder={zh ? "插件包名或来源" : "Plugin package or source"} />
      <Button type="submit" variant="subtle" disabled={!spec.trim() || busy}>{labels.install}</Button>
    </form>}
  </div>;
}
