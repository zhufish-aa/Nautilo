import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as Drawer from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import {
  Braces,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Minus,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { ProviderCapability } from "@agenthub/domain";
import { Button } from "../../components/ui/Button";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { Switch } from "../../components/ui/Switch";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { capabilityDescription, capabilityOrigin, type CapabilityOriginKind } from "../../lib/capability-origin";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { useI18n } from "../../lib/i18n";
import type { ProviderMeta } from "../../lib/types";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { diagnosticKey, useServiceDiagnostics } from "../../stores/service-diagnostics";
import { toast } from "../../stores/toast";
import { McpDiagnosticPanel } from "../settings/ServiceDiagnosticPanel";
import { redactArguments, safeMcpSummary } from "./import-safety";
import "./mcp-workbench.css";

type Group = { origin: CapabilityOriginKind; items: ProviderCapability[] };
type SetBindings = (items: ProviderCapability[], targets: string[], enabled: boolean) => void;

function buildMcpJsonSnippet(tool: ProviderCapability): string {
  const mcp = tool.mcp;
  if (!mcp) return JSON.stringify({ mcpServers: { [tool.name]: {} } }, null, 2);
  if (mcp.transport === "http") {
    const entry: Record<string, unknown> = { url: mcp.url };
    if (mcp.headers && Object.keys(mcp.headers).length > 0) {
      entry.headers = Object.fromEntries(Object.keys(mcp.headers).map(key => [key, "<REDACTED>"]));
    }
    return JSON.stringify({ mcpServers: { [tool.name]: entry } }, null, 2);
  }
  const entry: Record<string, unknown> = { command: mcp.command };
  if (mcp.args?.length) entry.args = redactArguments(mcp.args);
  if (mcp.cwd) entry.cwd = mcp.cwd;
  if (mcp.env && Object.keys(mcp.env).length > 0) {
    entry.env = Object.fromEntries(Object.keys(mcp.env).map(key => [key, "<REDACTED>"]));
  }
  return JSON.stringify({ mcpServers: { [tool.name]: entry } }, null, 2);
}

export function McpWorkbench({
  matrix, showWorkbench, groups, inventory, originNames, ready, providers, providerId, harnessName, busy, setBindings, onCreate, onEdit, onDelete,
}: {
  matrix: boolean;
  showWorkbench: () => void;
  groups: Group[];
  inventory: ProviderCapability[];
  originNames: Record<CapabilityOriginKind, string>;
  ready: ProviderMeta[];
  providers: ProviderMeta[];
  providerId: string;
  harnessName: string;
  busy: boolean;
  setBindings: SetBindings;
  onCreate: () => void;
  onEdit: (tool: ProviderCapability, focusDescription?: boolean) => void;
  onDelete: (tool: ProviderCapability) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [collapsed, setCollapsed] = useState<Set<CapabilityOriginKind>>(new Set());

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const fit = () => {
      const compact = element.clientWidth < 860;
      setNarrow(compact);
      if (!compact) setDrawer(false);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selected = groups.flatMap((group) => group.items).find((tool) => tool.id === selectedId) ?? groups[0]?.items[0];
  const visible = groups.flatMap(group => collapsed.has(group.origin) ? [] : group.items);
  const tabStop = visible.find(tool => tool.id === selected?.id) ?? visible[0];

  const focusRow = (id: string) => list.current?.querySelector<HTMLButtonElement>('[data-mcp-id="' + CSS.escape(id) + '"]')?.focus();
  const move = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || !(event.target instanceof HTMLElement)) return;
    const id = event.target.dataset.mcpId;
    if (!id) return;
    event.preventDefault();
    const index = visible.findIndex(tool => tool.id === id);
    const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) { setSelectedId(next.id); focusRow(next.id); }
  };

  const select = (tool: ProviderCapability) => {
    setSelectedId(tool.id);
    if (matrix) {
      setCollapsed(previous => {
        const next = new Set(previous);
        next.delete(capabilityOrigin(tool).kind);
        return next;
      });
      showWorkbench();
    }
    if (narrow) setDrawer(true);
  };

  const onSpotlightMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (reduced) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  const inspector = selected && (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={selected.id}
        className="mcp-inspector-motion"
        initial={reduced ? false : { opacity: 0, y: 7 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -4 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <McpServerDetail
          tool={selected}
          originLabel={originNames[capabilityOrigin(selected).kind]}
          ready={ready}
          providers={providers}
          providerId={providerId}
          harnessName={harnessName}
          busy={busy}
          onSet={(targets, enabled) => setBindings([selected], targets, enabled)}
          onEdit={(focusDesc) => { setDrawer(false); onEdit(selected, focusDesc); }}
          onDelete={() => { setDrawer(false); onDelete(selected); }}
        />
      </motion.div>
    </AnimatePresence>
  );

  const empty = (
    <div className="mcp-workbench-empty">
      <span className="mcp-empty-icon" aria-hidden><Server size={22} /></span>
      <p>{inventory.length ? t("agents.tools.emptyFiltered") : (zh ? "还没有 MCP 服务" : "No MCP servers yet")}</p>
      {!inventory.length && <Button variant="primary" size="sm" disabled={busy} onClick={onCreate}><Plus size={15} aria-hidden />{zh ? "添加 MCP" : "Add MCP"}</Button>}
    </div>
  );

  return (
    <div className="mcp-view" ref={surface} aria-busy={busy}>
      <AnimatePresence mode="wait" initial={false}>
        {matrix ? (
          <motion.div
            key="mcp-matrix-view"
            className="mcp-view-stage"
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <McpMatrix
              groups={groups}
              inventory={inventory}
              originNames={originNames}
              ready={ready}
              busy={busy}
              select={select}
              setBindings={setBindings}
            />
          </motion.div>
        ) : (
          <motion.div
            key="mcp-workbench-view"
            className="mcp-workbench"
            data-compact={narrow}
            data-empty={!selected}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {!selected ? empty : <>
              <aside className="mcp-service-list" ref={list} onKeyDown={move} onPointerMove={onSpotlightMove} aria-label={zh ? "MCP 服务列表" : "MCP server list"}>
                {groups.map((group) => {
                  const all = inventory.filter(tool => capabilityOrigin(tool).kind === group.origin);
                  const enabled = all.filter(tool => capabilityEnabledFor(tool, providerId)).length;
                  const isOpen = !collapsed.has(group.origin);
                  return (
                    <section key={group.origin} className="mcp-group-section">
                      <div className="mcp-group-bar">
                        <button type="button" aria-expanded={isOpen} onClick={() => setCollapsed(previous => {
                          const next = new Set(previous);
                          if (next.has(group.origin)) next.delete(group.origin); else next.add(group.origin);
                          return next;
                        })}>
                          <ChevronRight size={13} className="mcp-group-chevron" aria-hidden />
                          <strong>{originNames[group.origin]}</strong>
                          <small>{enabled} / {all.length}</small>
                        </button>
                        <div className="mcp-group-actions">
                          <button type="button" disabled={busy || !providerId || enabled === all.length}
                            title={zh ? "启用该分组全部服务" : "Enable all in group"} onClick={() => setBindings(all, [providerId], true)}>
                            {zh ? "全启" : "Enable all"}
                          </button>
                          <button type="button" disabled={busy || !providerId || !enabled}
                            title={zh ? "停用该分组全部服务" : "Disable all in group"} onClick={() => setBindings(all, [providerId], false)}>
                            {zh ? "全停" : "Disable all"}
                          </button>
                        </div>
                      </div>
                      <AnimatePresence initial={false}>
                        {isOpen && <motion.div
                          className="mcp-group-items"
                          initial={reduced ? false : { opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={reduced ? undefined : { opacity: 0, height: 0 }}
                          transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                        >
                          {group.items.map((tool, index) => {
                            const rowEnabled = capabilityEnabledFor(tool, providerId);
                            const current = tool.id === selected.id;
                            const activeCount = tool.enabled ? new Set(tool.providerIds).size : 0;
                            return (
                              <McpListRow
                                key={tool.id}
                                tool={tool}
                                index={index}
                                current={current}
                                tabStop={tabStop?.id === tool.id}
                                rowEnabled={rowEnabled}
                                activeCount={activeCount}
                                busy={busy || !providerId}
                                harnessName={harnessName}
                                reduced={reduced}
                                zh={zh}
                                onSelect={() => select(tool)}
                                onToggle={(checked) => setBindings([tool], [providerId], checked)}
                              />
                            );
                          })}
                        </motion.div>}
                      </AnimatePresence>
                    </section>
                  );
                })}
              </aside>
              {!narrow && <div className="mcp-inspector-pane" onPointerMove={onSpotlightMove}>{inspector}</div>}
            </>}
          </motion.div>
        )}
      </AnimatePresence>

      {!matrix && narrow && <Drawer.Root open={drawer && !!selected} onOpenChange={setDrawer}>
        <Drawer.Portal>
          <Drawer.Overlay className="skill-drawer-overlay" />
          <Drawer.Content className="skill-drawer" aria-describedby={undefined} onCloseAutoFocus={event => {
            event.preventDefault();
            if (selected && !document.querySelector('[role="dialog"][data-state="open"]')) focusRow(selected.id);
          }}>
            <div className="skill-drawer-heading">
              <Drawer.Title>{zh ? "MCP 服务详情" : "MCP server details"}</Drawer.Title>
              <Drawer.Close aria-label={zh ? "关闭" : "Close"}><X size={17} /></Drawer.Close>
            </div>
            <div className="mcp-inspector-pane">{inspector}</div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>}
    </div>
  );
}

function McpListRow({
  tool, index, current, tabStop, rowEnabled, activeCount, busy, harnessName, reduced, zh, onSelect, onToggle,
}: {
  tool: ProviderCapability;
  index: number;
  current: boolean;
  tabStop: boolean;
  rowEnabled: boolean;
  activeCount: number;
  busy: boolean;
  harnessName: string;
  reduced: boolean;
  zh: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}): JSX.Element {
  const key = diagnosticKey({ kind: "mcp", id: tool.id, version: tool.updatedAt });
  const result = useServiceDiagnostics((state) => state.results[key]);
  const checking = useServiceDiagnostics((state) => state.checking[key]);
  const health = checking ? "checking" : result?.state;
  const isHttp = tool.mcp?.transport === "http";
  const toolCount = result?.toolCount ?? result?.tools?.length;

  return (
    <div
      className="mcp-list-row"
      data-selected={current}
      data-enabled={rowEnabled}
      style={{ "--mcp-row-delay": `${Math.min(index, 12) * 20}ms` } as CSSProperties}
    >
      {current && <motion.span
        layoutId="mcp-row-active"
        className="mcp-row-active-bg"
        aria-hidden
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34, mass: 0.85 }}
      />}
      <button
        type="button"
        className="mcp-list-select"
        data-mcp-id={tool.id}
        tabIndex={tabStop ? 0 : -1}
        aria-current={current || undefined}
        onClick={onSelect}
      >
        <span className="mcp-list-icon" data-transport={isHttp ? "http" : "stdio"} aria-hidden>
          {isHttp ? <Globe size={14} /> : <Terminal size={14} />}
          {health && <i className="mcp-health-dot" data-health={health} />}
        </span>
        <span className="mcp-list-identity">
          <strong title={tool.name}>{tool.name}</strong>
          <span className="mcp-list-sub">
            <code className="mcp-transport-label" data-transport={isHttp ? "http" : "stdio"}>{isHttp ? "HTTP" : "STDIO"}</code>
            {toolCount !== undefined && <span className="mcp-tool-count-tag">{toolCount} {zh ? "工具" : "tools"}</span>}
          </span>
        </span>
      </button>
      {activeCount > 0 && <small className="mcp-row-reach" title={zh ? `已在 ${activeCount} 个 Harness 启用` : `Enabled on ${activeCount} harnesses`}>
        <i aria-hidden />{activeCount}{zh ? " 个" : ""}
      </small>}
      <Switch
        checked={rowEnabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`${harnessName} · ${tool.name}`}
      />
    </div>
  );
}

function McpServerDetail({
  tool, originLabel, ready, providers, providerId, harnessName, busy, onSet, onEdit, onDelete,
}: {
  tool: ProviderCapability;
  originLabel: string;
  ready: ProviderMeta[];
  providers: ProviderMeta[];
  providerId: string;
  harnessName: string;
  busy: boolean;
  onSet: (targets: string[], enabled: boolean) => void;
  onEdit: (focusDescription?: boolean) => void;
  onDelete: () => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const [copied, setCopied] = useState<"command" | "json" | string>();
  const [reveal, setReveal] = useState(false);
  const key = diagnosticKey({ kind: "mcp", id: tool.id, version: tool.updatedAt });
  const diagResult = useServiceDiagnostics((state) => state.results[key]);
  const diagChecking = useServiceDiagnostics((state) => state.checking[key]);
  const health = diagChecking ? "checking" : diagResult?.state;

  const mcp = tool.mcp;
  const description = capabilityDescription(tool);
  const origin = capabilityOrigin(tool);
  const active = [...new Set(tool.enabled ? tool.providerIds : [])];
  const readyIds = ready.map(provider => toDaemonProviderId(provider.id));
  const known = new Set([...providers.map(provider => toDaemonProviderId(provider.id)), ...active]);
  const currentEnabled = capabilityEnabledFor(tool, providerId);
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
    const timer = window.setTimeout(() => setCopied(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyText = async (tag: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(tag);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const copyCommandLabel = copied === "command" ? (zh ? "已复制" : "Copied") : (zh ? "复制命令" : "Copy");
  const copyJsonLabel = copied === "json" ? (zh ? "已复制 JSON" : "Copied JSON") : (zh ? "复制 JSON" : "Copy JSON");
  const revealLabel = reveal ? (zh ? "隐藏值" : "Hide values") : (zh ? "显示值" : "Show values");

  return <article className="mcp-server-detail" aria-label={tool.name}>
    <header className="mcp-detail-header">
      <div className="mcp-detail-heading">
        <div className="mcp-detail-title-row">
          <span className="mcp-detail-icon" data-transport={http ? "http" : "stdio"} data-health={health} aria-hidden>
            {http ? <Globe size={18} /> : <Terminal size={18} />}
            {health && <i className="mcp-health-dot" data-health={health} />}
          </span>
          <div className="mcp-detail-title-copy">
            <div className="mcp-detail-name-line">
              <h2>{tool.name}</h2>
              <code className="mcp-transport-label" data-transport={http ? "http" : "stdio"}>
                {http ? (zh ? "流式 HTTP" : "Streamable HTTP") : "STDIO"}
              </code>
              <span className="mcp-origin-label" title={origin.label || originLabel}>{origin.label || originLabel}</span>
            </div>
            {description ? (
              <p title={description}>{description}</p>
            ) : (
              <p className="mcp-detail-desc-empty">
                <span>{zh ? "暂未填写服务描述" : "No description yet"}</span>
                <button type="button" disabled={busy} onClick={() => onEdit(true)}>{zh ? "去补充" : "Add"}</button>
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="mcp-detail-actions">
        <Switch
          checked={currentEnabled}
          disabled={busy || !providerId}
          onCheckedChange={checked => onSet([providerId], checked)}
          aria-label={`${harnessName} · ${tool.name}`}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onEdit()}>
          <Pencil size={13} aria-hidden />{t("common.edit")}
        </Button>
        <button
          type="button"
          className="mcp-icon-button"
          data-copied={copied === "json"}
          onClick={() => void copyText("json", buildMcpJsonSnippet(tool))}
          title={copyJsonLabel}
          aria-label={copyJsonLabel}
        >
          {copied === "json" ? <Check size={14} aria-hidden /> : <Braces size={14} aria-hidden />}
        </button>
        <button
          type="button"
          className="mcp-icon-button mcp-delete-button"
          disabled={busy}
          onClick={onDelete}
          title={zh ? "删除" : "Delete"}
          aria-label={zh ? "删除" : "Delete"}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
    </header>

    <section className="mcp-detail-scope" aria-label={zh ? "启用范围" : "Enabled for"}>
      <div className="mcp-section-heading">
        <h3>
          {zh ? "启用范围" : "Enabled for"}
          <span className="mcp-scope-count" data-active={active.length > 0}>{active.length} / {known.size}</span>
        </h3>
        <div className="mcp-section-quick-actions">
          <button type="button" disabled={busy || !readyIds.some(id => !active.includes(id))} onClick={() => onSet(readyIds, true)}>
            {zh ? "全选就绪" : "Enable all ready"}
          </button>
          <button type="button" disabled={busy || !active.length} onClick={() => onSet(active, false)}>
            {zh ? "全关" : "Disable all"}
          </button>
        </div>
      </div>
      {ready.length ? (
        <div className="mcp-harness-chips">
          {ready.map(provider => {
            const id = toDaemonProviderId(provider.id);
            const enabled = capabilityEnabledFor(tool, id);
            return <button
              type="button"
              key={provider.id}
              disabled={busy}
              aria-pressed={enabled}
              onClick={() => onSet([id], !enabled)}
            >
              <ProviderAvatar providerId={provider.id} size="sm" />
              <span>{provider.name}</span>
              <span className="mcp-chip-state" aria-hidden>{enabled ? <Check size={10} strokeWidth={3} /> : null}</span>
            </button>;
          })}
        </div>
      ) : (
        <p className="mcp-detail-muted">{zh ? "暂无已就绪的 Harness" : "No ready Harnesses"}</p>
      )}
      {active.some(id => !readyIds.includes(id)) && (
        <p className="mcp-detail-muted">
          {zh ? "已启用但未就绪" : "Enabled but unavailable"} · {active.filter(id => !readyIds.includes(id))
            .map(id => providers.find(provider => toDaemonProviderId(provider.id) === id)?.name ?? id).join(" · ")}
        </p>
      )}
    </section>

    <section className="mcp-run-config" aria-label={zh ? "运行配置" : "Runtime configuration"}>
      <div className="mcp-section-heading">
        <h3>{http ? (zh ? "服务地址" : "Server address") : (zh ? "启动命令" : "Launch command")}</h3>
      </div>
      {summary && <div className="mcp-command">
        <code title={summary}>{summary}</code>
        <button type="button" className="mcp-icon-button" data-copied={copied === "command"} title={copyCommandLabel} aria-label={copyCommandLabel} onClick={() => void copyText("command", summary)}>
          {copied === "command" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
      </div>}
      {(optionalValues.some(([, value]) => value) || secrets.length > 0) && <dl className="mcp-config-fields">
        {optionalValues.map(([label, value]) => value ? <div key={label} className="mcp-config-card">
          <dt>{label}</dt>
          <dd><code>{value}</code></dd>
        </div> : null)}
        {secrets.length > 0 && <div className="mcp-config-card mcp-config-secrets">
          <dt>
            <span>{http ? t("agents.tools.editor.headers") : t("agents.tools.editor.env")}</span>
            <button type="button" className="mcp-icon-button" title={revealLabel} aria-label={revealLabel} aria-pressed={reveal} onClick={() => setReveal((visible) => !visible)}>
              {reveal ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
            </button>
          </dt>
          <dd>
            {secrets.map(([name, value]) => (
              <div key={name} className="mcp-secret-row">
                <code><span className="mcp-secret-key">{name}</span> = <span className="mcp-secret-val">{reveal || !value ? value : "••••••••"}</span></code>
                {value && (
                  <button
                    type="button"
                    className="mcp-secret-copy"
                    data-copied={copied === `secret:${name}`}
                    title={copied === `secret:${name}` ? (zh ? "已复制" : "Copied") : (zh ? `复制 ${name}` : `Copy ${name}`)}
                    aria-label={zh ? `复制 ${name}` : `Copy ${name}`}
                    onClick={() => void copyText(`secret:${name}`, value)}
                  >
                    {copied === `secret:${name}` ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
                  </button>
                )}
              </div>
            ))}
          </dd>
        </div>}
      </dl>}
    </section>

    <McpDiagnosticPanel target={{ kind: "mcp", id: tool.id, version: tool.updatedAt }} />
  </article>;
}

function McpMatrix({
  groups, inventory, originNames, ready, busy, select, setBindings,
}: {
  groups: Group[];
  inventory: ProviderCapability[];
  originNames: Record<CapabilityOriginKind, string>;
  ready: ProviderMeta[];
  busy: boolean;
  select: (tool: ProviderCapability) => void;
  setBindings: SetBindings;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const results = useServiceDiagnostics(state => state.results);
  const checking = useServiceDiagnostics(state => state.checking);
  const [point, setPoint] = useState<{ row: string; column: string }>();
  const rows = groups.flatMap(group => group.items);
  const columns = ready.map(provider => {
    const id = toDaemonProviderId(provider.id);
    return { provider, id, count: inventory.filter(tool => capabilityEnabledFor(tool, id)).length };
  });
  const total = columns.reduce((sum, column) => sum + column.count, 0);
  if (!columns.length) return <div className="skill-matrix mcp-workbench-empty">{zh ? "暂无已就绪的 Harness" : "No ready Harnesses"}</div>;

  return <div className="skill-matrix">
    <div className="skill-matrix-scroll" onPointerLeave={() => setPoint(undefined)}>
      <table style={{ minWidth: 260 + columns.length * 82 }} aria-label={zh ? "MCP 多 Harness 启用矩阵" : "MCP Harness enablement matrix"}>
        <colgroup><col className="skill-matrix-name-col" />{columns.map(column => <col key={column.id} data-lit={point?.column === column.id} />)}</colgroup>
        <thead><tr>
          <th scope="col" className="skill-matrix-fixed">{rows.length} {zh ? "个服务" : "servers"}</th>
          {columns.map(({ provider, id, count }) => <th key={id} scope="col" data-lit={point?.column === id}>
            <span className="skill-matrix-harness" title={provider.name}>
              <ProviderAvatar providerId={provider.id} size="sm" />
              <span>{provider.name.replace(/\s+Harness$/i, "")}</span>
              <strong>{count}</strong>
            </span>
            <div className="skill-matrix-actions">
              <button type="button" disabled={busy || count === inventory.length} title={zh ? "全开 · " + provider.name : "Enable all · " + provider.name}
                aria-label={zh ? "全开 · " + provider.name : "Enable all · " + provider.name} onClick={() => setBindings(inventory, [id], true)}><Plus size={12} /></button>
              <button type="button" disabled={busy || !count} title={zh ? "清空 · " + provider.name : "Clear · " + provider.name}
                aria-label={zh ? "清空 · " + provider.name : "Clear · " + provider.name} onClick={() => setBindings(inventory, [id], false)}><Minus size={12} /></button>
            </div>
          </th>)}
        </tr></thead>
        {groups.map(group => <tbody key={group.origin}>
          <tr className="skill-matrix-group"><th className="skill-matrix-fixed" scope="rowgroup">{originNames[group.origin]} <small>{group.items.length}</small></th><td colSpan={columns.length} /></tr>
          {group.items.map(tool => {
            const key = diagnosticKey({ kind: "mcp", id: tool.id, version: tool.updatedAt });
            const health = checking[key] ? "checking" : results[key]?.state;
            const isHttp = tool.mcp?.transport === "http";
            return <tr key={tool.id} data-lit={point?.row === tool.id}>
              <th className="skill-matrix-fixed" scope="row">
                <button type="button" className="mcp-matrix-row-btn" title={tool.name} onClick={() => select(tool)}>
                  <i className="mcp-health-dot" data-health={health ?? "unchecked"} aria-hidden />
                  <span>{tool.name}</span>
                  <code className="mcp-transport-label" data-transport={isHttp ? "http" : "stdio"}>{isHttp ? "HTTP" : "STDIO"}</code>
                </button>
              </th>
              {columns.map(({ provider, id }) => {
                const checked = capabilityEnabledFor(tool, id);
                return <td key={id} onPointerEnter={() => setPoint({ row: tool.id, column: id })}>
                  <button type="button" className="skill-matrix-cell" aria-pressed={checked} disabled={busy}
                    aria-label={tool.name + " · " + provider.name} onFocus={() => setPoint({ row: tool.id, column: id })}
                    onBlur={() => setPoint(undefined)} onClick={() => setBindings([tool], [id], !checked)}>
                    <span>{checked && <Check size={13} strokeWidth={2.2} aria-hidden />}</span>
                  </button>
                </td>;
              })}
            </tr>;
          })}
        </tbody>)}
        {!rows.length && <tbody><tr><td className="skill-matrix-empty" colSpan={columns.length + 1}>{zh ? "没有符合筛选条件的 MCP 服务" : "No matching MCP servers"}</td></tr></tbody>}
      </table>
    </div>
    <footer>
      <strong>{total} {zh ? "处启用" : "enabled connections"}</strong>
      <span>{zh ? "点单元格切换 · 点服务名查看详情与诊断" : "Toggle in a cell · Click a server to inspect & diagnose"}</span>
    </footer>
  </div>;
}
