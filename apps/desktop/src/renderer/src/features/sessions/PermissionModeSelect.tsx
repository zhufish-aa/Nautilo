import { useState } from "react";
import { useSessionsStore } from "../../stores/sessions";
import { useAgentsStore } from "../../stores/agents";
import { useTeamsStore } from "../../stores/teams";
import { permissionModesFor } from "../../lib/provider-catalog";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { toast } from "../../stores/toast";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Hand, ListChecks, ShieldCheck, ShieldAlert } from "lucide-react";
import type { PermissionModeOption } from "../../lib/types";
import { useI18n } from "../../lib/i18n";

export function PermissionModeSelect({ value, options, onChange, disabled }: {
  value: string;
  options: PermissionModeOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const selected = options.find((option) => option.value === value);
  const fullAccess = (mode: string): boolean => ["full-access", "bypassPermissions", "danger-full-access"].includes(mode);
  const labelFor = (option: PermissionModeOption): string => option.name?.[locale] || option.name?.[zh ? "en-US" : "zh-CN"] || option.value;
  const permissionLabel = value === "default" ? (zh ? "默认权限" : "Default permissions") : selected ? labelFor(selected) : value;
  const Icon = fullAccess(value) ? ShieldAlert : ShieldCheck;
  return <Select.Root value={value} onValueChange={onChange} disabled={disabled || !options.length}>
    <Select.Trigger className="permission-trigger" data-danger={fullAccess(value)} aria-label={zh ? "权限模式" : "Permission mode"} aria-description={permissionLabel} title={permissionLabel}>
      <Icon size={15} aria-hidden />
      <span className="composer-control-label">{permissionLabel}</span>
      <Select.Icon className="composer-control-chevron"><ChevronDown size={12} aria-hidden /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content className="permission-menu" position="popper" side="top" align="start" sideOffset={10} collisionPadding={12}>
        <div className="permission-menu-heading">{zh ? "如何批准 Agent 操作？" : "How should agent actions be approved?"}</div>
        <Select.Viewport>
          {options.map((option) => {
            const danger = fullAccess(option.value);
            const label = labelFor(option);
            const description = option.description?.[locale] || option.description?.[zh ? "en-US" : "zh-CN"];
            const OptionIcon = danger ? ShieldAlert : option.value === "plan" ? ListChecks : option.value === "default" || option.value === "read-only" ? Hand : ShieldCheck;
            return <Select.Item key={option.value} value={option.value} textValue={label} className="permission-menu-option" data-danger={danger}>
              <OptionIcon size={16} aria-hidden />
              <span className="permission-menu-copy">
                <Select.ItemText>{label}</Select.ItemText>
                {description && <span className="permission-description">{description}</span>}
              </span>
              <Select.ItemIndicator className="permission-check"><Check size={15} /></Select.ItemIndicator>
            </Select.Item>;
          })}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}

export function SessionPermissionControl({ sessionId, disabled }: { sessionId: string; disabled?: boolean }): JSX.Element | null {
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const instances = useAgentsStore((state) => state.instances);
  const teams = useTeamsStore((state) => state.teams);
  const [saving, setSaving] = useState(false);
  const target = session?.target;
  const member = target?.type === "member" ? teams.find((team) => team.id === target.teamId)?.members.find((item) => item.id === target.memberId) : undefined;
  const instanceId = target?.type === "agent" ? target.instanceId : member?.agentInstanceId;
  const instance = instances.find((item) => item.id === instanceId);
  if (!session || !instance) return null;
  const change = async (permissionMode: string): Promise<void> => {
    if (disabled || saving) return;
    setSaving(true);
    try { await configureWorkbenchSession(sessionId, { permissionMode }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <PermissionModeSelect value={session.permissionMode ?? instance.permissionMode ?? "default"} options={permissionModesFor(instance.providerId)} onChange={(value) => void change(value)} disabled={disabled || saving} />;
}
