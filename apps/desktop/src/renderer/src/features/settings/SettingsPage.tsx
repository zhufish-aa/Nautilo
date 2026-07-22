import { useEffect, useState } from "react";
import { Languages, Lock, Monitor, Moon, Palette, Rows3, Sparkles, Sun } from "lucide-react";
import { getBridge, isElectron } from "../../lib/bridge";
import { useI18n, type MessageKey } from "../../lib/i18n";
import type { AppInfo } from "../../types/bridge";
import { PageHeader } from "../../components/layout/AppShell";
import { Card } from "../../components/ui/Card";
import { RadioCardGroup } from "../../components/ui/RadioGroup";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { useSettingsStore, PINNED_NAV_KEYS, TOGGLABLE_NAV_KEYS } from "../../stores/settings";
import { NAV_ENTRIES } from "../../components/layout/nav";
import type { ThemePreference } from "../../lib/types";
import { RuntimeOperationsCard } from "./RuntimeOperationsCard";

function Section({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: typeof Palette;
  title: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent-soft text-accent">
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</p>}
        </div>
      </div>
      {children}
    </Card>
  );
}

function ThemePreview({ variant }: { variant: "dark" | "light" | "system" }): JSX.Element {
  if (variant === "system") {
    return (
      <div className="flex h-14 w-full overflow-hidden rounded-lg border border-line" aria-hidden>
        <div className="flex-1 bg-[#0d1017] p-1.5">
          <div className="h-1.5 w-2/3 rounded-full bg-white/25" />
          <div className="mt-1 h-1.5 w-1/2 rounded-full bg-white/10" />
        </div>
        <div className="flex-1 bg-[#f2f4f9] p-1.5">
          <div className="h-1.5 w-2/3 rounded-full bg-black/25" />
          <div className="mt-1 h-1.5 w-1/2 rounded-full bg-black/10" />
        </div>
      </div>
    );
  }
  const dark = variant === "dark";
  return (
    <div
      aria-hidden
      className={`h-14 w-full rounded-lg border p-1.5 ${dark ? "border-white/10 bg-[#0d1017]" : "border-black/10 bg-[#f2f4f9]"}`}
    >
      <div className={`h-1.5 w-2/3 rounded-full ${dark ? "bg-white/25" : "bg-black/25"}`} />
      <div className={`mt-1 h-1.5 w-1/2 rounded-full ${dark ? "bg-white/10" : "bg-black/10"}`} />
      <div className={`mt-1 h-1.5 w-3/5 rounded-full ${dark ? "bg-white/10" : "bg-black/10"}`} />
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

  const [appInfo, setAppInfo] = useState<AppInfo | undefined>();
  useEffect(() => {
    const bridge = getBridge();
    if (bridge) void bridge.getAppInfo().then(setAppInfo);
  }, []);

  return (
    <>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RuntimeOperationsCard />
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

        <div className="space-y-4">
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

          <Section icon={Sparkles} title={t("settings.motion.title")} description={t("settings.motion.desc")}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink-2">{t("settings.motion.reduce")}</span>
              <Switch
                checked={reduceMotion}
                onCheckedChange={setReduceMotion}
                aria-label={t("settings.motion.reduce")}
              />
            </div>
          </Section>
        </div>

        <div className="lg:col-span-2">
          <Section icon={Rows3} title={t("settings.nav.title")} description={t("settings.nav.desc")}>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {NAV_ENTRIES.map((entry) => {
                const Icon = entry.icon;
                const pinned = PINNED_NAV_KEYS.includes(entry.key);
                const visible = pinned || !hiddenNav.includes(entry.key);
                return (
                  <li
                    key={entry.key}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover px-3.5 py-3"
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
        </div>

        <div className="lg:col-span-2">
          <Section icon={isElectron ? Monitor : Sun} title={t("settings.about.title")}>
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
        </div>
      </div>
    </>
  );
}
