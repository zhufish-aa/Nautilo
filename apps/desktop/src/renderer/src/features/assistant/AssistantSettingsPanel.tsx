import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { SelectField } from "../../components/ui/Select";
import { Button } from "../../components/ui/Button";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { toast } from "../../stores/toast";
import { AssistantEffort } from "./AssistantEffort";
import { assistantConnectionAvailable, DEFAULT_ASSISTANT_STEP_LIMIT, isAssistantStepLimit, type AssistantSettings } from "../../../../shared/workspace-assistant";
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
  const [config, setConfig] = useState<AssistantSettings>({ connectionId: "", model: "", maxSteps: DEFAULT_ASSISTANT_STEP_LIMIT });
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
  const options = connections.filter((c) => c.enabled && (
    c.kind === "login" || (assistantConnectionAvailable(c) && c.models?.some((m) => m.enabled !== false))
  ));
  const connection = options.find((c) => c.id === config.connectionId && assistantConnectionAvailable(c));
  const accountId = connection?.kind === "login" && !connection.models?.length ? connection.id : undefined;
  const revision = connection?.revision;
  const catalogKey = accountId && revision !== undefined ? connectionModelKey(accountId, revision) : undefined;
  const catalog = useConnectionsStore((s) => catalogKey ? s.modelCatalogs[catalogKey] : undefined);
  const loadingModels = useConnectionsStore((s) => !!catalogKey && s.loadingModels[catalogKey]);
  useEffect(() => {
    if (accountId) void useConnectionsStore.getState().loadModels(accountId, revision);
  }, [accountId, revision]);
  const models = accountId ? catalog?.models ?? [] : connection?.models?.filter((m) => m.enabled !== false) ?? [];
  const model = models.find((m) => m.id === (config.model || catalog?.defaultModel)) ?? (!config.model ? models[0] : undefined);
  const validStepLimit = isAssistantStepLimit(config.maxSteps);
  const save = async () => {
    if (!api || !model) return;
    setSaving(true);
    setError("");
    try {
      await api.configure({ ...config, model: model.id });
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
        <label>{zh ? "账号或 API 连接" : "Account or API connection"}</label>
        <SelectField
          aria-label={zh ? "助手账号或 API 连接" : "Assistant account or API connection"}
          value={connection?.id ?? ""}
          placeholder={zh ? "选择连接" : "Choose connection"}
          disabled={!loaded || !options.length}
          options={options.map((c) => ({
            value: c.id,
            label: c.name,
            disabled: !assistantConnectionAvailable(c),
            hint: c.kind === "api" ? "API" : c.accountGateway
              ? (zh ? "登录账号" : "Signed-in account")
              : (zh ? "在账号设置中开启「用于其他 Harness」" : 'Enable “Use with other harnesses” in account settings'),
          }))}
          onValueChange={(id) =>
            setConfig((old) => ({
              ...old,
              connectionId: id,
              reasoningEffort: undefined,
              model: "",
            }))
          }
        />
      </div>
      <div className="as-settings-row">
        <label>{zh ? "模型" : "Model"}
          {catalog?.warning && <small className="as-settings-description" role="status">{catalog.warning}</small>}
        </label>
        <SelectField
          aria-label={zh ? "助手模型" : "Assistant model"}
          value={model?.id ?? ""}
          placeholder={loadingModels ? (zh ? "正在获取账号模型…" : "Loading account models…") : (zh ? "选择模型" : "Choose model")}
          disabled={!models.length}
          options={models.map((m) => ({ value: m.id, label: m.displayName || m.id }))}
          onValueChange={(model) => setConfig((old) => ({ ...old, model, reasoningEffort: undefined }))}
        />
      </div>
      <div className="as-settings-row">
        <label>{zh ? "推理强度" : "Reasoning effort"}</label>
        <AssistantEffort
          model={model}
          value={config.reasoningEffort}
          onChange={(reasoningEffort) => setConfig((old) => ({ ...old, reasoningEffort }))}
        />
      </div>
      <div className="as-settings-row">
        <label htmlFor="as-max-steps">
          {zh ? "每条指令的调度步数上限" : "Maximum routing steps per request"}
          <small id="as-max-steps-help" className="as-settings-description">
            {zh
              ? "填 0 不限步数。查会话、读消息或派发任务各算一步，办完就会结束。"
              : "Enter 0 for no limit. Each lookup, message read or assignment takes one step."}
          </small>
          {!validStepLimit && <small id="as-max-steps-error" className="as-settings-description text-danger">
            {zh ? "请输入 0 或正整数。" : "Enter 0 or a positive integer."}
          </small>}
        </label>
        <input
          id="as-max-steps"
          type="number"
          min={0}
          step={1}
          aria-invalid={!validStepLimit}
          aria-describedby={validStepLimit ? "as-max-steps-help" : "as-max-steps-help as-max-steps-error"}
          value={Number.isNaN(config.maxSteps) ? "" : config.maxSteps}
          onChange={(e) => {
            const maxSteps = e.target.valueAsNumber;
            setConfig((old) => ({ ...old, maxSteps }));
          }}
        />
      </div>
      <div className="as-settings-row">
        <label htmlFor="as-proactive-topics">
          {zh ? "主动跟进公开话题" : "Follow public topics proactively"}
          <small className="as-settings-description">
            {zh
              ? "用已配置的官方网页搜索跟进还没答案的公开问题。有可靠新消息时，助手会回到对话告诉你。"
              : "Use configured official web search to follow unresolved public questions. The assistant returns to the chat when it finds a reliable update."}
          </small>
        </label>
        <input id="as-proactive-topics" type="checkbox" checked={config.proactiveTopics === true}
          onChange={event => setConfig(old => ({ ...old, proactiveTopics: event.target.checked }))} />
      </div>
      <div className="as-settings-actions">
        <Link to="/settings?section=accounts">
          {zh ? "管理账号和 API 连接" : "Manage accounts and API connections"}
          <ArrowUpRight size={14} />
        </Link>
        <Button
          onClick={() => void save()}
          disabled={
            saving ||
            !loaded ||
            !model ||
            !validStepLimit
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
