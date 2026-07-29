import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Languages, Bell, Lock, Monitor, Moon, Palette, Plus, Rows3, Sparkles, Sun, TextQuote, Trash2 } from "lucide-react";
import { getBridge, isElectron } from "../../lib/bridge";
import { useI18n, type MessageKey } from "../../lib/i18n";
import type { AppInfo } from "../../types/bridge";
import { PageHeader } from "../../components/layout/AppShell";
import { MotionCard, StaggerGroup } from "../../components/ui/Card";
import { RadioCardGroup } from "../../components/ui/RadioGroup";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { useSettingsStore, PINNED_NAV_KEYS, TOGGLABLE_NAV_KEYS } from "../../stores/settings";
import { newId } from "../../lib/utils";
import { NAV_ENTRIES } from "../../components/layout/nav";
import type { ThemePreference } from "../../lib/types";
import { SectionHeader } from "./parts";
import { RuntimeOperationsCard } from "./RuntimeOperationsCard";
import { PermissionPolicyCard } from "./PermissionPolicyCard";

function Section({
  icon,
  title,
  description,
  children,
  className
}: {
  icon: typeof Palette;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <MotionCard className={`card-glow ${className ?? ""}`}>
      <div className="p-5">
        <SectionHeader icon={icon} title={title} description={description} className="mb-4" />
        {children}
      </div>
    </MotionCard>
  );
}

/** Small group divider that chunks the page into scannable bands. */
function GroupLabel({ label }: { label: string }): JSX.Element {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 14 },
        show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 26 } }
      }}
      className="mt-2 flex items-center gap-3 lg:col-span-2"
    >
      <span className="text-xs font-semibold tracking-[0.2em] text-ink-3">{label}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-line-strong via-line to-transparent" aria-hidden />
    </motion.div>
  );
}

function MiniChrome({ dark }: { dark: boolean }): JSX.Element {
  const line = dark ? "bg-white/25" : "bg-black/25";
  const faint = dark ? "bg-white/10" : "bg-black/10";
  return (
    <div className={`flex h-full w-full flex-col gap-1.5 rounded-md p-2 ${dark ? "bg-[#0d1017]" : "bg-[#f2f4f9]"}`}>
      <div className="flex gap-1">
        <span className={`h-1 w-1 rounded-full ${line}`} />
        <span className={`h-1 w-1 rounded-full ${line}`} />
        <span className={`h-1 w-1 rounded-full ${line}`} />
      </div>
      <div className="flex flex-1 gap-1.5">
        <div className={`w-1/4 rounded-sm ${faint}`} />
        <div className="flex-1 space-y-1 pt-0.5">
          <div className={`h-1.5 w-2/3 rounded-full ${line}`} />
          <div className={`h-1.5 w-1/2 rounded-full ${faint}`} />
          <div className={`h-1.5 w-3/5 rounded-full ${faint}`} />
        </div>
      </div>
    </div>
  );
}

