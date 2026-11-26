import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, Check, ChevronRight, Github, Plug, Workflow, X, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import type { CapabilityReference, ProviderCapability, WorkflowMention, WorkflowTemplate } from "@agenthub/domain";
import type { IpcRequestMap, ServiceDiagnostic } from "@agenthub/schemas";
import { useI18n } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { requestCore } from "../../lib/bridge";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { diagnosticKey, useServiceDiagnostics } from "../../stores/service-diagnostics";
import { useWorkflowsStore } from "../../stores/workflows";
import { toast } from "../../stores/toast";
import "./composer-references.css";

type Category = "all" | "skill" | "mcp" | "workflow";
export type ComposerReference = CapabilityReference | ({ kind: "workflow" } & WorkflowMention);
type Choice = ComposerReference;
type Tool = NonNullable<ServiceDiagnostic["tools"]>[number];
type CapabilityScope = IpcRequestMap["capability.list"]["input"];
type Row = { item: Choice; description?: string; capability?: ProviderCapability; nodes?: number };
export interface ReferenceQuery { start: number; end: number; text: string; trigger: "@" | "/" | "button"; }
const categories: Category[] = ["all", "skill", "mcp", "workflow"];
const icons = { skill: Zap, mcp: Plug, workflow: Workflow };
const noReferences: CapabilityReference[] = [];
const recentsKey = "nautilo-composer-references";

export function referenceQueryAt(value: string, cursor: number, allowSlash: boolean): ReferenceQuery | undefined {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const line = value.slice(lineStart, cursor);
  const at = line.lastIndexOf("@");
  const slash = allowSlash ? [...line.matchAll(/(?:^|\s)\/(?!\/)/g)].at(-1) : undefined;
  const slashAt = slash ? slash.index + slash[0].length - 1 : -1;
  const start = Math.max(at, slashAt);
  if (start < 0) return;
  const text = line.slice(start + 1);
  if (text.length > 80 || (start === slashAt && text.includes("/"))) return;
  return { start: lineStart + start, end: cursor, text: text.trim().toLowerCase(), trigger: start === at ? "@" : "/" };
}

export function referenceKey(ref: Choice): string {
  return JSON.stringify([ref.kind, ref.id, ref.kind === "mcp" ? ref.tool : undefined]);
}

function recentReferences(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(recentsKey) ?? "[]");
    return Array.isArray(saved) ? saved.filter((key): key is string => {
      if (typeof key !== "string") return false;
      const tuple: unknown = JSON.parse(key);
      return Array.isArray(tuple) && tuple.length === 3 && typeof tuple[1] === "string" &&
        (tuple[2] === null || typeof tuple[2] === "string");
    }).slice(0, 3) : [];
  } catch { return []; }
}

export function recordReferenceUse(references?: CapabilityReference[], workflow?: WorkflowMention): void {
  const keys = [...(references ?? []), ...(workflow ? [{ ...workflow, kind: "workflow" as const }] : [])].map(referenceKey).reverse();
  if (!keys.length) return;
  try { localStorage.setItem(recentsKey, JSON.stringify([...new Set([...keys, ...recentReferences()])].slice(0, 3))); }
  catch { /* Recent references are a convenience, independent of delivery. */ }
}

const nativeResource = (capability: ProviderCapability) => capability.id.startsWith("native:");
const online = (report?: ServiceDiagnostic) => report?.steps.some(step => step.id === "initialize" && step.state === "passed") === true;
const label = (item: Choice) => item.kind === "mcp" && item.tool ? item.name + " / " + item.tool : item.name;
export const referenceText = (item: Choice): string => "@" + label(item);

export function composerReferences(references?: CapabilityReference[], workflow?: WorkflowMention): Choice[] {
  return [...(references ?? []), ...(workflow ? [{ ...workflow, kind: "workflow" as const }] : [])];
}

/** The textarea and stored message keep readable text. Only attached names become references. */
export function referenceParts(text: string, items: Choice[]): { text: string; start: number; item?: Choice }[] {
  const parts: { text: string; start: number; item?: Choice }[] = [];
  if (!items.length) return [{ text, start: 0 }];
  const names = items.map(item => ({ item, token: referenceText(item) })).sort((a, b) => b.token.length - a.token.length);
  let from = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const match = names.find(({ token }) => text.startsWith(token, at) && !/[a-z0-9_-]/i.test(text[at + token.length] ?? ""));
    if (!match) continue;
    if (from < at) parts.push({ text: text.slice(from, at), start: from });
    parts.push({ text: match.token, start: at, item: match.item });
    from = at + match.token.length;
    at = from - 1;
  }
  if (from < text.length) parts.push({ text: text.slice(from), start: from });
  return parts;
}

