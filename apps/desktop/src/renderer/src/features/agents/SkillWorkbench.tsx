import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as Drawer from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check, ChevronRight, FolderCode, Layers3, Minus, Plus, Puzzle, Sparkles, Wand2, X } from "lucide-react";
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
import { SkillDetails } from "./SkillDetails";

type Group = { origin: CapabilityOriginKind; items: ProviderCapability[] };
type SetBindings = (items: ProviderCapability[], targets: string[], enabled: boolean) => void;

export function SkillOriginIcon({ kind, size = 15 }: { kind: CapabilityOriginKind; size?: number }): JSX.Element {
  switch (kind) {
    case "builtin": return <Sparkles size={size} strokeWidth={1.8} aria-hidden />;
    case "local": return <FolderCode size={size} strokeWidth={1.8} aria-hidden />;
    case "plugin": return <Puzzle size={size} strokeWidth={1.8} aria-hidden />;
    case "custom": return <Wand2 size={size} strokeWidth={1.8} aria-hidden />;
    default: return <Layers3 size={size} strokeWidth={1.8} aria-hidden />;
  }
}

export function SkillWorkbench({ matrix, showWorkbench, groups, inventory, originNames, ready, providers, providerId, harnessName, busy, setBindings, onEdit, onDelete, onCreate }: {
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
  onEdit: (tool: ProviderCapability, focusDescription?: boolean) => void;
  onDelete: (tool: ProviderCapability) => void;
  onCreate: () => void;
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

  const selected = groups.flatMap(group => group.items).find(tool => tool.id === selectedId) ?? groups[0]?.items[0];
  const visible = groups.flatMap(group => collapsed.has(group.origin) ? [] : group.items);
  const tabStop = visible.find(tool => tool.id === selected?.id) ?? visible[0];
  const focusRow = (id: string) => list.current?.querySelector<HTMLButtonElement>('[data-skill-id="' + CSS.escape(id) + '"]')?.focus();
  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" || !(event.target instanceof HTMLElement)) return;
    const id = event.target.dataset.skillId;
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
        className="skill-inspector-motion"
        initial={reduced ? false : { opacity: 0, y: 7 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -4 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <SkillDetails capability={selected} ready={ready} providers={providers} busy={busy}
          sourceLabel={originNames[capabilityOrigin(selected).kind]}
          onEdit={focusDescription => { setDrawer(false); onEdit(selected, focusDescription); }}
          onDelete={() => { setDrawer(false); onDelete(selected); }}
          onSet={(targets, enabled) => setBindings([selected], targets, enabled)} />
      </motion.div>
    </AnimatePresence>
  );
  const empty = <div className="skill-workbench-empty">
    <span className="skill-empty-icon" aria-hidden><Layers3 size={22} /></span>
    <p>{inventory.length ? t("agents.tools.emptyFiltered") : (zh ? "暂无技能" : "No skills yet")}</p>
    {!inventory.length && <Button variant="primary" size="sm" disabled={busy} onClick={onCreate}><Plus size={14} />{zh ? "添加 Skill" : "Add Skill"}</Button>}
  </div>;

  return <div className="skill-view" ref={surface} aria-busy={busy}>
    <AnimatePresence mode="wait" initial={false}>
    {matrix ? (
      <motion.div
        key="matrix-view"
        className="skill-view-stage"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <SkillMatrix groups={groups} inventory={inventory} originNames={originNames} ready={ready} busy={busy}
          select={select} setBindings={setBindings} />
      </motion.div>
    ) : (
      <motion.div
        key="workbench-view"
        className="skill-workbench"
        data-compact={narrow}
        data-empty={!selected}
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -6 }}
        transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {!selected ? empty : <>
          <aside className="skill-workbench-list" ref={list} onKeyDown={move} onPointerMove={onSpotlightMove} aria-label={zh ? "技能库" : "Skill library"}>
            {groups.map(group => {
              const all = inventory.filter(tool => capabilityOrigin(tool).kind === group.origin);
              const enabled = all.filter(tool => capabilityEnabledFor(tool, providerId)).length;
              const isOpen = !collapsed.has(group.origin);
              return <section key={group.origin} className="skill-group-section">
                <div className="skill-group-bar" data-origin={group.origin}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setCollapsed(previous => {
                    const next = new Set(previous);
                    if (next.has(group.origin)) next.delete(group.origin); else next.add(group.origin);
                    return next;
                  })}>
                    <ChevronRight size={13} className="skill-group-chevron" aria-hidden />
                    <span className="skill-group-icon" data-origin={group.origin} aria-hidden><SkillOriginIcon kind={group.origin} size={12} /></span>
                    <strong>{originNames[group.origin]}</strong>
                    <small>{enabled} / {all.length}</small>
                  </button>
                  <div className="skill-group-actions">
                    <button type="button" disabled={busy || !providerId || enabled === all.length}
                      title={zh ? "启用该分组全部技能" : "Enable the entire group"} onClick={() => setBindings(all, [providerId], true)}>{zh ? "全启" : "Enable all"}</button>
                    <button type="button" disabled={busy || !providerId || !enabled}
                      title={zh ? "停用该分组全部技能" : "Disable the entire group"} onClick={() => setBindings(all, [providerId], false)}>{zh ? "全停" : "Disable all"}</button>
                  </div>
                </div>
                <AnimatePresence initial={false}>
                {isOpen && <motion.div
                  className="skill-group-items"
                  initial={reduced ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={reduced ? undefined : { opacity: 0, height: 0 }}
                  transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  {group.items.map((tool, index) => {
                    const origin = capabilityOrigin(tool);
                    const description = capabilityDescription(tool);
                    const active = tool.enabled ? new Set(tool.providerIds).size : 0;
                    const rowEnabled = capabilityEnabledFor(tool, providerId);
                    const current = tool.id === selected.id;
                    const originTag = origin.kind !== "builtin" && origin.label.trim().toLocaleLowerCase() !== tool.name.trim().toLocaleLowerCase() && origin.label;
                    return <div className="skill-workbench-row" key={tool.id} data-selected={current} data-enabled={rowEnabled}
                      style={{ "--skill-row-delay": `${Math.min(index, 12) * 24}ms` } as CSSProperties}>
                      {current && <motion.span
                        layoutId="skill-row-active"
                        className="skill-row-active-bg"
                        aria-hidden
                        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34, mass: 0.85 }}
                      />}
                      <button type="button" className="skill-row-identity" data-skill-id={tool.id} tabIndex={tabStop?.id === tool.id ? 0 : -1} aria-current={current || undefined} onClick={() => select(tool)}>
                        <span className="skill-row-icon" data-origin={origin.kind} aria-hidden>
                          <SkillOriginIcon kind={origin.kind} size={15} />
                          {rowEnabled && <i className="skill-row-active-dot" />}
                        </span>
                        <span className="skill-row-copy">
                          <span className="skill-row-name">
                            <strong title={tool.name}>{tool.name}</strong>
                            {originTag && <span className="skill-origin-tag" title={originTag}>{originTag}</span>}
                            {!description && <span className="skill-missing-tag"><AlertTriangle size={10} aria-hidden />{zh ? "缺说明" : "No description"}</span>}
                          </span>
                          {description && <span className="skill-row-description" title={description}>{description}</span>}
                        </span>
                      </button>
                      {active > 0 && <small className="skill-row-reach" title={zh ? "已启用的 Harness 数" : "Number of enabled Harnesses"}>
                        <i aria-hidden />{active} {zh ? "个" : ""}
                      </small>}
                      <Switch checked={rowEnabled} disabled={busy || !providerId}
                        aria-label={harnessName + " · " + tool.name} onCheckedChange={enabled => setBindings([tool], [providerId], enabled)} />
                    </div>;
                  })}
                </motion.div>}
                </AnimatePresence>
              </section>;
            })}
          </aside>
          {!narrow && <div className="skill-inspector-pane" onPointerMove={onSpotlightMove}>{inspector}</div>}
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
          <div className="skill-drawer-heading"><Drawer.Title>{zh ? "技能详情" : "Skill details"}</Drawer.Title>
            <Drawer.Close aria-label={zh ? "关闭" : "Close"}><X size={17} /></Drawer.Close>
          </div>
          <div className="skill-inspector-pane">{inspector}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>}
  </div>;
}

