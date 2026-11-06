import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Box,
  ChevronRight,
  Folder,
  HelpCircle,
  Layers,
  Server,
  Puzzle,
  Monitor,
  Plus,
  RotateCcw,
  Settings2,
  Shield,
  SlidersHorizontal,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { useI18n, type MessageKey } from "../../lib/i18n";
import type { AppInfo } from "../../types/bridge";
import { Button } from "../../components/ui/Button";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { Tooltip } from "../../components/ui/Tooltip";
import { useSettingsStore } from "../../stores/settings";
import { useSessionsStore } from "../../stores/sessions";
import { cn, newId } from "../../lib/utils";
import { NAV_ENTRIES } from "../../components/layout/nav";
import { listThemes, SYSTEM_THEME_ID } from "../../lib/themes";
import { HarnessPanel } from "../agents/HarnessPanel";
import { TeamsPage } from "../teams/TeamsPage";
import { TeamEditorPage } from "../teams/TeamEditorPage";
import { ProvidersPanel } from "../agents/ProvidersPanel";
import { ProviderToolsPanel } from "../agents/ProviderToolsPanel";
import { PluginMarketPanel } from "../agents/PluginMarketPanel";
import { RuntimeOperationsCard } from "./RuntimeOperationsCard";
import { PermissionPolicyCard } from "./PermissionPolicyCard";
import { UsagePanel } from "./UsagePanel";
import { ConnectionsPanel } from "./ConnectionsPanel";

type SettingsSection =
  | "teams"
  | "accounts"
  | "usage"
  | "general"
  | "appearance"
  | "agents"
  | "skills"
  | "mcp"
  | "plugins"
  | "permissions"
  | "notifications"
  | "advanced";