export function ReferenceIcon({ item }: { item: Choice }) {
  const Icon = item.kind === "mcp" && /^(?:github|github mcp)$/i.test(item.name) ? Github : icons[item.kind];
  return <Icon size={12} aria-hidden />;
}

function referenceHref(item: Choice): string {
  return item.kind === "workflow" ? "/workflows?template=" + encodeURIComponent(item.id) : "/settings?section=" + (item.kind === "skill" ? "skills" : "mcp");
}

export function messageReferenceParts(text: string, items: Choice[]) {
  return referenceParts(text, items).map(({ text, item, start }) => item
    ? <Link key={start} className="message-inline-reference" data-kind={item.kind} to={referenceHref(item)} title={label(item)}>
        <ReferenceIcon item={item} />{label(item)}
      </Link>
    : text);
}

export function useComposerReferences({ scope, capabilities, workflows, providerId, capabilityScope, selected, selectedWorkflow, onChoose }: {
  scope: string; capabilities: boolean; workflows: boolean; providerId?: string; capabilityScope?: CapabilityScope;
  selected?: CapabilityReference[]; selectedWorkflow?: WorkflowMention; onChoose: (choice: Choice, query: ReferenceQuery) => void;
}) {
  const zh = useI18n().locale === "zh-CN";
  const reduce = useUiReducedMotion();
  const [query, setQuery] = useState<ReferenceQuery>();
  const [category, setCategory] = useState<Category>("all");
  const [index, setIndex] = useState(0);
  const [drill, setDrill] = useState<{ capability: ProviderCapability; query: string }>();
  const [resources, setResources] = useState<{ scope: CapabilityScope; items: ProviderCapability[] }>();
  const [resourceError, setResourceError] = useState(false);
  const templates = useWorkflowsStore(state => state.templates);
  const reports = useServiceDiagnostics(state => state.results);
  const checking = useServiceDiagnostics(state => state.checking);
  const intent = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = Boolean(query && (capabilities || workflows));
  const recents = useMemo(() => open ? recentReferences() : [], [open]);
  const visibleCategories = categories.filter(kind => kind === "all" || (kind === "workflow" ? workflows : capabilities));
  const names: Record<Category, string> = { all: zh ? "全部" : "All", skill: "Skill", mcp: "MCP", workflow: zh ? "工作流" : "Workflows" };
  const targetFor = (capability: ProviderCapability) => ({ kind: "mcp" as const, id: capability.id, version: capability.updatedAt, scope: capabilityScope });
  const reportFor = (capability: ProviderCapability) => reports[diagnosticKey(targetFor(capability))];

  function close(): void {
    intent.current++;
    setQuery(undefined);
    setDrill(undefined);
  }

  function update(next: ReferenceQuery | undefined): void {
    if (!next) { close(); return; }
    if (query?.start === next.start && query.end === next.end && query.text === next.text && query.trigger === next.trigger) return;
    intent.current++;
    if (!query || query.start !== next.start || query.trigger !== next.trigger) {
      setDrill(undefined);
      setCategory(next.trigger === "/" ? workflows ? "workflow" : "skill" : "all");
    }
    setQuery(next);
    setIndex(0);
  }

  useEffect(close, [scope]);
  useEffect(() => {
    if (!open) return;
    if (workflows) void useWorkflowsStore.getState().loadTemplates().catch(() => undefined);
  }, [open, workflows]);
  useEffect(() => {
    if (!open || !capabilities || !capabilityScope) return;
    let current = true;
    setResources(undefined);
    setResourceError(false);
    void requestCore<ProviderCapability[]>("capability.list", capabilityScope).then(items => {
      if (current) setResources({ scope: capabilityScope, items });
    }, () => { if (current) setResourceError(true); });
    return () => { current = false; };
  }, [open, capabilities, capabilityScope]);

  const selectedKeys = new Set([
    ...(selected ?? noReferences).map(referenceKey),
    ...(selectedWorkflow ? [referenceKey({ ...selectedWorkflow, kind: "workflow" })] : [])
  ]);
  const makeMcp = (capability: ProviderCapability, tool?: Pick<Tool, "name" | "description">): Row => ({
    item: { kind: "mcp", id: capability.id, name: capability.name, tool: tool?.name },
    capability, description: tool?.description ?? capability.description
  });
  const tools = resources && resources.scope === capabilityScope ? resources.items : [];
  const catalog: Row[] = open ? [
    ...(capabilities ? tools.filter(capability => capabilityEnabledFor(capability, providerId ?? capability.providerIds[0] ?? "")).map((capability): Row => capability.kind === "mcp" ? makeMcp(capability) : {
      item: { kind: "skill", id: capability.id, name: capability.name },
      capability, description: capability.description
    }) : []),
    ...(workflows ? templates.map((template: WorkflowTemplate): Row => ({
      item: { kind: "workflow", id: template.id, name: template.name, revision: template.revision },
      description: template.definition.nodes.find(node => node.id === template.definition.entry)?.prompt,
      nodes: template.definition.nodes.length
    })) : [])
  ] : [];
  const drillReport = drill && reportFor(drill.capability);
  const search = query?.text ?? "";
  const toolSearch = drill && search.startsWith(drill.query) ? search.slice(drill.query.length).trim() : search;
  const matches = (row: Row, text: string) => [label(row.item), row.description, ...(row.capability?.tags ?? [])].join(" ").toLowerCase().includes(text);
  const matching = catalog.filter(row => matches(row, search));
  const recentTools = !search && !drill ? recents.flatMap(key => {
    const [kind, id, tool] = JSON.parse(key) as [string, string, string | null];
    if (kind !== "mcp" || !tool) return [];
    const service = catalog.find(row => row.item.kind === "mcp" && row.item.id === id)?.capability;
    return service ? [makeMcp(service, { name: tool })] : [];
  }) : [];
  const available = (row: Row) => row.item.kind === "skill" ? !row.item.temporary
    : row.item.kind === "mcp" && row.capability ? row.capability.enabled && online(reportFor(row.capability)) : false;
  const recentRank = (row: Row) => {
    const rank = recents.indexOf(referenceKey(row.item));
    return rank < 0 ? recents.length : rank;
  };
  const activeCategory = visibleCategories.includes(category) ? category : "all";
  const rows = drill
    ? (drillReport?.tools ?? []).map(tool => makeMcp(drill.capability, tool)).filter(row => matches(row, toolSearch))
    : [...matching, ...recentTools].filter(row => activeCategory === "all" || activeCategory === row.item.kind)
      .sort((left, right) => search ? 0 : recentRank(left) - recentRank(right) || Number(available(right)) - Number(available(left)));
  const active = Math.min(index, rows.length - 1);
  const activeId = active >= 0 ? id + "-" + active : undefined;
  useEffect(() => {
    if (open && activeId) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, open, category, drill?.capability.id]);

  function choose(row: Row): void {
    if (!query) return;
    const complete = () => { onChoose(row.item, query); close(); };
    if (selectedKeys.has(referenceKey(row.item))) { complete(); return; }
    if (row.item.kind !== "mcp" || !row.item.tool || !row.capability) { complete(); return; }
    const capability = row.capability;
    const tool = row.item.tool;
    const accept = (result: ServiceDiagnostic) => {
      if (!result.tools?.some(entry => entry.name === tool)) {
        toast.error(zh ? "当前连接没有返回这个工具，可以引用整个 MCP 服务。" : "The current connection did not report this tool. You can reference the entire MCP server.");
      } else complete();
    };
    const report = reportFor(capability);
    if (report && drill) { accept(report); return; }
    const current = ++intent.current;
    void useServiceDiagnostics.getState().check(targetFor(capability)).then(result => {
      if (current !== intent.current) return;
      accept(result);
    });
  }

  function enter(row: Row): void {
    if (!row.capability?.enabled || row.item.kind !== "mcp" || row.item.tool) return;
    intent.current++;
    setDrill({ capability: row.capability, query: search });
    setIndex(0);
    void useServiceDiagnostics.getState().check(targetFor(row.capability));
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false;
    const key = event.key;
    if (key === "Escape") close();
    else if (key === "Tab" && !drill) {
      const next = (visibleCategories.indexOf(activeCategory) + (event.shiftKey ? -1 : 1) + visibleCategories.length) % visibleCategories.length;
      setCategory(visibleCategories[next]);
      setIndex(0);
    } else if (key === "ArrowLeft" && drill) {
      setDrill(undefined);
      setIndex(0);
    } else if (key === "ArrowRight" && !drill && rows[active]?.item.kind === "mcp") enter(rows[active]);
    else if ((key === "ArrowDown" || key === "ArrowUp") && rows.length) {
      setIndex((active + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (rows[active]) choose(rows[active]);
    } else return false;
    event.preventDefault();
    return true;
  }

  const menu = open && (
    <div className="composer-reference-menu" data-reduce={reduce || undefined} onMouseDown={event => event.preventDefault()}>
      <div className="composer-reference-tabs">
        {drill ? <button className="composer-reference-back" type="button" onClick={() => { setDrill(undefined); setIndex(0); }}>
          <ArrowLeft size={14} />{zh ? "返回 MCP" : "Back to MCP"} / {drill.capability.name} {zh ? "工具" : "tools"}
          {drillReport?.toolCount !== undefined && <span>({drillReport.toolCount})</span>}
        </button> : visibleCategories.map(kind => <button type="button" key={kind} aria-pressed={activeCategory === kind}
          onClick={() => { setCategory(kind); setIndex(0); }}>
          {names[kind]} <span>{kind === "all" ? matching.length : matching.filter(row => row.item.kind === kind).length}</span>
        </button>)}
      </div>
      <div ref={list} className="composer-reference-list" id={id} role="listbox" aria-label={zh ? "引用能力" : "Reference capabilities"} key={drill?.capability.id ?? "root"}>
        {rows.map((row, rowIndex) => {
          const { item, capability } = row;
          const service = item.kind === "mcp" && !item.tool ? capability : undefined;
          const report = service && reportFor(service);
          const busy = service && checking[diagnosticKey(targetFor(service))];
          const attached = selectedKeys.has(referenceKey(item));
          const Icon = icons[item.kind];
          return <div key={referenceKey(item)} className="composer-reference-option" data-active={active === rowIndex || undefined}
            data-kind={item.kind} onMouseEnter={() => setIndex(rowIndex)}>
            <button type="button" className="composer-reference-select" role="option" id={id + "-" + rowIndex}
              aria-selected={active === rowIndex} onClick={() => choose(row)}>
              <Icon size={15} className="composer-reference-icon" aria-hidden />
              <span className="composer-reference-name">
                <span>{drill && item.kind === "mcp" && item.tool ? item.tool : label(item)}{service && <i className="composer-reference-online" data-online={online(report) || undefined} />}</span>
                {row.description && <small>{row.description}</small>}
              </span>
              {attached ? <span className="composer-reference-attached"><Check size={12} />{zh ? "已引用" : "Attached"}</span>
                : capability && nativeResource(capability) && (!service || !online(report)) ? <span className="composer-reference-meta">{zh ? "原生" : "Native"}</span>
                : item.kind === "skill" ? <span className="composer-reference-meta">{zh ? "已启用" : "Enabled"}</span>
                : item.kind === "workflow" ? <span className="composer-reference-meta">{row.nodes} {zh ? "节点" : "nodes"}</span>
                : service && !online(report) ? <span className="composer-reference-meta">{busy ? zh ? "读取中" : "Reading" : zh ? "已配置" : "Configured"}</span>
                : null}
            </button>
            {service && <button type="button" className="composer-reference-drill" onClick={() => enter(row)} aria-label={zh ? "展开 " + item.name + " 工具" : "Show " + item.name + " tools"}>
                {report?.toolCount !== undefined && report.toolCount + " "}{zh ? "工具" : "Tools"}<ChevronRight size={14} aria-hidden />
              </button>}
          </div>;
        })}
        {!rows.length && <p className="composer-reference-empty" role="status">
          {drill && !drillReport ? (zh ? "正在读取工具列表…" : "Checking the tool list…")
            : drillReport && !online(drillReport) ? (zh ? "当前会话的连接还没有返回工具清单。可以返回引用整个服务。" : "The current connection has not reported its tools. You can go back and reference the entire server.")
            : resourceError ? (zh ? "无法读取当前 Harness 的能力" : "Could not read this harness’s resources")
            : capabilities && capabilityScope && !resources ? (zh ? "正在读取能力…" : "Loading capabilities…")
            : (zh ? "没有匹配的引用" : "No matching references")}
        </p>}
      </div>
      <div className="composer-reference-footer">{zh ? "↑↓ 选择 · Tab 切分类 · → 展开 MCP 工具 · Enter 引用 · Esc 关闭" : "↑↓ Select · Tab Category · → MCP tools · Enter Attach · Esc Close"}</div>
    </div>
  );
  return { open, query, menu, id, activeId, update, close, keyDown };
}

export function ReferencePills({ items, onRemove }: {
  items: Choice[]; onRemove?: (item: Choice) => void;
}) {
  const zh = useI18n().locale === "zh-CN";
  const capabilities = useProviderToolsStore(state => state.tools);
  if (!items.length) return null;
  return <div className={onRemove ? "composer-reference-strip" : "message-reference-strip"}>
    {items.map(item => {
      const title = item.kind === "workflow" ? item.name + " · v" + item.revision : capabilities.find(value => value.id === item.id)?.description || label(item);
      const contents = <><ReferenceIcon item={item} /><span>{label(item)}</span>
        {item.kind === "skill" && item.temporary && <small>{zh ? "临时" : "This turn"}</small>}</>;
      return onRemove ? <span className="composer-context-pill" data-kind={item.kind} key={referenceKey(item)} title={title}>{contents}
        <button type="button" aria-label={zh ? item.kind === "workflow" ? "移除工作流引用" : "移除 " + label(item) : "Remove " + label(item)}
          onClick={() => onRemove(item)}><X size={12} aria-hidden /></button>
      </span> : <Link className="composer-context-pill" data-kind={item.kind} key={referenceKey(item)} title={title}
        to={referenceHref(item)}>{contents}</Link>;
    })}
  </div>;
}
