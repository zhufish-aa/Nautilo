import { useEffect, useState } from "react";
import { Check, Copy, FolderOpen, Pencil, Trash2 } from "lucide-react";
import type { ProviderCapability } from "@agenthub/domain";
import { getBridge } from "../../lib/bridge";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { capabilityDescription, capabilityOrigin } from "../../lib/capability-origin";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { useI18n } from "../../lib/i18n";
import type { ProviderMeta } from "../../lib/types";
import { toast } from "../../stores/toast";
import { MarkdownContent } from "../timeline/MarkdownContent";

const absolutePath = /^(?:[a-z]:[/\\]|\\\\|\/)/i;

export function SkillDetails({ capability, sourceLabel, ready, providers, busy, onEdit, onDelete, onSet }: {
  capability: ProviderCapability;
  sourceLabel: string;
  ready: ProviderMeta[];
  providers: ProviderMeta[];
  busy: boolean;
  onEdit: (focusDescription?: boolean) => void;
  onDelete: () => void;
  onSet: (providers: string[], enabled: boolean) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const [copied, setCopied] = useState<"name" | "path" | "content">();
  const [source, setSource] = useState(false);
  const description = capabilityDescription(capability);
  const origin = capabilityOrigin(capability);
  const directory = capability.skill?.resourceDir;
  const path = origin.path || directory;
  const instructions = capability.skill?.instructions ?? "";
  const lines = instructions ? instructions.split(/\r?\n/).length : 0;
  const active = [...new Set(capability.enabled ? capability.providerIds : [])];
  const readyIds = ready.map(provider => toDaemonProviderId(provider.id));
  const known = new Set([...providers.map(provider => toDaemonProviderId(provider.id)), ...active]);
  const tags = new Map<string, string>();
  for (const tag of capability.tags) {
    const value = tag.trim();
    if (value && !tags.has(value.toLocaleLowerCase())) tags.set(value.toLocaleLowerCase(), value);
  }
  const shell = getBridge()?.shell;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy(target: "name" | "path" | "content", value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function openFolder(file: string): Promise<void> {
    if (!shell) return;
    try {
      if (directory && absolutePath.test(directory)) {
        const error = await shell.openPath(directory);
        if (error) toast.error(error);
      } else {
        await shell.showItemInFolder(file);
      }
    } catch (error) {
      toast.error(String(error));
    }
  }

  const label = (target: typeof copied, name: string) => copied === target ? (zh ? "已复制" : "Copied") : name;
  const copyName = label("name", zh ? "复制名称" : "Copy name");
  const copyPath = label("path", zh ? "复制路径" : "Copy path");
  const copyContent = label("content", zh ? "复制全文" : "Copy content");
  const openLabel = zh ? "打开目录" : "Open folder";
  const removeLabel = zh ? "移除" : "Remove";
  const originHint = origin.label && origin.kind !== "builtin"
    && origin.label.trim().toLocaleLowerCase() !== capability.name.trim().toLocaleLowerCase()
    ? sourceLabel + " · " + origin.label : sourceLabel;

  return <article className="skill-inspector">
    <section className="skill-inspector-identity">
      <div className="skill-inspector-heading">
        <div>
          <h2 title={capability.name}>{capability.name}</h2>
          <span className="skill-origin-tag" title={originHint}>{originHint}</span>
        </div>
        <div className="skill-inspector-actions">
          <button type="button" disabled={busy} onClick={() => onEdit()}><Pencil size={13} />{zh ? "编辑" : "Edit"}</button>
          <button type="button" title={copyName} aria-label={copyName} data-copied={copied === "name"} onClick={() => void copy("name", capability.name)}>
            {copied === "name" ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button type="button" className="skill-inspector-remove" disabled={busy} title={removeLabel} aria-label={removeLabel} onClick={onDelete}><Trash2 size={14} /></button>
        </div>
      </div>
      {description ? <p className="skill-inspector-description">{description}</p> : <div className="skill-description-alert">
        <span>{zh ? "缺少触发说明，Agent 更难自动找到此技能" : "A missing description makes this skill harder for agents to discover."}</span>
        <button type="button" disabled={busy} onClick={() => onEdit(true)}>{zh ? "去补充" : "Add description"}</button>
      </div>}
      {path && <div className="skill-inspector-path">
        <code title={path}>{path}</code>
        <button type="button" title={copyPath} aria-label={copyPath} data-copied={copied === "path"} onClick={() => void copy("path", path)}>
          {copied === "path" ? <Check size={13} /> : <Copy size={13} />}
        </button>
        {shell && absolutePath.test(path) && <button type="button" title={openLabel} aria-label={openLabel} onClick={() => void openFolder(path)}><FolderOpen size={14} /></button>}
      </div>}
      {!!tags.size && <div className="skill-inspector-tags" aria-label={zh ? "标签" : "Tags"}>
        {[...tags].map(([key, tag]) => <span key={key}>{tag}</span>)}
      </div>}
    </section>
    <section className="skill-inspector-scope">
      <div className="skill-inspector-section-heading">
        <h3>{zh ? "启用范围" : "Enabled for"} <span>{active.length} / {known.size} Harness</span></h3>
        <div>
          <button type="button" disabled={busy || !readyIds.some(id => !active.includes(id))} onClick={() => onSet(readyIds, true)}>{zh ? "全选就绪" : "Enable all ready"}</button>
          <button type="button" disabled={busy || !active.length} onClick={() => onSet(active, false)}>{zh ? "全关" : "Disable all"}</button>
        </div>
      </div>
      {ready.length ? <div className="skill-harness-chips">
        {ready.map(provider => <button type="button" key={provider.id} disabled={busy}
          aria-pressed={capabilityEnabledFor(capability, toDaemonProviderId(provider.id))}
          onClick={() => {
            const id = toDaemonProviderId(provider.id);
            onSet([id], !capabilityEnabledFor(capability, id));
          }}><i aria-hidden />{provider.name}</button>)}
      </div> : <p className="skill-inspector-muted">{zh ? "暂无已就绪的 Harness" : "No ready Harnesses"}</p>}
      {active.some(id => !readyIds.includes(id)) && <p className="skill-inspector-muted">
        {zh ? "已启用但未就绪" : "Enabled but unavailable"} · {active.filter(id => !readyIds.includes(id))
          .map(id => providers.find(provider => toDaemonProviderId(provider.id) === id)?.name ?? id).join(" · ")}
      </p>}
    </section>
    <section className="skill-inspector-reader">
      <div className="skill-reader-box">
        <div className="skill-reader-heading">
          <strong>SKILL.md</strong>
          <small title={zh ? instructions.length + " 字符" : instructions.length + " characters"}>
            {lines} {zh ? "行" : "lines"} · {instructions.length} {zh ? "字符" : "chars"}
          </small>
          <div className="skill-mode skill-reader-mode" data-matrix={source} role="group" aria-label={zh ? "正文视图" : "Content view"}>
            <span aria-hidden />
            <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>{zh ? "预览" : "Preview"}</button>
            <button type="button" aria-pressed={source} onClick={() => setSource(true)}>{zh ? "源码" : "Source"}</button>
          </div>
          <button type="button" title={copyContent} aria-label={copyContent} disabled={!instructions} data-copied={copied === "content"} onClick={() => void copy("content", instructions)}>
            {copied === "content" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        {!instructions ? <p className="skill-inspector-muted">{zh ? "暂无正文" : "No instructions"}</p>
          : source ? <pre tabIndex={0}>{instructions}</pre>
          : <div className="skill-reader-preview"><MarkdownContent source={instructions} document /></div>}
      </div>
    </section>
  </article>;
}
