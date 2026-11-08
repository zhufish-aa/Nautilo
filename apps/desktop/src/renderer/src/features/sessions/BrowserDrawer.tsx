import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  Hand,
  Play,
  Plus,
  X,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import type { BrowserPanelState, BrowserTab } from "../../types/bridge";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

function tabTitle(tab: BrowserTab, blank: string) {
  if (!tab.url || tab.url === "about:blank") return blank;
  return tab.title || tab.url;
}

export function BrowserDrawer({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { locale } = useI18n(),
    zh = locale === "zh-CN";
  const bridge = getBridge()!.browser!;
  const viewport = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("");
  const [state, setState] = useState<BrowserPanelState>({
    manual: false,
    title: "",
    url: "",
    busy: false,
  });
  const addressInput = useRef<HTMLInputElement>(null);
  const visibleTab = useRef<string>();
  const tabStrip = useRef<HTMLDivElement>(null);
  const livePage =
    state.tabs !== undefined
      ? Boolean(state.url && state.url !== "about:blank")
      : state.manual;
  useEffect(() => {
    const selected = tabStrip.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.tabId]);
  const [error, setError] = useState("");
  const editing = useRef(false);
  const generation = useRef(0);
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const version = generation.current;
      try {
        const next = await bridge.panel(sessionId, "state");
        if (!disposed && version === generation.current && next) {
          setState(next);
          if (visibleTab.current !== next.tabId || !editing.current)
            setAddress(next.url === "about:blank" ? "" : next.url);
          visibleTab.current = next.tabId;
        }
      } catch (e) {
        if (!disposed) report(e);
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 900);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      void bridge.panel(sessionId, "hide").catch(() => {});
    };
  }, [bridge, sessionId]);

  useEffect(() => {
    const element = viewport.current;
    if (!livePage || !element) return;
    const update = () => {
      const r = element.getBoundingClientRect();
      const obscured =
        document.hidden ||
        !r.width ||
        !r.height ||
        !!document.querySelector(
          '[aria-modal="true"],[data-radix-popper-content-wrapper],[role="alertdialog"]',
        );
      void bridge
        .panel(sessionId, obscured ? "hide" : "layout", {
          tabId: state.tabId,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        })
        .catch(report);
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const overlays = new MutationObserver(update);
    overlays.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      resize.disconnect();
      overlays.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      void bridge
        .panel(sessionId, "hide", { tabId: state.tabId })
        .catch(() => {});
    };
  }, [livePage, state.tabId, sessionId, bridge]);

  async function command(
    action:
      | "control"
      | "open"
      | "new"
      | "select"
      | "close"
      | "back"
      | "forward"
      | "reload"
      | "zoom",
    value?: unknown,
  ) {
    const version = ++generation.current;
    setError("");
    try {
      const next = await bridge.panel(sessionId, action, value);
      if (version === generation.current && next) {
        setState(next);
        if (!editing.current || visibleTab.current !== next.tabId)
          setAddress(next.url === "about:blank" ? "" : next.url);
        visibleTab.current = next.tabId;
        if (action === "new") addressInput.current?.focus();
      }
    } catch (e) {
      report(e);
    }
  }
  const controlsLabel = state.tabs
    ? state.manual
      ? zh
        ? "恢复 AI 操作"
        : "Resume AI actions"
      : zh
        ? "暂停 AI 操作"
        : "Pause AI actions"
    : state.manual
      ? zh
        ? "交还 AI"
        : "Return to AI"
      : zh
        ? "接管"
        : "Take control";
  const title = zh ? "浏览器" : "Browser";
  return (
    <WorkspaceDrawer
      open
      onClose={onClose}
      title={title}
      className="browser-workspace"
      nativePanel={{ kind: "browser", sessionId }}
      defaultWidth={760}
      minWidth={360}
      adjacentMinWidth={384}
      resizable
      storageKey="nautilo.browser.width"
      headerContent={
        <span className="flex items-center gap-2 text-sm font-medium">
          <Globe size={16} />
          {title}
        </span>
      }
      headerActions={
        <>
          {state.zoomFactor !== undefined && (
            <div className="browser-zoom">
              <button
                type="button"
                className="workspace-panel-icon"
                aria-label={zh ? "缩小网页" : "Zoom out"}
                title={zh ? "缩小网页" : "Zoom out"}
                disabled={state.zoomFactor <= 0.25}
                onClick={() =>
                  void command("zoom", {
                    tabId: state.tabId,
                    factor: Math.max(
                      0.25,
                      Math.round((state.zoomFactor! - 0.25) * 100) / 100,
                    ),
                  })
                }
              >
                <ZoomOut size={14} />
              </button>
              <button
                type="button"
                className="browser-zoom-reset"
                aria-label={zh ? "恢复网页缩放" : "Reset zoom"}
                title={zh ? "恢复到 100%" : "Reset to 100%"}
                onClick={() =>
                  void command("zoom", { tabId: state.tabId, factor: 1 })
                }
              >
                {Math.round(state.zoomFactor * 100)}%
              </button>
              <button
                type="button"
                className="workspace-panel-icon"
                aria-label={zh ? "放大网页" : "Zoom in"}
                title={zh ? "放大网页" : "Zoom in"}
                disabled={state.zoomFactor >= 3}
                onClick={() =>
                  void command("zoom", {
                    tabId: state.tabId,
                    factor: Math.min(
                      3,
                      Math.round((state.zoomFactor! + 0.25) * 100) / 100,
                    ),
                  })
                }
              >
                <ZoomIn size={14} />
              </button>
            </div>
          )}
          {!state.tabs && (
            <button
              type="button"
              className="workspace-panel-icon"
              title={zh ? "关闭此网页" : "Close this page"}
              aria-label={zh ? "关闭此网页" : "Close this page"}
              onClick={() => {
                onClose();
                void bridge.panel(sessionId, "release").catch(report);
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </>
      }
    >
      {state.tabs && (
        <div className="browser-tabs">
          <div
            ref={tabStrip}
            className="browser-tab-strip"
            role="tablist"
            aria-label={zh ? "网页标签" : "Browser tabs"}
          >
            {state.tabs.map((tab) => {
              const label = tabTitle(tab, zh ? "新标签页" : "New tab");
              const selected = tab.id === state.tabId;
              return (
                <div
                  key={tab.id}
                  className="browser-tab"
                  data-selected={selected}
                  data-busy={tab.busy}
                  title={
                    tab.queued
                      ? zh
                        ? `${tab.queued} 个操作等待中`
                        : `${tab.queued} queued operations`
                      : undefined
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className="min-w-0 flex-1 truncate py-1.5 pl-2.5 pr-1 text-left text-xs"
                    title={tab.url || label}
                    onClick={() => void command("select", { tabId: tab.id })}
                  >
                    <Globe size={12} aria-hidden className="tab-icon" />
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-panel-icon shrink-0"
                    title={zh ? "关闭标签页" : "Close tab"}
                    aria-label={(zh ? "关闭标签页 " : "Close tab ") + label}
                    onClick={() => void command("close", { tabId: tab.id })}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="workspace-panel-icon shrink-0"
            title={zh ? "新建标签页" : "New tab"}
            aria-label={zh ? "新建标签页" : "New tab"}
            onClick={() => void command("new")}
          >
            <Plus size={15} />
          </button>
        </div>
      )}
      <div className="browser-navigation">
        {state.tabs && (
          <div className="browser-history">
            {(
              [
                ["back", zh ? "后退" : "Back", ArrowLeft, state.canGoBack],
                [
                  "forward",
                  zh ? "前进" : "Forward",
                  ArrowRight,
                  state.canGoForward,
                ],
                [
                  "reload",
                  zh ? "刷新网页" : "Reload page",
                  RotateCw,
                  !!state.url,
                ],
              ] as const
            ).map(([action, label, Icon, enabled]) => (
              <button
                key={action}
                type="button"
                className="workspace-panel-icon"
                aria-label={label}
                title={label}
                disabled={!enabled}
                onClick={() => void command(action, { tabId: state.tabId })}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        )}
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) {
              const url = /^[a-z][\w+.-]*:\/\//i.test(address)
                ? address.trim()
                : "https://" + address.trim();
              addressInput.current?.blur();
              void command(
                "open",
                state.tabs ? { tabId: state.tabId, url } : url,
              );
            }
          }}
        >
          <input
            ref={addressInput}
            className="min-w-0 flex-1 bg-transparent p-1 text-xs outline-none"
            aria-label={zh ? "网址" : "URL"}
            placeholder="https://"
            value={address}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
            }}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button
            type="submit"
            className="workspace-panel-icon"
            title={zh ? "打开网址" : "Open URL"}
            aria-label={zh ? "打开网址" : "Open URL"}
          >
            <ArrowRight size={14} />
          </button>
        </form>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs"
          aria-label={controlsLabel}
          title={
            state.tabs
              ? zh
                ? "你始终可以操作网页。可在这里暂停或恢复 AI 对此页的操作，AI 仍可读取。"
                : "Pause or resume AI actions on this tab. You can always interact, and AI can still read."
              : undefined
          }
          onClick={() =>
            void command(
              "control",
              state.tabs
                ? { tabId: state.tabId, manual: !state.manual }
                : !state.manual,
            )
          }
        >
          {state.manual ? <Play size={13} /> : <Hand size={13} />}
          <span className="browser-control-label">{controlsLabel}</span>
        </button>
      </div>
      {error && (
        <div role="alert" className="px-3 py-1 text-xs text-danger">
          {error}
        </div>
      )}
      <div
        ref={viewport}
        className="relative min-h-0 flex-1 overflow-hidden bg-surface"
      >
        {!livePage &&
          (state.image ? (
            <img
              src={state.image}
              alt={zh ? "会话网页实时预览" : "Conversation page preview"}
              className="absolute inset-0 h-full w-full object-contain object-top"
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-3">
              {state.url && state.url !== "about:blank"
                ? zh
                  ? "正在加载网页…"
                  : "Loading page…"
                : zh
                  ? "输入网址，或让 AI 打开网页"
                  : "Enter a URL or ask the agent to open a page"}
            </div>
          ))}
      </div>
    </WorkspaceDrawer>
  );
}
