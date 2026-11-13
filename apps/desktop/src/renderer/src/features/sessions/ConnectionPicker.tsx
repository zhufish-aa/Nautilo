import { useRef, useState } from "react";
import type { RuntimeConnection } from "@agenthub/domain";
import type { AgentInstanceConfig } from "../../lib/types";
import { SelectField } from "../../components/ui/Select";
import { connectionCanBeSelected, connectionSupportsAgent } from "../../lib/session-connections";
import { useConnectionsStore } from "../../stores/connections";
import { useI18n } from "../../lib/i18n";
import { toast } from "../../stores/toast";

/** Selecting a login identity also enables that identity's cross-harness route. */
export function ConnectionPicker({ instance, value, disabled, className, fallback, onChange }: {
  instance: AgentInstanceConfig;
  value?: string;
  disabled?: boolean;
  className?: string;
  fallback?: { value: string; label: string };
  onChange: (connection: RuntimeConnection | undefined) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const connections = useConnectionsStore(state => state.connections);
  const setRoute = useConnectionsStore(state => state.setAccountRoute);
  const [busy, setBusy] = useState(false);
  const context = useRef({ instanceId: instance.id, value });
  context.current = { instanceId: instance.id, value };
  const choices = connections.filter(item => connectionCanBeSelected(item, instance));
  const options = [
    ...(fallback ? [fallback] : []),
    ...choices.map(item => ({ value: item.id, label: item.name,
      hint: item.kind === "login" ? item.harness === "claude-code" ? "Claude Code" : "Codex" : undefined })),
  ];
  if (value && !options.some(option => option.value === value)) {
    options.push({ value, label: connections.find(item => item.id === value)?.name ?? value });
  }
  const choose = async (id: string) => {
    if (busy || disabled) return;
    const selected = choices.find(item => item.id === id);
    if (!selected) { if (id === fallback?.value) onChange(undefined); return; }
    const original = context.current;
    setBusy(true);
    try {
      const ready = connectionSupportsAgent(selected, instance) ? selected : await setRoute(selected.id, true);
      if (context.current.instanceId === original.instanceId && context.current.value === original.value) onChange(ready);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  return <SelectField value={value} className={className} disabled={disabled || busy}
    placeholder={busy ? (zh ? "连接账号…" : "Connecting account…") : (zh ? "选择供应商 / 账号" : "Choose provider / account")}
    aria-label={zh ? "供应商或账号" : "Provider or account"} options={options} onValueChange={id => void choose(id)} />;
}
