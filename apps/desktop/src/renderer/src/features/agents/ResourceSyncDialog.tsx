import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import type { ManagedResource, ResourceConflictResolution } from "@agenthub/schemas";
import { ArrowRight, Check, FileCode2, FolderSync, History, RefreshCw, RotateCcw, Server } from "lucide-react";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { SelectField } from "../../components/ui/Select";
import { useI18n } from "../../lib/i18n";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";
import { useResourceSync } from "./resource-sync/useResourceSync";
import "./resource-sync.css";

export function ResourceSyncDialog({ open, onOpenChange, kind }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "mcp" | "skill";
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const {
    inventory, selected, setSelected, targetId, setTarget, resolution,
    setResolution, plan, history, tab, setTab, busy, error, target, load,
    invalidate, action,
  } = useResourceSync(open, kind);
  const planRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open && tab === "sync" && plan) planRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, tab, plan?.id]);

  const ops = zh
    ? { create: "新增", update: "更新", unchanged: "一致", keep: "保留原配置", rename: "另存名称" }
    : { create: "Create", update: "Update", unchanged: "Identical", keep: "Keep native", rename: "Rename" };
  const sources = new Map<string, ManagedResource[]>();
  for (const resource of inventory?.resources ?? []) {
    if (resource.kind !== kind) continue;
    const value = resource.source?.trim() ?? "";
    const key = !value || /^[-–—]+$/.test(value) ? "unknown" : value;
    const group = sources.get(key);
    if (group) group.push(resource);
    else sources.set(key, [resource]);
  }
  const sourceLabel = (value: string): string => {
    switch (value) {
      case "unknown": return zh ? "来源未记录" : "Source not recorded";
      case "builtin": return zh ? "Nautilo 内置" : "Built-in";
      case "local":
      case "native": return zh ? "本机导入" : "Imported locally";
      case "plugin": return zh ? "来自插件" : "From plugins";
      case "custom": return zh ? "手动创建" : "Created manually";
      default: return value;
    }
  };
  const planState = (state: NonNullable<typeof plan>["state"]): string => ({
    conflict: zh ? "原生配置已变化 · 请重新预览" : "Native files changed · Preview again",
    applied: zh ? "已应用" : "Applied",
    undone: zh ? "已撤销" : "Undone",
    preview: zh ? "尚未写入" : "Not yet applied",
  })[state];

  const chosen = new Set(selected);
  const setGroup = (resources: ManagedResource[]): void => {
    const ids = new Set(resources.map(resource => resource.id));
    const allSelected = resources.every(resource => chosen.has(resource.id));
    setSelected(current => allSelected ? current.filter(id => !ids.has(id)) : [...new Set([...current, ...ids])]);
    invalidate();
  };
  const toggleResource = (id: string, checked: boolean): void => {
    setSelected(current => checked ? [...current, id] : current.filter(item => item !== id));
    invalidate();
  };

  const invocation = kind === "mcp" && target && !target.mcpPath;
  const targets = (inventory?.targets ?? []).filter(item => kind === "mcp" || Boolean(item.skillDirectory));
  const targetPath = kind === "skill" ? target?.skillDirectory : target?.mcpPath;
  const unchanged = (plan?.changes ?? []).filter(change => ["unchanged", "keep"].includes(change.operation) && !change.conflict);
  const changed = (plan?.changes ?? []).filter(change => change.conflict || !["unchanged", "keep"].includes(change.operation));
  const previewIds = selected.length || plan?.state !== "conflict" ? selected : [...new Set(plan.changes.map(change => change.resourceId))];
  const preview = (): void => { void action("resource.preview", { targetId, capabilityIds: previewIds, resolution }); };
  const refreshLabel = busy ? (zh ? "处理中" : "Working") : (zh ? "刷新" : "Refresh");

  return (
    <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}
      title={zh ? "原生资源同步" : "Native resource sync"} widthClass="resource-sync-dialog"
      footer={tab === "sync" && !invocation ? <>
        <div className="resource-sync-options">
          <span>{zh ? "同名冲突" : "Name conflicts"}</span>
          <SelectField value={resolution} onValueChange={value => { setResolution(value as ResourceConflictResolution); invalidate(); }}
            disabled={busy} aria-label={zh ? "同名冲突" : "Name conflicts"} options={[
              { value: "keep", label: zh ? "保留原配置" : "Keep native" },
              { value: "replace", label: zh ? "替换所选条目" : "Replace selected entries" },
              { value: "rename", label: zh ? "另存名称" : "Use another name" },
            ]} />
        </div>
        <div className="resource-sync-actions">
          <Button variant="outline" size="sm" disabled={busy || !targetPath || !previewIds.length} onClick={preview}>
            {plan?.state === "conflict" ? (zh ? "重新预览" : "Preview again") : (zh ? "预览差异" : "Preview changes")}
          </Button>
          {plan?.state === "preview" && <Button variant="primary" size="sm"
            disabled={busy || !plan.changes.some(change => !["keep", "unchanged"].includes(change.operation))}
            onClick={() => void action("resource.apply", { planId: plan.id })}>
            <Check size={15} aria-hidden />{zh ? "应用同步" : "Apply sync"}
          </Button>}
          {plan?.state === "applied" && <Button variant="outline" size="sm" disabled={busy}
            onClick={() => void action("resource.undo", { planId: plan.id })}>
            <RotateCcw size={14} aria-hidden />{zh ? "撤销这次同步" : "Undo this sync"}
          </Button>}
        </div>
      </> : undefined}>
      <div className="resource-sync-toolbar">
        <div className="capability-underline-tabs" role="tablist" aria-label={zh ? "原生资源同步" : "Native resource sync"}>
          {([["sync", zh ? "同步资源" : "Sync", FolderSync], ["history", zh ? "同步记录" : "History", History]] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              <Icon size={14} aria-hidden />{label}
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => void load()}
          aria-label={refreshLabel} title={refreshLabel} aria-busy={busy}>
          <RefreshCw size={15} aria-hidden />
        </Button>
      </div>

      {tab === "sync" && <div className="resource-sync-target">
        <span>{zh ? "同步至" : "Sync to"}</span>
        <div className="resource-sync-target-select" data-has-mark={Boolean(target)}>
          {target && <ProviderAvatar providerId={target.providerId} size="sm" />}
          <SelectField value={targetId} onValueChange={id => { setTarget(id); invalidate(); }}
            disabled={busy} options={targets.map(item => ({ value: item.id, label: item.label }))}
            placeholder={zh ? "选择目标" : "Choose a target"} aria-label={zh ? "目标 Harness 或账号" : "Target harness or account"} />
        </div>
        {targetPath && <>
          <ArrowRight size={15} aria-hidden />
          <code className="resource-sync-path" title={targetPath}><bdi dir="ltr">{targetPath}</bdi></code>
        </>}
        {invocation && <span className="resource-sync-invocation-label">{zh ? "随原生会话传入" : "Merged at invocation"}</span>}
      </div>}

      <div className="resource-sync-content" role="tabpanel" aria-label={tab === "sync" ? (zh ? "同步资源" : "Sync resources") : (zh ? "同步记录" : "Sync history")}>
        {error && <p className="resource-sync-error" role="alert">{error}</p>}
        {tab === "sync" ? invocation ? <div className="resource-sync-invocation">
          <Server size={20} aria-hidden />
          <strong>{target.label}</strong>
          <p>{zh ? "此 Harness 会在原生会话中接收已启用的 MCP 服务。" : "This harness receives enabled MCP services in its native session."}</p>
        </div> : <>
          <div className="resource-sync-resources">
            {[...sources].map(([source, resources]) => <section className="resource-sync-source" key={source}>
              <header>
                <h3>{sourceLabel(source)}<span>{resources.length}</span></h3>
                <button type="button" disabled={busy}
                  aria-pressed={resources.every(resource => chosen.has(resource.id))} onClick={() => setGroup(resources)}>
                  {resources.every(resource => chosen.has(resource.id)) ? (zh ? "取消本组" : "Clear group") : (zh ? "全选本组" : "Select group")}
                </button>
              </header>
              {resources.map(resource => <label key={resource.id}>
                <input type="checkbox" checked={chosen.has(resource.id)} disabled={busy}
                  aria-label={resource.name} onChange={event => toggleResource(resource.id, event.target.checked)} />
                <span className="resource-sync-resource-copy">
                  <strong title={resource.name}>{resource.name}</strong>
                  {resource.sourcePath && <code title={resource.sourcePath}>{resource.sourcePath}</code>}
                </span>
                <span className="resource-sync-owner" title={resource.providerIds.join(" · ") || undefined}>
                  {resource.providerIds.length ? resource.providerIds.map(id => <code key={id}>{id}</code>)
                    : <span>{zh ? "全部 Harness" : "All harnesses"}</span>}
                </span>
              </label>)}
            </section>)}
            {inventory && sources.size === 0 && <p className="resource-sync-empty">{zh ? "没有可同步的资源" : "No resources to sync"}</p>}
          </div>
          <AnimatePresence initial={false}>
            {plan && <motion.section ref={planRef} className="resource-sync-plan" key={plan.id}
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.2, ease: UI_EASE_OUT }}>
              <header className="resource-sync-plan-heading">
                <h3>{zh ? "同步计划" : "Sync plan"}</h3><span>{planState(plan.state)}</span>
              </header>
              {changed.map((change, index) => <div className="resource-sync-change" key={`${change.path}:${index}`}>
                <FileCode2 size={15} aria-hidden />
                <div>
                  <strong>{change.name}</strong>
                  <code title={change.path}>{change.path}</code>
                  {change.before !== undefined && change.after !== undefined && change.operation !== "unchanged" && <details>
                    <summary>{zh ? "查看条目差异" : "View entry changes"}</summary>
                    <pre>− {change.before || "—"}{"\n"}+ {change.after}</pre>
                  </details>}
                </div>
                <span data-conflict={change.conflict}>{ops[change.operation]}</span>
              </div>)}
              {unchanged.length > 0 && <details className="resource-sync-identical">
                <summary>{zh ? "未更改" : "Unchanged"} · {unchanged.length}</summary>
                {unchanged.map(change => <p key={`${change.path}:${change.resourceId}`} title={change.path}>{change.name} · {ops[change.operation]}</p>)}
              </details>}
            </motion.section>}
          </AnimatePresence>
        </> : <div className="resource-sync-history">
          {history.map(entry => <div key={entry.id}>
            <History size={15} aria-hidden />
            <div>
              <strong>{inventory?.targets.find(item => item.id === entry.targetId)?.label ?? entry.targetId}</strong>
              <span>{new Date(entry.createdAt).toLocaleString(locale)} · {entry.changes.filter(change => !["keep", "unchanged"].includes(change.operation)).length} {zh ? "项更改" : "changes"}</span>
            </div>
            <span>{entry.state === "preview" ? (zh ? "预览" : "Preview") : planState(entry.state)}</span>
            {entry.state === "applied" && <Button variant="outline" size="sm" disabled={busy}
              onClick={() => void action("resource.undo", { planId: entry.id })}>
              <RotateCcw size={14} aria-hidden />{zh ? "撤销" : "Undo"}
            </Button>}
          </div>)}
          {!history.length && <p className="resource-sync-empty">{zh ? "还没有同步记录" : "No sync history"}</p>}
        </div>}
      </div>
    </Dialog>
  );
}
