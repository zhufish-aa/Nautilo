import type { InstanceModelConfig } from "@agenthub/domain";
import { SelectField } from "../../components/ui/Select";
import { useI18n } from "../../lib/i18n";

export function AssistantEffort({
  model,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  model?: InstanceModelConfig;
  value?: string;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const zh = useI18n().locale === "zh-CN";
  const levels = model?.reasoningEfforts ?? [];
  const labels: Record<string, string> = zh
    ? {
        off: "关闭",
        none: "关闭",
        minimal: "最低",
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "很高",
        max: "最高",
        ultra: "极高",
      }
    : {
        off: "Off",
        none: "None",
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "Extra high",
        max: "Max",
        ultra: "Ultra",
      };
  const defaultLevel = model?.defaultReasoningEffort;
  const inherited = defaultLevel ? (labels[defaultLevel] ?? defaultLevel) : "";
  const automatic = zh
    ? inherited
      ? "默认（" + inherited + "）"
      : "模型默认"
    : inherited
      ? "Default (" + inherited + ")"
      : "Model default";
  const option = (text: string) => (compact ? (zh ? "推理 · " : "Effort · ") + text : text);
  return (
    <SelectField
      aria-label={zh ? "推理强度" : "Reasoning effort"}
      value={value && levels.includes(value) ? value : "__default"}
      disabled={disabled || !levels.length}
      className={compact ? "as-effort-select" : undefined}
      options={[
        { value: "__default", label: option(automatic) },
        ...levels.map((level) => ({ value: level, label: option(labels[level] ?? level) })),
      ]}
      onValueChange={(level) => onChange(level === "__default" ? undefined : level)}
    />
  );
}
