import { useEffect, useState } from "react";
import { Check, ChevronRight, Copy, FolderOpen } from "lucide-react";
import type { ProviderCapability } from "@agenthub/domain";
import { getBridge } from "../../lib/bridge";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { capabilityDescription, capabilityOrigin } from "../../lib/capability-origin";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { useI18n } from "../../lib/i18n";
import { useProviderMetas } from "../../lib/provider-catalog";
import { toast } from "../../stores/toast";

const absolutePath = /^(?:[a-z]:[/\\]|\\\\|\/)/i;

export function SkillDetails({ capability }: { capability: ProviderCapability }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const providers = useProviderMetas();
  const [copied, setCopied] = useState<"path" | "content">();
  const description = capabilityDescription(capability);
  const directory = capability.skill?.resourceDir;
  const path = capabilityOrigin(capability).path || directory;
  const instructions = capability.skill?.instructions ?? "";
  const lines = instructions ? instructions.split(/\r?\n/).length : 0;
  const enabled = providers.filter((provider) =>
    capabilityEnabledFor(capability, toDaemonProviderId(provider.id)),
  );
  const shell = getBridge()?.shell;
  const copiedLabel = zh ? "已复制" : "Copied";
  const copyPathLabel = copied === "path" ? copiedLabel : zh ? "复制路径" : "Copy path";
  const openLabel = zh ? "打开目录" : "Open folder";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy(target: "path" | "content", value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function openFolder(path: string): Promise<void> {
    if (!shell) return;
    try {
      if (directory && absolutePath.test(directory)) {
        const error = await shell.openPath(directory);
        if (error) toast.error(error);
      } else {
        await shell.showItemInFolder(path);
      }
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div className="skill-details">
      {description && <p className="skill-details-description">{description}</p>}
      <dl className="skill-details-meta">
        {path && <>
          <dt>{zh ? "原始位置" : "Original path"}</dt>
          <dd className="skill-details-path">
            <code title={path}>{path}</code>
            <button type="button" title={copyPathLabel} aria-label={copyPathLabel} onClick={() => void copy("path", path)}>
              {copied === "path" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            </button>
            {shell && absolutePath.test(path) && (
              <button type="button" title={openLabel} aria-label={openLabel} onClick={() => void openFolder(path)}>
                <FolderOpen size={14} aria-hidden />
              </button>
            )}
          </dd>
        </>}
        <dt>{zh ? "已启用于" : "Enabled for"}</dt>
        <dd className="skill-details-chips">
          {enabled.length
            ? enabled.map((provider) => <span key={provider.id} className="skill-enabled-chip">{provider.name}</span>)
            : <span className="skill-details-muted">{zh ? "暂未启用" : "Not enabled yet"}</span>}
        </dd>
        {capability.tags.length > 0 && <>
          <dt>{zh ? "标签" : "Tags"}</dt>
          <dd className="skill-details-chips">
            {capability.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </dd>
        </>}
      </dl>
      <div className="skill-code-panel skill-code-view">
        <details open>
          <summary className="skill-code-toolbar">
            <ChevronRight size={14} className="skill-code-chevron" aria-hidden />
            <code>SKILL.md</code>
            <span className="skill-code-stat">{zh ? `${lines} 行` : `${lines} lines`}</span>
          </summary>
          <pre tabIndex={0}><code>{instructions}</code></pre>
        </details>
        {instructions && (
          <button type="button" className="skill-code-action" onClick={() => void copy("content", instructions)} aria-live="polite">
            {copied === "content" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied === "content" ? copiedLabel : zh ? "复制内容" : "Copy content"}
          </button>
        )}
      </div>
    </div>
  );
}