function ThemePreview({ variant }: { variant: "dark" | "light" | "system" }): JSX.Element {
  if (variant === "system") {
    return (
      <div className="flex h-20 w-full gap-1 overflow-hidden rounded-lg border border-line" aria-hidden>
        <MiniChrome dark />
        <MiniChrome dark={false} />
      </div>
    );
  }
  const dark = variant === "dark";
  return (
    <div
      aria-hidden
      className={`h-20 w-full rounded-lg border ${dark ? "border-white/10" : "border-black/10"}`}
    >
      <MiniChrome dark={dark} />
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const { t } = useI18n();
  const theme = useSettingsStore((state) => state.theme);
  const locale = useSettingsStore((state) => state.locale);
  const reduceMotion = useSettingsStore((state) => state.reduceMotion);
  const hiddenNav = useSettingsStore((state) => state.hiddenNav);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const setLocale = useSettingsStore((state) => state.setLocale);
  const setReduceMotion = useSettingsStore((state) => state.setReduceMotion);
  const setNavVisible = useSettingsStore((state) => state.setNavVisible);
  const notificationsEnabled = useSettingsStore((state) => state.notificationsEnabled);
  const notificationSound = useSettingsStore((state) => state.notificationSound);
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled);
  const setNotificationSound = useSettingsStore((state) => state.setNotificationSound);
  const promptSnippets = useSettingsStore((state) => state.promptSnippets);
  const upsertSnippet = useSettingsStore((state) => state.upsertSnippet);
  const removeSnippet = useSettingsStore((state) => state.removeSnippet);

  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  useEffect(() => {
    const bridge = getBridge();
    if (bridge) void bridge.getAppInfo().then(setAppInfo);
  }, []);

  return (
    <>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      <StaggerGroup className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GroupLabel label={t("settings.groups.preferences")} />

        <Section icon={Palette} title={t("settings.appearance.title")} description={t("settings.appearance.desc")}>
          <RadioCardGroup
            aria-label={t("settings.appearance.title")}
            value={theme}
            onValueChange={(value) => setTheme(value as ThemePreference)}
            items={[
              {
                value: "dark",
                label: t("settings.appearance.dark"),
                preview: <ThemePreview variant="dark" />
              },
              {
                value: "light",
                label: t("settings.appearance.light"),
                preview: <ThemePreview variant="light" />
              },
              {
                value: "system",
                label: t("settings.appearance.system"),
                preview: <ThemePreview variant="system" />
              }
            ]}
          />
        </Section>

        <div className="flex flex-col gap-4">
          <Section icon={Languages} title={t("settings.language.title")} description={t("settings.language.desc")}>
            <SelectField
              aria-label={t("settings.language.title")}
              value={locale}
              onValueChange={(value) => setLocale(value as "zh-CN" | "en-US")}
              options={[
                { value: "zh-CN", label: t("settings.language.zh") },
                { value: "en-US", label: t("settings.language.en") }
              ]}
            />
          </Section>

          <Section
            icon={Sparkles}
            title={t("settings.motion.title")}
            description={t("settings.motion.desc")}
          >
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover/40 px-3.5 py-3">
              <span className="text-sm text-ink-2">{t("settings.motion.reduce")}</span>
              <Switch
                checked={reduceMotion}
                onCheckedChange={setReduceMotion}
                aria-label={t("settings.motion.reduce")}
              />
            </div>
          </Section>

          <Section
            icon={Bell}
            title={t("settings.notifications.title")}
            description={t("settings.notifications.desc")}
            className="flex-1"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover/40 px-3.5 py-3">
                <span className="text-sm text-ink-2">{t("settings.notifications.enabled")}</span>
                <Switch
                  checked={notificationsEnabled}
                  onCheckedChange={setNotificationsEnabled}
                  aria-label={t("settings.notifications.enabled")}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover/40 px-3.5 py-3">
                <span className="text-sm text-ink-2">{t("settings.notifications.sound")}</span>
                <Switch
                  checked={notificationSound}
                  onCheckedChange={setNotificationSound}
                  disabled={!notificationsEnabled}
                  aria-label={t("settings.notifications.sound")}
                />
              </div>
            </div>
          </Section>
        </div>

        <Section
          icon={Rows3}
          title={t("settings.nav.title")}
          description={t("settings.nav.desc")}
          className="lg:col-span-2"
        >
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {NAV_ENTRIES.map((entry) => {
              const Icon = entry.icon;
              const pinned = PINNED_NAV_KEYS.includes(entry.key);
              const visible = pinned || !hiddenNav.includes(entry.key);
              return (
                <li
                  key={entry.key}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover/40 px-3.5 py-3 transition-colors hover:border-line-strong"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                    <span className="truncate text-sm text-ink-2">
                      {t(`nav.${entry.key}` as MessageKey)}
                    </span>
                    {pinned && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-line/50 px-1.5 py-0.5 text-[11px] text-ink-3">
                        <Lock className="h-3 w-3" aria-hidden />
                        {t("settings.nav.locked")}
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={visible}
                    disabled={pinned}
                    onCheckedChange={(checked) => setNavVisible(entry.key, checked)}
                    aria-label={t(`nav.${entry.key}` as MessageKey)}
                  />
                </li>
              );
            })}
          </ul>
        </Section>

        <GroupLabel label={t("settings.groups.system")} />

        <Section
          icon={TextQuote}
          title={t("settings.snippets.title")}
          description={t("settings.snippets.desc")}
          className="lg:col-span-2"
        >
          <div className="flex flex-col gap-2">
            {promptSnippets.length === 0 && (
              <p className="px-1 py-2 text-xs text-ink-3">{t("settings.snippets.empty")}</p>
            )}
            {promptSnippets.map((snippet) => (
              <div key={snippet.id} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-line bg-card-hover/40 px-3.5 py-3 sm:grid-cols-[minmax(140px,0.32fr)_1fr_32px]">
                <input
                  value={snippet.title}
                  onChange={(event) => upsertSnippet({ ...snippet, title: event.target.value })}
                  placeholder={t("settings.snippets.titlePlaceholder")}
                  aria-label={t("settings.snippets.titlePlaceholder")}
                  className="h-8 min-w-0 rounded-lg border border-line bg-card px-2.5 text-sm text-ink outline-none focus:border-accent/50"
                />
                <input
                  value={snippet.text}
                  onChange={(event) => upsertSnippet({ ...snippet, text: event.target.value })}
                  placeholder={t("settings.snippets.textPlaceholder")}
                  aria-label={t("settings.snippets.textPlaceholder")}
                  className="h-8 min-w-0 rounded-lg border border-line bg-card px-2.5 text-sm text-ink outline-none focus:border-accent/50"
                />
                <button
                  type="button"
                  onClick={() => removeSnippet(snippet.id)}
                  aria-label={t("settings.snippets.remove")}
                  title={t("settings.snippets.remove")}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                onClick={() => upsertSnippet({ id: newId("snip"), title: "", text: "" })}
                className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-card-hover hover:text-ink"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t("settings.snippets.add")}
              </button>
            </div>
          </div>
        </Section>

        <RuntimeOperationsCard />
        <PermissionPolicyCard />

        <Section icon={isElectron ? Monitor : Sun} title={t("settings.about.title")} className="lg:col-span-2">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
              <dt className="text-ink-3">{t("settings.about.appVersion")}</dt>
              <dd className="font-mono text-ink-2">{appInfo?.version ?? "0.1.0"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
              <dt className="text-ink-3">{t("settings.about.mode")}</dt>
              <dd className="text-ink-2">
                {isElectron ? t("settings.about.modeElectron") : t("settings.about.modeBrowser")}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
              <dt className="text-ink-3">{t("settings.about.runtime")}</dt>
              <dd className="font-mono text-ink-2">
                {appInfo ? `Electron ${appInfo.electron} · Chromium ${appInfo.chrome}` : "—"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
              <dt className="text-ink-3">{t("settings.about.platform")}</dt>
              <dd className="font-mono text-ink-2">
                {appInfo ? `${appInfo.platform} ${appInfo.arch}` : "—"}
              </dd>
            </div>
          </dl>
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-ink-3">
            <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("settings.about.dataNote")}
          </p>
        </Section>
      </StaggerGroup>
    </>
  );
}
