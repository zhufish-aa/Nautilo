import { useEffect, useRef } from "react";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Layers, Loader2, RefreshCw } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { useSessionsStore } from "../../stores/sessions";
import { useAgentsStore } from "../../stores/agents";
import { useProvidersStore } from "../../stores/providers";
import { harnessModeKey, useHarnessModesStore, type HarnessModeCatalog } from "../../stores/harness-modes";
import { toast } from "../../stores/toast";

// Translations for shipped IDs only. The selectable roster always comes from
// the native registry; custom modes retain their own names and ordering.
const names: Record<string, [string, string]> = { standard: ["标准模式", "Standard"], ptc: ["PTC 模式", "PTC"], minimal: ["极简模式", "Minimal"], cordis: ["创造模式", "Create"] };

export function HarnessModeControl({ instanceId, value, onChange, disabled }: {
  instanceId: string; value?: string; onChange: (mode: string) => void; disabled?: boolean;
}): JSX.Element | null {
  const { locale } = useI18n();
  const instance = useAgentsStore(state => state.instances.find(item => item.id === instanceId));
  const supported = useProvidersStore(state => state.catalog.some(item => item.providerId === instance?.providerId && item.modeDiscovery));
  const key = instance ? harnessModeKey(instance) : undefined;
  const catalog = useHarnessModesStore(state => key ? state.catalogs[key] : undefined);
  const loading = useHarnessModesStore(state => key ? !!state.loading[key] : false);
  const error = useHarnessModesStore(state => key ? !!state.errors[key] : false);
  const loadModes = useHarnessModesStore(state => state.loadModes);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (supported && instance) void loadModes(instance);
  }, [instanceId, instance?.providerId, instance?.executable, supported, loadModes]);
  useEffect(() => {
    if (supported && !value && catalog?.defaultMode && !disabled) change.current(catalog.defaultMode);
  }, [key, supported, value, catalog?.defaultMode, disabled]);
  if (!supported) return null;
  const zh = locale === "zh-CN";
  const label = (mode: HarnessModeCatalog["modes"][number]) => mode.name || names[mode.id]?.[zh ? 0 : 1] || mode.id;
  const selected = value ?? catalog?.defaultMode;
  const selectedMode = catalog?.modes.find(mode => mode.id === selected);
  const modeLabel = selectedMode ? label(selectedMode) : value || (zh ? "选择模式" : "Choose mode");
  const modeHint = disabled ? (zh ? "模式随原生会话保持，选择其他模式请新建会话" : "This native session keeps its mode. Start a new conversation to change it.") : undefined;
  return <Select.Root value={selected} onValueChange={onChange} disabled={disabled}>
    <Select.Trigger className="permission-trigger" aria-label={zh ? "Harness 模式" : "Harness mode"} aria-description={modeLabel} title={modeHint ? modeLabel + " · " + modeHint : modeLabel}>
      {loading && !catalog ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
      <span className="composer-control-label">{modeLabel}</span><ChevronDown className="composer-control-chevron" size={12} />
    </Select.Trigger>
    <Select.Portal><Select.Content className="permission-menu" position="popper" side="top" align="start" sideOffset={8}>
      <Select.Viewport>
        {catalog?.modes.map(mode => <Select.Item key={mode.id} value={mode.id} disabled={!!mode.broken} title={mode.broken} className="permission-menu-option">
          <Select.ItemText>{label(mode)}</Select.ItemText><Select.ItemIndicator className="permission-check"><Check size={14} /></Select.ItemIndicator>
        </Select.Item>)}
      </Select.Viewport>
      <button type="button" disabled={loading} onClick={() => { if (instance) void loadModes(instance, true); }} className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-xs text-ink-2 disabled:opacity-50">
        <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />{loading ? (zh ? "读取中…" : "Loading…") : error ? (zh ? "读取失败，重试" : "Retry loading modes") : (zh ? "刷新模式" : "Refresh modes")}
      </button>
    </Select.Content></Select.Portal>
  </Select.Root>;
}

export function SessionHarnessModeControl({ sessionId, disabled }: { sessionId: string; disabled?: boolean }): JSX.Element | null {
  const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
  const started = useSessionsStore(state => state.events[sessionId]?.some(event => event.data.kind === "message" && event.data.sender === "user") ?? false);
  if (session?.target.type !== "agent") return null;
  return <HarnessModeControl instanceId={session.target.instanceId} value={session.agentMode} disabled={disabled || started}
    onChange={agentMode => { void configureWorkbenchSession(sessionId, { agentMode }).catch(error => toast.error(String(error))); }} />;
}