function SkillMatrix({ groups, inventory, originNames, ready, busy, select, setBindings }: {
  groups: Group[];
  inventory: ProviderCapability[];
  originNames: Record<CapabilityOriginKind, string>;
  ready: ProviderMeta[];
  busy: boolean;
  select: (skill: ProviderCapability) => void;
  setBindings: SetBindings;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const [point, setPoint] = useState<{ row: string; column: string }>();
  const rows = groups.flatMap(group => group.items);
  const columns = ready.map(provider => {
    const id = toDaemonProviderId(provider.id);
    return { provider, id, count: inventory.filter(tool => capabilityEnabledFor(tool, id)).length };
  });
  const total = columns.reduce((sum, column) => sum + column.count, 0);
  if (!columns.length) return <div className="skill-matrix skill-workbench-empty">{zh ? "暂无已就绪的 Harness" : "No ready Harnesses"}</div>;
  return <div className="skill-matrix">
    <div className="skill-matrix-scroll" onPointerLeave={() => setPoint(undefined)}>
      <table style={{ minWidth: 240 + columns.length * 82 }} aria-label={zh ? "多 Harness 启用矩阵" : "Harness enablement matrix"}>
        <colgroup><col className="skill-matrix-name-col" />{columns.map(column => <col key={column.id} data-lit={point?.column === column.id} />)}</colgroup>
        <thead><tr>
          <th scope="col" className="skill-matrix-fixed">{rows.length} {zh ? "项技能" : "skills"}</th>
          {columns.map(({ provider, id, count }) => <th key={id} scope="col" data-lit={point?.column === id}>
            <span className="skill-matrix-harness" title={provider.name}>
              <ProviderAvatar providerId={provider.id} size="sm" /><span>{provider.name.replace(/\s+Harness$/i, "")}</span>
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
          {group.items.map(tool => <tr key={tool.id} data-lit={point?.row === tool.id}>
            <th className="skill-matrix-fixed" scope="row"><button type="button" title={tool.name} onClick={() => select(tool)}>{tool.name}</button></th>
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
          </tr>)}
        </tbody>)}
        {!rows.length && <tbody><tr><td className="skill-matrix-empty" colSpan={columns.length + 1}>{zh ? "没有符合筛选条件的技能" : "No matching skills"}</td></tr></tbody>}
      </table>
    </div>
    <footer><strong>{total} {zh ? "处启用" : "enabled connections"}</strong>
      <span>{zh ? "点单元格切换 · 列头可批量管理" : "Toggle in a cell · Manage a Harness from its column header"}</span></footer>
  </div>;
}
