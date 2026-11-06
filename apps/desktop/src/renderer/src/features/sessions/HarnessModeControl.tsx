import { useEffect, useRef, useState } from "react";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Layers, Loader2, RefreshCw } from "lucide-react";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { useSessionsStore } from "../../stores/sessions";
import { useAgentsStore } from "../../stores/agents";
import { useProvidersStore } from "../../stores/providers";
import { toast } from "../../stores/toast";

type Catalog = { modes: Array<{ id: string; name?: string; broken?: string; order?: number }>; defaultMode?: string };
const cache = new Map<string, { value: Promise<Catalog>; expires: number }>();
// Translations for shipped IDs only. The selectable roster always comes from
// the native registry; custom modes retain their own names and ordering.
const names: Record<string, [string, string]> = { standard: ["标准模式", "Standard"], ptc: ["PTC 模式", "PTC"], minimal: ["极简模式", "Minimal"], cordis: ["创造模式", "Create"] };

export function HarnessModeControl({ instanceId, value, onChange, disabled }: {
  instanceId: string; value?: string; onChange: (mode: string) => void; disabled?: boolean;
}): JSX.Element | null {
  const { locale } = useI18n();
  const instance = useAgentsStore(state => state.instances.find(item => item.id === instanceId));
  const supported = useProvidersStore(state => state.catalog.some(item => item.providerId === instance?.providerId && item.modeDiscovery));
  const [catalog, setCatalog] = useState<Catalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const current = useRef({ instanceId, value, onChange });
  current.current = { instanceId, value, onChange };
  const load = async (refresh = false): Promise<void> => {
    if (!supported) return;
    const key = `${instanceId}:${instance?.executable}`;
    let entry = cache.get(key);
    if (refresh || !entry || entry.expires < Date.now()) {
      const promise = requestCore<Catalog>("provider.modes", { agentInstanceId: instanceId });
      entry = { value: promise, expires: Date.now() + 60_000 };
      cache.set(key, entry);
      void promise.catch(() => { if (cache.get(key)?.value === promise) cache.delete(key); });
    }
    setLoading(true); setError(false);
    try {
      const next = await entry.value;
      if (current.current.instanceId !== instanceId) return;
      setCatalog(next);
      if (!current.current.value && next.defaultMode && !disabled) current.current.onChange(next.defaultMode);
    } catch {
      if (current.current.instanceId === instanceId) setError(true);
    } finally { if (current.current.instanceId === instanceId) setLoading(false); }
  };
  useEffect(() => { setCatalog(undefined); void load(); }, [instanceId, instance?.executable, supported]);
  if (!supported) return null;
  const zh = locale === "zh-CN";
  const label = (mode: Catalog["modes"][number]) => mode.name || names[mode.id]?.[zh ? 0 : 1] || mode.id;
  const selected = value ?? catalog?.defaultMode;
  const selectedMode = catalog?.modes.find(mode => mode.id === selected);
  return <Select.Root value={selected} onValueChange={onChange} disabled={disabled} onOpenChange={open => { if (open) void load(); }}>
    <Select.Trigger className="permission-trigger" aria-label={zh ? "Harness 模式" : "Harness mode"} title={disabled ? (zh ? "模式随原生会话保持，选择其他模式请新建会话" : "This native session keeps its mode. Start a new conversation to change it.") : undefined}>
      {loading ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
      <span>{selectedMode ? label(selectedMode) : value || (zh ? "选择模式" : "Choose mode")}</span><ChevronDown size={12} />
    </Select.Trigger>
    <Select.Portal><Select.Content className="permission-menu" position="popper" side="top" align="start" sideOffset={8}>
      <Select.Viewport>
        {catalog?.modes.map(mode => <Select.Item key={mode.id} value={mode.id} disabled={!!mode.broken} title={mode.broken} className="permission-menu-option">
          <Select.ItemText>{label(mode)}</Select.ItemText><Select.ItemIndicator className="permission-check"><Check size={14} /></Select.ItemIndicator>
        </Select.Item>)}
      </Select.Viewport>
      <button type="button" disabled={loading} onClick={() => void load(true)} className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-xs text-ink-2 disabled:opacity-50">
        <RefreshCw size={12} />{error ? (zh ? "读取失败，重试" : "Retry loading modes") : (zh ? "刷新模式" : "Refresh modes")}
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
