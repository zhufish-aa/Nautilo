import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Eye, EyeOff, Pencil, Plus, Server, Trash2 } from "lucide-react";
import type { ProviderCapability } from "@agenthub/domain";
import { Button } from "../../components/ui/Button";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { capabilityDescription, capabilityOrigin, type CapabilityOriginKind } from "../../lib/capability-origin";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { useI18n } from "../../lib/i18n";
import { useProviderMetas } from "../../lib/provider-catalog";
import { diagnosticKey, useServiceDiagnostics } from "../../stores/service-diagnostics";
import { toast } from "../../stores/toast";
import { McpDiagnosticPanel } from "../settings/ServiceDiagnosticPanel";
import { redactArguments, safeMcpSummary } from "./import-safety";
import "./mcp-workbench.css";

export function McpWorkbench({
  groups, originNames, hasServers, onCreate, onEdit, onDelete, renderSwitch,
}: {
  groups: Array<{ origin: CapabilityOriginKind; items: ProviderCapability[] }>;
  originNames: Record<CapabilityOriginKind, string>;
  hasServers: boolean;
  onCreate: () => void;
  onEdit: (tool: ProviderCapability) => void;
  onDelete: (tool: ProviderCapability) => void;
  renderSwitch: (tool: ProviderCapability) => ReactNode;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const [selectedId, setSelectedId] = useState("");
  const selected = groups.flatMap((group) => group.items).find((tool) => tool.id === selectedId) ?? groups[0]?.items[0];

  return (
    <div className="mcp-workbench" data-empty={!selected}>
      {selected ? <>
        <aside className="mcp-service-list" aria-label={zh ? "MCP 服务列表" : "MCP server list"}>
          {groups.map((group) => (
            <section key={group.origin}>
              <h2>{originNames[group.origin]} <span>{group.items.length}</span></h2>
              {group.items.map((tool) => (
                <div className="mcp-list-row" key={tool.id} data-selected={tool.id === selected.id}>
                  <button type="button" className="mcp-list-select" aria-current={tool.id === selected.id || undefined} onClick={() => setSelectedId(tool.id)}>
                    <McpServerIcon tool={tool} />
                    <span className="mcp-list-identity">
                      <strong title={tool.name}>{tool.name}</strong>
                      <span><code className="mcp-transport-label">{tool.mcp?.transport === "http" ? "HTTP" : "STDIO"}</code>
                        {tool.enabled ? tool.providerIds.length : 0} {zh ? "个 Harness" : "harnesses"}
                      </span>
                    </span>
                  </button>
                  {renderSwitch(tool)}
                </div>
              ))}
            </section>
          ))}
        </aside>
        <McpServerDetail
          key={selected.id}
          tool={selected}
          originLabel={originNames[capabilityOrigin(selected).kind]}
          onEdit={() => onEdit(selected)}
          onDelete={() => onDelete(selected)}
          enabledSwitch={renderSwitch(selected)}
        />
      </> : (
        <div className="mcp-workbench-empty">
          <Server size={22} aria-hidden />
          <p>{hasServers ? t("agents.tools.emptyFiltered") : (zh ? "还没有 MCP 服务" : "No MCP servers yet")}</p>
          {!hasServers && <Button variant="primary" size="sm" onClick={onCreate}><Plus size={15} aria-hidden />{zh ? "添加 MCP" : "Add MCP"}</Button>}
        </div>
      )}
    </div>
  );
}

function McpServerIcon({ tool }: { tool: ProviderCapability }): JSX.Element {
  const key = diagnosticKey({ kind: "mcp", id: tool.id, version: tool.updatedAt });
  const health = useServiceDiagnostics((state) => state.results[key]?.state);
  return <span className="mcp-list-icon" aria-hidden>
    <Server size={15} />
    {health && <i className="mcp-health-dot" data-health={health} />}
  </span>;
}

function McpServerDetail({ tool, originLabel, onEdit, onDelete, enabledSwitch }: {
  tool: ProviderCapability;
  originLabel: string;
  onEdit: () => void;
  onDelete: () => void;
  enabledSwitch: ReactNode;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const providers = useProviderMetas();
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);
  const mcp = tool.mcp;
  const description = capabilityDescription(tool);
  const origin = capabilityOrigin(tool);
  const enabled = providers.filter(({ id }) => capabilityEnabledFor(tool, toDaemonProviderId(id)));
  const summary = mcp ? safeMcpSummary(mcp) : "";
  const http = mcp?.transport === "http";
  const secrets = Object.entries((http ? mcp.headers : mcp?.env) ?? {});
  const optionalValues = http ? [
    [t("agents.tools.editor.bearerToken"), mcp.bearerTokenEnvVar],
    [t("agents.tools.editor.envHeaders"), Object.entries(mcp.envHeaders ?? {}).map(([name, variable]) => `${name} = ${variable}`).join("\n")],
  ] : [
    [t("agents.tools.editor.args"), redactArguments(mcp?.args ?? []).join("\n")],
    [t("agents.tools.editor.cwd"), mcp?.cwd],
    [t("agents.tools.editor.envPassthrough"), mcp?.envPassthrough?.join("\n")],
  ];

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
    } catch (error) {
      toast.error(String(error));
    }
  };
  const copyLabel = copied ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy");
  const revealLabel = reveal ? (zh ? "隐藏值" : "Hide values") : (zh ? "显示值" : "Show values");

  return <article className="mcp-server-detail" aria-label={tool.name}>
    <header className="mcp-detail-header">
      <div className="mcp-detail-heading">
        <div><h2>{tool.name}</h2>
          <code className="mcp-transport-label">{http ? (zh ? "流式 HTTP" : "Streamable HTTP") : "STDIO"}</code>
          <span className="mcp-origin-label" title={origin.label || originLabel}>{origin.label || originLabel}</span>
        </div>
        <p data-empty={!description} title={description || undefined}>{description || (zh ? "暂未填写描述" : "No description")}</p>
      </div>
      <div className="mcp-detail-actions">
        {enabledSwitch}
        <Button type="button" variant="outline" size="sm" onClick={onEdit}><Pencil size={13} aria-hidden />{t("common.edit")}</Button>
        <button type="button" className="mcp-icon-button mcp-delete-button" onClick={onDelete} title={zh ? "删除" : "Delete"} aria-label={zh ? "删除" : "Delete"}><Trash2 size={15} aria-hidden /></button>
      </div>
    </header>

    <section className="mcp-run-config" aria-label={zh ? "运行配置" : "Runtime configuration"}>
      <h3>{http ? (zh ? "服务地址" : "Server address") : (zh ? "启动命令" : "Launch command")}</h3>
      {summary && <div className="mcp-command">
        <code title={summary}>{summary}</code>
        <button type="button" className="mcp-icon-button" title={copyLabel} aria-label={copyLabel} onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
      </div>}
      {(optionalValues.some(([, value]) => value) || secrets.length > 0) && <dl className="mcp-config-fields">
        {optionalValues.map(([label, value]) => value ? <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div> : null)}
        {secrets.length > 0 && <div className="mcp-config-secrets">
          <dt>{http ? t("agents.tools.editor.headers") : t("agents.tools.editor.env")}
            <button type="button" className="mcp-icon-button" title={revealLabel} aria-label={revealLabel} aria-pressed={reveal} onClick={() => setReveal((visible) => !visible)}>
              {reveal ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
            </button>
          </dt>
          <dd>{secrets.map(([name, value]) => <code key={name}>{name} = {reveal || !value ? value : "••••••••"}</code>)}</dd>
        </div>}
      </dl>}
      <div className="mcp-enabled-harnesses">
        <span>{zh ? "已启用 Harness" : "Enabled harnesses"}</span>
        {enabled.map((provider) => <span key={provider.id} className="mcp-harness-chip"><i className="mcp-health-dot" data-health="passed" />{provider.name}</span>)}
        {tool.enabled && tool.providerIds.length > enabled.length
          ? <span>{zh ? `共 ${tool.providerIds.length} 个` : `${tool.providerIds.length} total`}</span>
          : !enabled.length && <span>{zh ? "暂未启用" : "Not enabled yet"}</span>}
      </div>
    </section>

    <McpDiagnosticPanel target={{ kind: "mcp", id: tool.id, version: tool.updatedAt }} />
  </article>;
}