const SECTIONS: Array<{
  id: SettingsSection;
  zh: string;
  en: string;
  icon: LucideIcon;
}> = [
  { id: "general", zh: "通用", en: "General", icon: Settings2 },
  { id: "appearance", zh: "外观", en: "Appearance", icon: Monitor },
  { id: "agents", zh: "Harness 管理", en: "Harnesses", icon: Box },
  { id: "accounts", zh: "供应商与账号", en: "Providers & accounts", icon: Users },
  { id: "usage", zh: "用量与费用", en: "Usage & costs", icon: BarChart3 },
  { id: "teams", zh: "团队管理", en: "Teams", icon: Users },
  { id: "skills", zh: "Skills 技能", en: "Skills", icon: Layers },
  { id: "mcp", zh: "MCP 服务", en: "MCP servers", icon: Server },
  { id: "plugins", zh: "插件", en: "Plugins", icon: Puzzle },
  { id: "permissions", zh: "权限与安全", en: "Permissions", icon: Shield },
  {
    id: "notifications",
    zh: "通知与快捷指令",
    en: "Notifications & shortcuts",
    icon: Bell,
  },
  { id: "advanced", zh: "高级", en: "Advanced", icon: SlidersHorizontal },
];

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <span className="settings-row-label">{label}</span>
        {help && <p className="settings-row-description">{help}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingsLink({
  to,
  label,
  icon: Icon = ChevronRight,
}: {
  to: string;
  label: string;
  icon?: LucideIcon;
}): JSX.Element {
  return (
    <Link
      to={to}
      className="settings-link flex items-center gap-3 text-sm text-ink outline-none hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Icon className="h-4 w-4 text-ink-3" aria-hidden />
      <span className="flex-1">{label}</span>
      <ChevronRight className="h-4 w-4 text-ink-3" aria-hidden />
    </Link>
  );
}

export function SettingsPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const activeSession = useSessionsStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId),
  );
  // Capture the caller once: category navigation must not replace the return destination.
  const requestedReturnTo: unknown = location.state?.returnTo;
  const returnTo = useRef(
    typeof requestedReturnTo === "string" &&
      requestedReturnTo.startsWith("/") &&
      !requestedReturnTo.startsWith("//") &&
      !requestedReturnTo.startsWith("/settings")
      ? requestedReturnTo
      : activeSession?.mode === "work"
        ? "/work"
        : activeSession
          ? "/sessions"
          : "/sessions?new=1",
  ).current;
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("section");
  const section: SettingsSection =
    requested === "plugins" || SECTIONS.some((item) => item.id === requested)
      ? (requested as SettingsSection)
      : "general";
  const activeGroup = section;
  const settings = useSettingsStore();
  const {
    theme,
    customThemes,
    locale,
    reduceMotion,
    hiddenNav,
    setTheme,
    setLocale,
    setReduceMotion,
    setNavVisible,
    notificationsEnabled,
    notificationSound,
    setNotificationsEnabled,
    setNotificationSound,
    promptSnippets,
    upsertSnippet,
    removeSnippet,
    setOnboardingCompleted,
  } = settings;
  const zh = locale === "zh-CN";
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const contentRef = useRef<HTMLDivElement>(null);
  // Keep the policy editor alive across categories so unsaved rules are not lost.
  const permissionsVisited = useRef(section === "permissions");
  if (section === "permissions") permissionsVisited.current = true;
  const activeItem = SECTIONS.find((item) => item.id === activeGroup)!;
  const chooseSection = (id: SettingsSection): void => {
    const next = new URLSearchParams(searchParams);
    next.set("section", id);
    setSearchParams(next, { state: { ...location.state, returnTo } });
  };

  useEffect(() => {
    let alive = true;
    const bridge = getBridge();
    if (bridge)
      void bridge
        .getAppInfo()
        .then((info) => {
          if (alive) setAppInfo(info);
        })
        .catch(() => {
          /* unavailable runtime info is displayed as a dash */
        });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const basicThemes = [
    { id: "light", label: zh ? "浅色" : "Light" },
    { id: "dark", label: zh ? "深色" : "Dark" },
    { id: SYSTEM_THEME_ID, label: zh ? "系统" : "System" },
  ];
  const advancedThemes = listThemes(customThemes).filter(
    (item) => !basicThemes.some((basic) => basic.id === item.id),
  );
  const isCustomTheme = !basicThemes.some((item) => item.id === theme);

  return (
    <div className="settings-layout flex h-full min-h-0 w-full overflow-hidden bg-panel" data-section={section}>
      <aside className="settings-sidebar flex w-[220px] shrink-0 flex-col border-r border-line px-3 py-4 max-[760px]:w-[176px] max-[560px]:w-[60px] max-[560px]:px-2">
        <button
          type="button"
          onClick={() => navigate(returnTo)}
          className="mb-6 flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm text-ink-2 outline-none hover:bg-card-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent max-[560px]:justify-center max-[560px]:px-0"
          aria-label={zh ? "返回工作台" : "Back to chat"}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          <span className="max-[560px]:hidden">
            {zh ? "返回工作台" : "Back to chat"}
          </span>
        </button>
        <nav
          aria-label={zh ? "设置分类" : "Settings sections"}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto"
        >
          {SECTIONS.map(({ id, zh: chinese, en, icon: Icon }) => (
            <Fragment key={id}>
              {id === "general" && <p className="settings-nav-group">{zh ? "设置" : "Settings"}</p>}
              {id === "agents" && <p className="settings-nav-group">{zh ? "功能" : "Features"}</p>}
              {id === "permissions" && <p className="settings-nav-group">{zh ? "系统与安全" : "System & security"}</p>}
              <Tooltip content={zh ? chinese : en} side="right">
              <button
                type="button"
                onClick={() => chooseSection(id)}
                aria-current={activeGroup === id ? "page" : undefined}
                aria-label={zh ? chinese : en}
                className={cn(
                  "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent max-[560px]:justify-center max-[560px]:px-0",
                  activeGroup === id
                    ? "bg-card-hover font-medium text-ink"
                    : "text-ink-2 hover:bg-card-hover/70 hover:text-ink",
                )}
              >
                <Icon
                  className="h-4 w-4 shrink-0"
                  strokeWidth={1.7}
                  aria-hidden
                />
                <span className="max-[560px]:hidden">{zh ? chinese : en}</span>
              </button>
              </Tooltip>
            </Fragment>
          ))}
        </nav>
      </aside>
      <div
        ref={contentRef}
        className="settings-content min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-card px-8 py-10 max-[760px]:px-5 max-[560px]:px-4"
      >
        <div
          className={cn(
            "settings-content-inner mx-auto w-full",
            ["agents", "accounts", "skills", "mcp", "plugins", "permissions", "advanced", "usage", "teams"].includes(
              section,
            )
              ? "max-w-[1000px]"
              : "max-w-[760px]",
          )}
        >
          <h1 className="mb-8 text-[25px] font-semibold tracking-tight text-ink outline-none">
            {zh ? activeItem.zh : activeItem.en}
          </h1>

          {section === "usage" && <div className="settings-panel-card"><UsagePanel /></div>}

          {section === "general" && (
            <>
              <div className="settings-card">
              <Row label={t("settings.language.title")}>
                <div className="w-44">
                  <SelectField
                    aria-label={t("settings.language.title")}
                    value={locale}
                    onValueChange={(value) =>
                      setLocale(value as "zh-CN" | "en-US")
                    }
                    options={[
                      { value: "zh-CN", label: t("settings.language.zh") },
                      { value: "en-US", label: t("settings.language.en") },
                    ]}
                  />
                </div>
              </Row>
              <SettingsLink
                to="/projects"
                label={zh ? "项目管理" : "Projects"}
                icon={Folder}
              />
              </div>
              <h2 className="settings-group-heading">{zh ? "应用" : "Application"}</h2>
              <div className="settings-card">
              <Row label={t("settings.about.appVersion")}>
                <span className="text-sm tabular-nums text-ink-2">
                  {appInfo?.version ?? "—"}
                </span>
              </Row>
              <Row label={t("onboarding.replay")}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOnboardingCompleted(false);
                    navigate("/projects");
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  {zh ? "重新开始" : "Restart"}
                </Button>
              </Row>
              </div>
              <details className="settings-card settings-disclosure">
                <summary className="cursor-pointer text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {t("settings.nav.title")}
                </summary>
                <div className="mt-3">
                  {NAV_ENTRIES.filter(
                    (entry) =>
                      entry.key === "tasks" || entry.key === "sessions",
                  ).map((entry) => (
                    <Row
                      key={entry.key}
                      label={t(`nav.${entry.key}` as MessageKey)}
                    >
                      <Switch
                        checked={!hiddenNav.includes(entry.key)}
                        onCheckedChange={(checked) =>
                          setNavVisible(entry.key, checked)
                        }
                        aria-label={t(`nav.${entry.key}` as MessageKey)}
                      />
                    </Row>
                  ))}
                </div>
              </details>
            </>
          )}

          {section === "appearance" && (
            <>
              <div className="settings-card">
              <Row label={zh ? "主题" : "Theme"}>
                <div
                  className="flex rounded-lg bg-panel p-1"
                  role="group"
                  aria-label={t("settings.appearance.title")}
                >
                  {basicThemes.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={theme === item.id}
                      onClick={() => setTheme(item.id)}
                      className={cn(
                        "min-w-[76px] rounded-md px-4 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                        theme === item.id
                          ? "bg-card text-ink shadow-sm ring-1 ring-line"
                          : "text-ink-2 hover:text-ink",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </Row>
              <Row
                label={t("settings.motion.reduce")}
                help={t("settings.motion.desc")}
              >
                <Switch
                  checked={reduceMotion}
                  onCheckedChange={setReduceMotion}
                  aria-label={t("settings.motion.reduce")}
                />
              </Row>
              </div>
              {advancedThemes.length > 0 && (
                <details
                  open={isCustomTheme || undefined}
                  className="settings-card settings-disclosure"
                >
                  <summary className="cursor-pointer text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    {zh ? "更多主题" : "More themes"}
                  </summary>
                  <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {advancedThemes.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setTheme(item.id)}
                        aria-pressed={theme === item.id}
                        className={cn(
                          "rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                          theme === item.id
                            ? "border-ink"
                            : "border-line hover:border-line-strong",
                        )}
                      >
                        <div
                          aria-hidden
                          className="mb-3 flex h-14 gap-2 rounded-md p-2"
                          style={{ background: item.preview.bg }}
                        >
                          <div
                            className="w-1/4 rounded"
                            style={{ background: item.preview.faint }}
                          />
                          <div className="flex-1 space-y-1.5 pt-1">
                            <div
                              className="h-1.5 w-2/3 rounded"
                              style={{ background: item.preview.line }}
                            />
                            <div
                              className="h-1.5 w-1/2 rounded"
                              style={{ background: item.preview.faint }}
                            />
                          </div>
                        </div>
                        <span className="text-[13px] text-ink">
                          {item.name[locale] ?? item.name["en-US"]}
                        </span>
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          {section === "accounts" && <div className="settings-panel-card"><ConnectionsPanel /></div>}

          {section === "agents" && <div className="settings-panel-card"><HarnessPanel /></div>}
          {section === "teams" && <div className="settings-panel-card">{searchParams.get("team") ? <TeamEditorPage teamIdOverride={searchParams.get("team")!} backTo="/settings?section=teams" /> : <TeamsPage embedded />}</div>}

          {(section === "skills" || section === "mcp") && (
            <div className="settings-panel-card">
              <ProviderToolsPanel kind={section === "skills" ? "skill" : "mcp"} />
            </div>
          )}
          {section === "plugins" && <PluginMarketPanel />}

          {permissionsVisited.current && (
            <div className="settings-panel-card" hidden={section !== "permissions"}>
              <PermissionPolicyCard />
            </div>
          )}

          {section === "notifications" && (
            <>
              <div className="settings-card">
              <Row
                label={t("settings.notifications.enabled")}
                help={t("settings.notifications.desc")}
              >
                <Switch
                  checked={notificationsEnabled}
                  onCheckedChange={setNotificationsEnabled}
                  aria-label={t("settings.notifications.enabled")}
                />
              </Row>
              <Row label={t("settings.notifications.sound")}>
                <Switch
                  checked={notificationSound}
                  onCheckedChange={setNotificationSound}
                  disabled={!notificationsEnabled}
                  aria-label={t("settings.notifications.sound")}
                />
              </Row>
              </div>
              <div className="settings-card settings-snippets">
                <h2 className="mb-5 flex items-center justify-between text-sm font-medium text-ink">
                  <span className="flex items-center gap-2">
                    {t("settings.snippets.title")}
                    <Tooltip content={t("settings.snippets.desc")}>
                      <button
                        type="button"
                        aria-label={t("settings.snippets.desc")}
                        className="rounded text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <HelpCircle className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      upsertSnippet({ id: newId("snip"), title: "", text: "" })
                    }
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    {t("settings.snippets.add")}
                  </Button>
                </h2>
                {promptSnippets.length === 0 && (
                  <p className="py-4 text-sm text-ink-3">
                    {t("settings.snippets.empty")}
                  </p>
                )}
                {promptSnippets.map((snippet) => (
                  <div
                    key={snippet.id}
                    className="grid grid-cols-[1fr_32px] gap-2 border-b border-line py-4 sm:grid-cols-[150px_1fr_32px]"
                  >
                    <input
                      value={snippet.title}
                      onChange={(event) =>
                        upsertSnippet({ ...snippet, title: event.target.value })
                      }
                      placeholder={t("settings.snippets.titlePlaceholder")}
                      aria-label={t("settings.snippets.titlePlaceholder")}
                      className="h-9 min-w-0 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none focus:border-ink-3 max-sm:col-span-2"
                    />
                    <input
                      value={snippet.text}
                      onChange={(event) =>
                        upsertSnippet({ ...snippet, text: event.target.value })
                      }
                      placeholder={t("settings.snippets.textPlaceholder")}
                      aria-label={t("settings.snippets.textPlaceholder")}
                      className="h-9 min-w-0 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none focus:border-ink-3"
                    />
                    <button
                      type="button"
                      onClick={() => removeSnippet(snippet.id)}
                      aria-label={t("settings.snippets.remove")}
                      title={t("settings.snippets.remove")}
                      className="flex h-9 w-8 items-center justify-center rounded-lg text-ink-3 outline-none hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {section === "advanced" && (
            <>
              <div className="settings-card">
                <SettingsLink to="/tasks" label={zh ? "任务" : "Tasks"} />
                <SettingsLink
                  to="/runs"
                  label={zh ? "运行记录" : "Run history"}
                />
                <SettingsLink
                  to="/teams"
                  label={zh ? "团队管理" : "Teams"}
                  icon={Users}
                />
              </div>
              <div className="settings-panel-card settings-runtime"><RuntimeOperationsCard /></div>
              <details className="settings-card settings-disclosure">
                <summary className="cursor-pointer text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {t("settings.about.title")}
                </summary>
                <Row label={t("settings.about.runtime")}>
                  <span className="text-sm text-ink-2">
                    {appInfo
                      ? appInfo.electron.toLowerCase().startsWith("tauri")
                        ? appInfo.electron
                        : appInfo.electron
                          ? `Electron ${appInfo.electron} · Chromium ${appInfo.chrome}`
                          : "—"
                      : "—"}
                  </span>
                </Row>
                <Row label={t("settings.about.platform")}>
                  <span className="text-sm text-ink-2">
                    {appInfo ? `${appInfo.platform} ${appInfo.arch}` : "—"}
                  </span>
                </Row>
                <p className="mt-4 text-sm leading-relaxed text-ink-3">
                  {t("settings.about.dataNote")}
                </p>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
