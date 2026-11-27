import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChartNoAxesColumn,
  FileDiff,
  GitBranch,
  GitFork,
  Globe,
  LayoutGrid,
  ListChecks,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  Search,
  SquareTerminal,
  Users,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { ResizeHandle, useRememberedWidth } from "../../components/ui/ResizeHandle";
import { useI18n } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { DockEmbedContext } from "./WorkspaceDrawer";
import "./session-side-dock.css";

export type DockTabKind =
  | "artifacts"
  | "source-control"
  | "terminal"
  | "browser"
  | "workflow"
  | "agents"
  | "tools"
  | "dag";

export type DockActiveTab = DockTabKind | "launcher";

export interface DockToolDescriptor {
  id: DockTabKind;
  label: string;
  description: string;
  icon: LucideIcon;
  shortcut: string;
  available: boolean;
  badge?: string | number;
  tone?: "accent" | "warn" | "ok";
}

/** Top-right floating Quick Overview popover (like reference Image 6) + Inspector & Dock buttons. */
export function SessionHeaderDockControls({
  contextPercent,
  inspectorOpen,
  onToggleInspector,
  dockOpen,
  onToggleDock,
  openTabCount,
  tools,
  onOpenTool,
  todoCount,
  goalsOpen,
  onToggleGoals,
}: {
  contextPercent?: number;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  dockOpen: boolean;
  onToggleDock: () => void;
  openTabCount: number;
  tools: DockToolDescriptor[];
  onOpenTool: (id: DockTabKind) => void;
  todoCount?: number;
  goalsOpen?: boolean;
  onToggleGoals?: () => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 52, right: 16 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({
        top: Math.round(rect.bottom + 8),
        right: Math.max(12, Math.round(window.innerWidth - rect.right)),
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const availableTools = tools.filter(tool => tool.available);
  const hasAttention = availableTools.some(tool => tool.tone || (typeof tool.badge === "number" && tool.badge > 0));

  return (
    <div className="dock-header-controls">
      <button
        type="button"
        className="dock-header-pill"
        aria-pressed={inspectorOpen}
        onClick={onToggleInspector}
        title={zh ? "会话检查器 (C)" : "Conversation inspector (C)"}
        aria-label={zh ? "会话检查器" : "Conversation inspector"}
      >
        <ChartNoAxesColumn size={13} aria-hidden />
        {contextPercent !== undefined ? (
          <span className="dock-ctx-pct" data-high={contextPercent >= 75 || undefined}>
            {Math.round(contextPercent)}%
          </span>
        ) : (
          <span>{zh ? "检查器" : "Inspect"}</span>
        )}
      </button>

      {onToggleGoals && (
        <button
          type="button"
          className="dock-header-icon"
          data-activity="goals"
          aria-pressed={goalsOpen}
          onClick={onToggleGoals}
          title={zh ? "会话目标 (L)" : "Goals (L)"}
          aria-label={zh ? "会话目标" : "Goals"}
        >
          <ListChecks size={14} aria-hidden />
          {todoCount !== undefined && todoCount > 0 && <span className="dock-mini-badge">{todoCount}</span>}
        </button>
      )}

      <div className="dock-overview-anchor">
        <button
          ref={triggerRef}
          type="button"
          className="dock-header-icon"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen(v => !v)}
          title={zh ? "工作区面板 · 快速打开" : "Workspace panels"}
          aria-label={zh ? "工作区面板" : "Workspace panels"}
        >
          <LayoutGrid size={14} aria-hidden />
          {hasAttention && <span className="dock-header-dot" aria-hidden />}
        </button>
        {createPortal(
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                ref={popoverRef}
                role="menu"
                className="dock-overview-popover"
                style={{ top: menuPos.top, right: menuPos.right }}
                initial={reduced ? false : { opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="dock-overview-head">
                  <span>{zh ? "工作区面板" : "Workspace panels"}</span>
                  <small>{zh ? "在右侧多窗口打开" : "Open in right pane"}</small>
                </div>
                <div className="dock-overview-list">
                  {availableTools.map(tool => {
                    const Icon = tool.icon;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        role="menuitem"
                        className="dock-overview-item"
                        onClick={() => {
                          setMenuOpen(false);
                          onOpenTool(tool.id);
                        }}
                      >
                        <Icon size={14} aria-hidden />
                        <span className="dock-overview-label">{tool.label}</span>
                        {tool.badge !== undefined && (
                          <span className="dock-overview-badge" data-tone={tool.tone}>
                            {tool.badge}
                          </span>
                        )}
                        {tool.tone && tool.badge === undefined && (
                          <span className="dock-overview-dot" data-tone={tool.tone} aria-hidden />
                        )}
                        <kbd>{tool.shortcut}</kbd>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
      </div>

      <button
        type="button"
        className="dock-header-icon"
        aria-pressed={dockOpen}
        onClick={onToggleDock}
        title={dockOpen ? (zh ? "收起右侧工作区" : "Close side workspace") : (zh ? "展开右侧工作区" : "Open side workspace")}
        aria-label={dockOpen ? (zh ? "收起右侧工作区" : "Close side workspace") : (zh ? "展开右侧工作区" : "Open side workspace")}
      >
        <PanelRight size={14} aria-hidden />
        {!dockOpen && openTabCount > 0 && <span className="dock-mini-badge">{openTabCount}</span>}
      </button>
    </div>
  );
}

/** Unified Multi-Tab Right Workspace Pane (like Antigravity reference Images 3 & 4). */
export function SessionSideDock({
  open,
  tabs,
  activeTab,
  tools,
  onSelectTab,
  onCloseTab,
  onOpenTool,
  onOpenLauncher,
  onCloseDock,
  renderTabContent,
}: {
  open: boolean;
  tabs: DockTabKind[];
  activeTab: DockActiveTab;
  tools: DockToolDescriptor[];
  onSelectTab: (tab: DockActiveTab) => void;
  onCloseTab: (tab: DockTabKind) => void;
  onOpenTool: (tab: DockTabKind) => void;
  onOpenLauncher: () => void;
  onCloseDock: () => void;
  renderTabContent: (tab: DockTabKind, active: boolean) => ReactNode;
}): JSX.Element | null {
  const zh = useI18n().locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const paneRef = useRef<HTMLElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth);
  const [launcherQuery, setLauncherQuery] = useState("");
  const launcherInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const parent = paneRef.current?.parentElement;
    if (!parent) return;
    const measure = (): void => { if (parent.clientWidth) setAvailableWidth(parent.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (open && activeTab === "launcher") {
      setLauncherQuery("");
      requestAnimationFrame(() => launcherInputRef.current?.focus());
    }
  }, [open, activeTab]);

  const maxWidth = Math.max(420, availableWidth - 360);
  const remembered = useRememberedWidth("nautilo.session.sidedock.width", 660, 380, maxWidth);
  const toolById = new Map(tools.map(item => [item.id, item]));
  const availableTools = tools.filter(item => item.available);
  const needle = launcherQuery.trim().toLowerCase();
  const launcherTools = availableTools.filter(item =>
    !needle || `${item.label} ${item.description} ${item.id}`.toLowerCase().includes(needle),
  );

  if (!open) return null;

  return (
    <aside
      ref={paneRef}
      className={`session-side-dock${maximized ? " is-maximized" : ""}`}
      style={{ width: maximized ? "100%" : Math.min(remembered.width, maxWidth) }}
      aria-label={zh ? "右侧多标签工作区" : "Right workspace pane"}
    >
      {!maximized && (
        <ResizeHandle
          label={zh ? "调整右侧工作区宽度" : "Resize side workspace"}
          edge="left"
          value={remembered.width}
          min={380}
          max={maxWidth}
          onChange={remembered.resize}
          onCommit={remembered.save}
          reset={660}
        />
      )}

      <header className="dock-tabbar">
        <div className="dock-tabs-scroll" role="tablist" aria-label={zh ? "工作区标签" : "Workspace tabs"}>
          {tabs.map(tabId => {
            const meta = toolById.get(tabId);
            if (!meta) return null;
            const Icon = meta.icon;
            const isActive = activeTab === tabId;
            return (
              <div
                key={tabId}
                className="dock-tab"
                data-active={isActive || undefined}
              >
                {isActive && (
                  <motion.span
                    layoutId="dock-tab-active"
                    className="dock-tab-bg"
                    aria-hidden
                    transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 36, mass: 0.8 }}
                  />
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="dock-tab-btn"
                  onClick={() => onSelectTab(tabId)}
                >
                  <Icon size={13} aria-hidden />
                  <span>{meta.label}</span>
                  {meta.badge !== undefined && (
                    <small className="dock-tab-badge" data-tone={meta.tone}>{meta.badge}</small>
                  )}
                  {meta.tone && meta.badge === undefined && (
                    <i className="dock-tab-dot" data-tone={meta.tone} aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  className="dock-tab-close"
                  aria-label={zh ? `关闭 ${meta.label}` : `Close ${meta.label}`}
                  onClick={event => { event.stopPropagation(); onCloseTab(tabId); }}
                >
                  <X size={11} aria-hidden />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="dock-tab-add"
            aria-pressed={activeTab === "launcher"}
            onClick={onOpenLauncher}
            title={zh ? "新建标签页 · 添加面板" : "Open another panel"}
            aria-label={zh ? "新建标签页" : "New tab"}
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>

        <div className="dock-tabbar-actions">
          <button
            type="button"
            className="dock-bar-icon"
            onClick={() => setMaximized(v => !v)}
            title={maximized ? (zh ? "还原分屏" : "Restore split") : (zh ? "最大化右侧工作区" : "Maximize side workspace")}
            aria-label={maximized ? (zh ? "还原" : "Restore") : (zh ? "最大化" : "Maximize")}
          >
            {maximized ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
          </button>
          <button
            type="button"
            className="dock-bar-icon"
            onClick={onCloseDock}
            title={zh ? "收起右侧工作区" : "Close side workspace"}
            aria-label={zh ? "收起右侧工作区" : "Close side workspace"}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>

      <DockEmbedContext.Provider value={true}>
        <div className="dock-stage">
          {tabs.map(tabId => {
            const isActive = activeTab === tabId;
            return (
              <div
                key={tabId}
                className="dock-panel-slot"
                data-active={isActive || undefined}
                hidden={!isActive}
              >
                {renderTabContent(tabId, isActive)}
              </div>
            );
          })}

          {(activeTab === "launcher" || tabs.length === 0) && (
            <div className="dock-launcher">
              <div className="dock-launcher-inner">
                <div className="dock-launcher-search">
                  <Search size={14} aria-hidden />
                  <input
                    ref={launcherInputRef}
                    value={launcherQuery}
                    onChange={event => setLauncherQuery(event.target.value)}
                    placeholder={zh ? "搜索面板或选择要打开的工作区工具…" : "Search panels or choose a workspace tool…"}
                    aria-label={zh ? "搜索面板" : "Search panels"}
                    onKeyDown={event => {
                      if (event.key === "Enter" && launcherTools[0]) {
                        event.preventDefault();
                        onOpenTool(launcherTools[0].id);
                      }
                    }}
                  />
                  {launcherQuery && (
                    <button type="button" onClick={() => setLauncherQuery("")} aria-label={zh ? "清空" : "Clear"}>
                      <X size={13} aria-hidden />
                    </button>
                  )}
                </div>

                <div className="dock-launcher-list" role="list">
                  {launcherTools.map(tool => {
                    const Icon = tool.icon;
                    const alreadyOpen = tabs.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className="dock-launcher-row"
                        onClick={() => onOpenTool(tool.id)}
                      >
                        <span className="dock-launcher-icon" aria-hidden>
                          <Icon size={15} />
                        </span>
                        <span className="dock-launcher-copy">
                          <strong>{tool.label}</strong>
                          <small>{tool.description}</small>
                        </span>
                        {tool.badge !== undefined && (
                          <span className="dock-overview-badge" data-tone={tool.tone}>{tool.badge}</span>
                        )}
                        {alreadyOpen && (
                          <span className="dock-launcher-open-tag">{zh ? "已打开" : "Open"}</span>
                        )}
                        <kbd>{tool.shortcut}</kbd>
                      </button>
                    );
                  })}
                  {!launcherTools.length && (
                    <p className="dock-launcher-empty">{zh ? "没有匹配的面板" : "No matching panels"}</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </DockEmbedContext.Provider>
    </aside>
  );
}

/** Shared icon mapping helper exported for SessionWorkbench. */
export const DOCK_TOOL_ICONS = {
  artifacts: FileDiff,
  "source-control": GitBranch,
  terminal: SquareTerminal,
  browser: Globe,
  workflow: Workflow,
  agents: Users,
  tools: Wrench,
  dag: GitFork,
} as const;
