import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { SelectField } from "../../components/ui/Select";
import { Button } from "../../components/ui/Button";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useConnectionsStore } from "../../stores/connections";
import { toast } from "../../stores/toast";
import { AssistantEffort } from "./AssistantEffort";
import type { AssistantSettings } from "../../../../shared/workspace-assistant";
import "./assistant.css";

export function assistantError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}
export function AssistantSettingsPanel() {
  const zh = useI18n().locale === "zh-CN";
  const api = getBridge()?.assistant;
  const connections = useConnectionsStore((s) => s.connections);
  const [config, setConfig] = useState<AssistantSettings>({ connectionId: "", model: "", maxSteps: 8 });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void useConnectionsStore.getState().hydrate();
    api
      ?.view()
      .then((view) => {
        if (active) {
          setConfig(view.settings);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(assistantError(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const available = connections.filter(
    (c) =>
      c.enabled && c.kind === "api" && c.hasCredential !== false && c.models?.some((m) => m.enabled !== false),
  );
  const connection = available.find((c) => c.id === config.connectionId);
  const models = connection?.models?.filter((m) => m.enabled !== false) ?? [];
  const save = async () => {
    if (!api) return;
    setSaving(true);
    setError("");
    try {
      await api.configure(config);
      toast.success(zh ? "助手设置已保存" : "Assistant settings saved");
    } catch (e) {
      setError(assistantError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="settings-panel-card assistant-settings">
      <h2 className="settings-group-heading">{zh ? "调度模型" : "Routing model"}</h2>
      <p className="text-sm text-ink-2">
        {zh
          ? "助手使用这个模型理解指令、选择会话和整理记忆。执行任务的会话使用各自的模型。"
          : "The assistant uses this model for routing and memory. Worker sessions keep their own models."}
      </p>
      <div className="as-settings-row">
        <label id="as-connection">{zh ? "API 连接" : "API connection"}</label>
        <SelectField
          aria-label={zh ? "助手 API 连接" : "Assistant API connection"}
          value={connection?.id ?? ""}
          placeholder={zh ? "选择连接" : "Choose connection"}
          disabled={!loaded || !available.length}
          options={available.map((c) => ({ value: c.id, label: c.name }))}
          onValueChange={(id) =>
            setConfig((old) => ({
              ...old,
              connectionId: id,
              reasoningEffort: undefined,
              model: available.find((c) => c.id === id)?.models?.find((m) => m.enabled !== false)?.id ?? "",
            }))
          }
        />
      </div>
      <div className="as-settings-row">
        <label>{zh ? "模型" : "Model"}</label>
        <SelectField
          aria-label={zh ? "助手模型" : "Assistant model"}
          value={models.some((m) => m.id === config.model) ? config.model : ""}
          placeholder={zh ? "选择模型" : "Choose model"}
          disabled={!models.length}
          options={models.map((m) => ({ value: m.id, label: m.displayName || m.id }))}
          onValueChange={(model) => setConfig((old) => ({ ...old, model, reasoningEffort: undefined }))}
        />
      </div>
      <div className="as-settings-row">
        <label>{zh ? "推理强度" : "Reasoning effort"}</label>
        <AssistantEffort
          model={models.find((m) => m.id === config.model)}
          value={config.reasoningEffort}
          onChange={(reasoningEffort) => setConfig((old) => ({ ...old, reasoningEffort }))}
        />
      </div>
      <div className="as-settings-row">
        <label htmlFor="as-max-steps">
          {zh ? "每条指令的调度步数上限" : "Maximum routing steps per request"}
          <small className="as-settings-description">
            {zh
              ? "每步让模型做一次决定，例如查会话或派发任务。办完就结束。"
              : "Each step lets the model decide what to do, such as finding a session or assigning work. It stops when finished."}
          </small>
        </label>
        <input
          id="as-max-steps"
          type="number"
          min={2}
          max={24}
          value={config.maxSteps || ""}
          onChange={(e) => setConfig((old) => ({ ...old, maxSteps: Number(e.target.value) }))}
        />
      </div>
      <div className="as-settings-actions">
        <Link to="/settings?section=accounts">
          {zh ? "管理 API 连接" : "Manage API connections"}
          <ArrowUpRight size={14} />
        </Link>
        <Button
          onClick={() => void save()}
          disabled={
            saving ||
            !loaded ||
            !models.some((m) => m.id === config.model) ||
            config.maxSteps < 2 ||
            config.maxSteps > 24
          }
        >
          {zh ? "保存设置" : "Save settings"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
