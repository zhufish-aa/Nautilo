import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  ChevronDown,
  Eye,
  EyeOff,
  HelpCircle,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import {
  apiTypesFor,
  ENV_POLICIES,
  permissionModesFor,
  supportsConfigProfile,
  useProviderMetas,
} from "../../lib/provider-catalog";
import type {
  AgentInstanceConfig,
  CodexWireApi,
  WebSearchMode,
} from "../../lib/types";
import { Tooltip } from "../../components/ui/Tooltip";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field as BaseField, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { TagInput } from "../../components/ui/TagInput";
import { newId } from "../../lib/utils";
import { useAgentsStore, type AgentInstanceDraft } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { ModelConfigurationEditor } from "./ModelConfigurationEditor";
import { modelRow, serializeModels, type ModelRow } from "./model-editor";

/** Help stays on demand; validation remains visible next to its input. */
function Field({
  hint,
  label,
  htmlFor,
  error,
  children,
  className,
}: ComponentProps<typeof BaseField>): JSX.Element {
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      <div className="flex items-center gap-2">
        <label htmlFor={htmlFor} className="text-sm text-ink-2">
          {label}
        </label>
        {hint && (
          <Tooltip content={hint}>
            <button
              type="button"
              aria-label={hint}
              className="rounded text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <HelpCircle className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      {children}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Instance editor: how Nautilo connects to a CLI, plus an optional curated
 * model catalog (ids, ordered efforts, context windows). Per-run execution
 * choices still belong to TeamMember or Session.
 */
function canProvideNativeWebSearch(candidate: AgentInstanceConfig): boolean {
  // Codex is the adapter that can expose native web_search through either
  // the official endpoint or a compatible third-party endpoint. Whether the
  // upstream actually supports it is validated when the request runs.
  return candidate.providerId === "codex";
}

interface FormState {
  displayName: string;
  loginProfileDirectory: string;
  loginProfileLabel: string;
  connectionMode: "api" | "account";
  providerId: string;
  executable: string;
  baseArgs: string[];
  profile: string;
  envPolicyId: string;
  permissionMode: string;
  apiKey: string;
  baseUrl: string;
  apiType: string;
  wireApi: CodexWireApi;
  appServerPoolSize: string;
  webSearchMode: WebSearchMode;
  webSearchInstanceId: string;
  webSearchModel: string;
  webSearchReasoningEffort: string;
  models: ModelRow[];
  enabled: boolean;
}

function emptyForm(): FormState {
  return {
    displayName: "",
    loginProfileDirectory: "",
    loginProfileLabel: "",
    connectionMode: "api",
    providerId: "",
    executable: "",
    baseArgs: [],
    profile: "",
    envPolicyId: "env-standard",
    permissionMode: "",
    apiKey: "",
    baseUrl: "",
    apiType: "",
    wireApi: "responses",
    appServerPoolSize: "",
    webSearchMode: "native",
    webSearchInstanceId: "",
    webSearchModel: "",
    webSearchReasoningEffort: "",
    models: [],
    enabled: true,
  };
}

function formFromInstance(instance: AgentInstanceConfig): FormState {
  return {
    displayName: instance.displayName,
    loginProfileDirectory: instance.loginProfileDirectory ?? "",
    loginProfileLabel: instance.loginProfileLabel ?? "",
    connectionMode: instance.loginProfileDirectory ? "account" : "api",
    providerId: instance.providerId,
    executable: instance.executable,
    baseArgs: instance.baseArgs,
    profile: instance.profile ?? "",
    envPolicyId: instance.envPolicyId,
    permissionMode: instance.permissionMode ?? "",
    apiKey: instance.apiKey ?? "",
    baseUrl: instance.baseUrl ?? "",
    apiType:
      instance.apiType ?? apiTypesFor(instance.providerId)[0]?.value ?? "",
    wireApi: instance.wireApi ?? "responses",
    appServerPoolSize: instance.appServerPoolSize ? String(instance.appServerPoolSize) : "",
    webSearchMode:
      instance.webSearchMode ??
      (instance.wireApi === "chat" ? "off" : "native"),
    webSearchInstanceId: instance.webSearchInstanceId ?? "",
    webSearchModel: instance.webSearchModel ?? "",
    webSearchReasoningEffort: instance.webSearchReasoningEffort ?? "",
    models: (instance.models ?? []).map((model) => modelRow(model, newId("model"))),
    enabled: instance.enabled,
  };
}

export function AgentEditorDialog({
  open,
  onOpenChange,
  instance,
  initialConnectionMode = "api",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance?: AgentInstanceConfig;
  initialConnectionMode?: "api" | "account";
}): JSX.Element {
  const { t, locale } = useI18n();
  const createInstance = useAgentsStore((state) => state.createInstance);
  const updateInstance = useAgentsStore((state) => state.updateInstance);
  const previewModels = useAgentsStore((state) => state.previewModels);
  const installations = useAgentsStore((state) => state.installations);
  const instances = useAgentsStore((state) => state.instances);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const fetchGeneration = useRef(0);
  const [modelError, setModelError] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [errors, setErrors] = useState<{
    name?: string;
    provider?: string;
    executable?: string;
    concurrency?: string;
  }>({});

  useEffect(() => {
    fetchGeneration.current += 1;
    if (open) {
      setModelError("");
      setForm(instance ? formFromInstance(instance) : { ...emptyForm(), connectionMode: initialConnectionMode });
      setShowApiKey(false);
      setFetchingModels(false);
      setErrors({});
    }
  }, [open, instance, initialConnectionMode]);

  const patch = (changes: Partial<FormState>): void => {
    if (["providerId", "baseUrl", "apiKey", "apiType", "wireApi", "connectionMode", "loginProfileDirectory"].some((key) => key in changes)) {
      fetchGeneration.current += 1;
      setFetchingModels(false);
    }
    setForm((prev) => ({ ...prev, ...changes }));
  };

  /** Quick fetch: with a base URL the daemon queries it directly; otherwise the provider CLI catalog is used. */
  const quickFetchModels = async (): Promise<void> => {
    if (fetchingModels) return;
    const generation = ++fetchGeneration.current;
    setFetchingModels(true);
    try {
      const catalog = await previewModels({
        providerId: form.providerId,
        agentInstanceId: instance?.id,
        executable: form.executable,
        baseUrl: form.connectionMode === "api" ? form.baseUrl : undefined,
        apiKey: form.connectionMode === "api" ? form.apiKey : undefined,
        apiType: form.providerId === "codex" && form.wireApi === "anthropic" ? "anthropic-messages" : form.apiType,
      });
      if (generation !== fetchGeneration.current) return;
      if (!catalog.models.length) {
        toast.error(catalog.warning ?? t("agents.editor.models.fetchEmpty"));
        return;
      }
      // Fetch appends new IDs without discarding manual prices, defaults or edits.
      setForm((current) => {
        const ids = new Set(current.models.map((model) => model.id));
        return { ...current, models: [...current.models, ...catalog.models.filter((model) => !ids.has(model.id)).map((model) => modelRow(form.providerId === "codex" && form.wireApi === "anthropic" ? { ...model, reasoningEfforts: [], defaultReasoningEffort: undefined } : model, newId("model")))] };
      });
      toast.success(
        t("agents.editor.models.fetched", { count: catalog.models.length }),
      );
      if (catalog.warning) toast.info(catalog.warning);
    } catch (error) {
      if (generation === fetchGeneration.current) toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === fetchGeneration.current) setFetchingModels(false);
    }
  };

  const providers = useProviderMetas();
  const providerOptions = useMemo(
    () =>
      providers.map((provider) => {
        const installation = installations.find(
          (item) => item.providerId === provider.id,
        );
        return {
          value: provider.id,
          label: provider.name,
          hint: installation
            ? t(`status.provider.${installation.status}` as MessageKey)
            : undefined,
        };
      }),
    [providers, installations, t],
  );

  const envOptions = useMemo(
    () =>
      ENV_POLICIES.map((policy) => ({
        value: policy.id,
        label: t(policy.nameKey as MessageKey),
        hint: t(policy.descriptionKey as MessageKey),
      })),
    [t],
  );

  const permissionModeOptions = useMemo(
    () =>
      permissionModesFor(form.providerId).map((mode) => ({
        value: mode.value,
        label: mode.name[locale],
        hint: mode.description[locale],
      })),
    [form.providerId, locale],
  );

  const apiTypeOptions = useMemo(
    () =>
      apiTypesFor(form.providerId).map((apiType) => ({
        value: apiType.value,
        label: apiType.name[locale],
        hint: apiType.description[locale],
      })),
    [form.providerId, locale],
  );

  const webSearchInstanceOptions = useMemo(
    () => [
      { value: "", label: t("agents.editor.basic.webSearchInstanceNone") },
      ...instances
        .filter(
          (candidate) =>
            candidate.id !== instance?.id &&
            candidate.enabled &&
            canProvideNativeWebSearch(candidate),
        )
        .map((candidate) => ({
          value: candidate.id,
          label: candidate.displayName,
        })),
    ],
    [instance?.id, instances, t],
  );

  const selectedWebSearchInstance = instances.find(
    (candidate) => candidate.id === form.webSearchInstanceId,
  );
  const webSearchModelOptions = useMemo(
    () => [
      { value: "", label: t("agents.editor.basic.webSearchModelDefault") },
      ...(selectedWebSearchInstance?.models ?? []).map((model) => ({
        value: model.id,
        label: model.displayName
          ? `${model.displayName} (${model.id})`
          : model.id,
      })),
    ],
    [selectedWebSearchInstance, t],
  );
  const selectedWebSearchModel = selectedWebSearchInstance?.models?.find(
    (model) => model.id === form.webSearchModel,
  );
  const webSearchReasoningOptions = useMemo(
    () => [
      { value: "", label: t("agents.editor.basic.webSearchReasoningDefault") },
      ...(selectedWebSearchModel?.reasoningEfforts ?? []).map((effort) => ({
        value: effort,
        label: effort,
      })),
    ],
    [selectedWebSearchModel, t],
  );

  const save = async (): Promise<void> => {
    if (saving) return;
    const nextErrors: typeof errors = {};
    if (!form.displayName.trim())
      nextErrors.name = t("agents.editor.nameRequired");
    if (!form.providerId)
      nextErrors.provider = t("agents.editor.providerRequired");
    if (!form.executable.trim())
      nextErrors.executable = locale === "zh-CN" ? "请先探测 CLI，或填写可执行文件路径" : "Detect the CLI or enter its executable path";
    if (form.providerId === "codex" && form.appServerPoolSize.trim() && (!Number.isSafeInteger(Number(form.appServerPoolSize)) || Number(form.appServerPoolSize) < 1))
      nextErrors.concurrency = locale === "zh-CN" ? "请输入正整数，或留空表示不限。" : "Enter a positive integer, or leave blank for no limit.";
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.provider || nextErrors.executable || nextErrors.concurrency) return;

    let models;
    try { models = serializeModels(form.models); setModelError(""); }
    catch (error) { setModelError(error instanceof Error ? error.message : String(error)); return; }
    if (form.connectionMode === "account" && !form.loginProfileDirectory.trim()) {
      toast.error(locale === "zh-CN" ? "请填写独立登录目录" : "Enter an isolated login directory"); return;
    }

    const draft: AgentInstanceDraft = {
      displayName: form.displayName.trim(),
      providerId: form.providerId,
      executable: form.executable.trim(),
      baseArgs: form.connectionMode === "account" ? [] : form.baseArgs,
      profile: form.connectionMode !== "account" && supportsConfigProfile(form.providerId)
        ? form.profile.trim() || undefined
        : undefined,
      envPolicyId: form.envPolicyId,
      permissionMode: form.permissionMode.trim() || undefined,
      apiKey: form.connectionMode === "api" ? form.apiKey.trim() || undefined : undefined,
      baseUrl: form.connectionMode === "api" ? form.baseUrl.trim() || undefined : undefined,
      loginProfileDirectory: form.connectionMode === "account" ? form.loginProfileDirectory.trim() : undefined,
      loginProfileLabel: form.connectionMode === "account" ? form.loginProfileLabel.trim() || undefined : undefined,
      apiType: apiTypeOptions.length
        ? form.apiType.trim() || apiTypeOptions[0]?.value
        : undefined,
      wireApi: form.providerId === "codex" ? form.wireApi : undefined,
      appServerPoolSize: form.providerId === "codex" && form.appServerPoolSize.trim() ? Number(form.appServerPoolSize) : undefined,
      webSearchMode:
        form.providerId === "codex" ? form.webSearchMode : undefined,
      webSearchInstanceId:
        form.providerId === "codex" && form.webSearchMode === "official"
          ? form.webSearchInstanceId || undefined
          : undefined,
      webSearchModel:
        form.providerId === "codex" && form.webSearchMode === "official"
          ? form.webSearchModel || undefined
          : undefined,
      webSearchReasoningEffort:
        form.providerId === "codex" && form.webSearchMode === "official"
          ? form.webSearchReasoningEffort || undefined
          : undefined,
      models: models.length ? models : undefined,
      enabled: form.enabled,
    };

    setSaving(true);
    try {
      if (instance) {
        await updateInstance(instance.id, draft);
        // Refresh existing conversation controls after changing the curated model list.
        void useAgentsStore.getState().loadModels(instance.id);
        toast.success(
          t("agents.editor.savedToast", { name: draft.displayName }),
        );
      } else {
        await createInstance(draft);
        toast.success(
          t("agents.editor.createdToast", { name: draft.displayName }),
        );
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
      title={
        instance ? (locale === "zh-CN" ? "编辑连接" : "Edit connection") : (locale === "zh-CN" ? "添加连接" : "Add connection")
      }
      widthClass="max-w-4xl"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving && (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <p className="mb-5 text-xs leading-relaxed text-ink-3">{locale === "zh-CN" ? "当前连接绑定所选本机 Agent CLI。端点与协议能否使用取决于该适配器，不表示可跨所有 Agent 复用。" : "Connections currently belong to a selected local agent CLI. Endpoint and protocol support depend on that adapter; compatibility across all agents is not implied."}</p>
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
        <Field
          label={t("agents.editor.basic.name")}
          htmlFor="agent-name"
          error={errors.name}
        >
          <Input
            id="agent-name"
            value={form.displayName}
            onChange={(event) => patch({ displayName: event.target.value })}
            placeholder={t("agents.editor.basic.namePlaceholder")}
            autoFocus
          />
        </Field>

        <Field
          label={locale === "zh-CN" ? "连接方式" : "Connection adapter"}
          error={errors.provider}
        >
          <SelectField
            aria-label={t("agents.editor.basic.provider")}
            value={form.providerId || undefined}
            onValueChange={(value) =>
              patch({
                providerId: value,
                connectionMode: value === "codex" || value === "claude-code" ? form.connectionMode : "api",
                loginProfileDirectory: "",
                loginProfileLabel: "",
                executable:
                  installations.find((item) => item.providerId === value)
                    ?.executable ?? "",
                permissionMode: "",
                apiType: apiTypesFor(value)[0]?.value ?? "",
                wireApi: value === "codex" ? form.wireApi : "responses",
              })
            }
            options={providerOptions}
            placeholder={t("agents.editor.basic.providerPlaceholder")}
          />
        </Field>

        <Field
          label={t("agents.providers.executable")}
          htmlFor="agent-executable"
          error={errors.executable}
        >
          <Input
            id="agent-executable"
            value={form.executable}
            onChange={(event) => patch({ executable: event.target.value })}
            placeholder="codex / kimi / C:\\path\\to\\cli.exe"
            className="font-mono text-[13px]"
          />
        </Field>

        {supportsConfigProfile(form.providerId) && (
          <Field
            label={t("agents.editor.basic.profile")}
            htmlFor="agent-profile"
          >
            <Input
              id="agent-profile"
              value={form.profile}
              onChange={(event) => patch({ profile: event.target.value })}
              placeholder={t("agents.editor.basic.profilePlaceholder")}
            />
          </Field>
        )}

        <div className="sm:col-span-2 border-t border-line pt-6">
          <p className="mb-3 text-[13px] font-medium text-ink-2">
            {t("agents.editor.basic.credentials")}
          </p>
          {initialConnectionMode === "account" && form.providerId && !["codex", "claude-code"].includes(form.providerId) && <p className="mb-4 text-xs text-ink-3">{locale === "zh-CN" ? "此适配器尚不支持独立登录账号。可使用 API 连接。" : "Isolated accounts are not supported for this adapter. Use an API connection instead."}</p>}
          {(form.providerId === "codex" || form.providerId === "claude-code") && <div className="mb-5 space-y-4">
            <SelectField aria-label={locale === "zh-CN" ? "认证方式" : "Authentication"} value={form.connectionMode} onValueChange={(value) => patch({ connectionMode: value as "api" | "account" })} options={[{ value: "api", label: "API" }, { value: "account", label: locale === "zh-CN" ? "独立登录账号" : "Isolated CLI account" }]} />
            {form.connectionMode === "account" && <div className="space-y-4">
              <Field label={locale === "zh-CN" ? "账号备注" : "Account label"}><Input value={form.loginProfileLabel} onChange={(event) => patch({ loginProfileLabel: event.target.value })} aria-label={locale === "zh-CN" ? "账号备注" : "Account label"} /></Field>
              <Field label={locale === "zh-CN" ? "独立登录目录（绝对路径）" : "Isolated login directory (absolute path)"}><Input value={form.loginProfileDirectory} onChange={(event) => patch({ loginProfileDirectory: event.target.value })} aria-label={locale === "zh-CN" ? "独立登录目录" : "Isolated login directory"} className="font-mono" /></Field>
              <p className="text-xs leading-relaxed text-ink-3">{locale === "zh-CN" ? "请通过官方 CLI 在该目录中登录。填写路径不代表已登录；此连接不会使用 API Key 或自定义端点。已有会话的连接不能更换登录目录，请另建连接。Claude 仅隔离 claude.ai 登录，不保证多个 Console 登录隔离。" : "Sign in through the official CLI using this directory. A path does not verify login; this connection will not use an API key or custom endpoint. Create another connection to change an existing profile. Claude directory isolation covers claude.ai login, not multiple Console sign-ins."}</p>
            </div>}
          </div>}
          <div className={`grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 ${form.connectionMode === "account" ? "hidden" : ""}`}>

            <Field
              label={t("agents.editor.basic.apiKey")}
              htmlFor="agent-apikey"
              hint={t("agents.editor.basic.apiKeyHint")}
            >
              <div className="relative">
                <Input
                  id="agent-apikey"
                  type={showApiKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                  placeholder={t("agents.editor.basic.apiKeyPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  className="pr-10 font-mono text-[13px]"
                />
                <button
                  type="button"
                  aria-label={
                    showApiKey
                      ? t("agents.editor.basic.hideKey")
                      : t("agents.editor.basic.showKey")
                  }
                  onClick={() => setShowApiKey((prev) => !prev)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-accent-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:outline-none"
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
            </Field>

            <Field
              label={t("agents.editor.basic.baseUrl")}
              htmlFor="agent-baseurl"
              hint={t("agents.editor.basic.baseUrlHint")}
            >
              <Input
                id="agent-baseurl"
                value={form.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
                placeholder={t("agents.editor.basic.baseUrlPlaceholder")}
                spellCheck={false}
                className="font-mono text-[13px]"
              />
            </Field>
            {apiTypeOptions.length > 0 && (
              <Field
                label={t("agents.editor.basic.apiType")}
                hint={t("agents.editor.basic.apiTypeHint")}
              >
                <SelectField
                  aria-label={t("agents.editor.basic.apiType")}
                  value={form.apiType || apiTypeOptions[0]?.value}
                  onValueChange={(apiType) => patch({ apiType })}
                  options={apiTypeOptions}
                />
              </Field>
            )}
            {form.providerId === "codex" && (
              <Field
                label={t("agents.editor.basic.wireApi")}
                hint={t("agents.editor.basic.wireApiHint")}
              >
                <SelectField
                  aria-label={t("agents.editor.basic.wireApi")}
                  value={form.wireApi}
                  onValueChange={(wireApi) =>
                    patch({ wireApi: wireApi as CodexWireApi, ...(wireApi === "anthropic" ? { webSearchMode: "off" as const } : {}) })
                  }
                  options={[
                    {
                      value: "responses",
                      label: t("agents.editor.basic.wireApiResponses"),
                      hint: t("agents.editor.basic.wireApiResponsesHint"),
                    },
                    {
                      value: "anthropic",
                      label: "Anthropic Messages",
                      hint: locale === "zh-CN" ? "兼容转换 · 文本与工具调用" : "Compatibility bridge · text and tool calls",
                    },
                    {
                      value: "chat",
                      label: t("agents.editor.basic.wireApiChat"),
                      hint: t("agents.editor.basic.wireApiChatHint"),
                    },
                  ]}
                />
              </Field>
            )}
            {form.providerId === "codex" && form.wireApi === "anthropic" && <p className="sm:col-span-2 text-xs leading-relaxed text-ink-3">{locale === "zh-CN" ? "Anthropic 兼容转换仅支持文本与工具调用，不支持图片、原生联网、原生 thinking 或结构化输出。此协议的模型推理强度请留空；不支持的参数会明确报错。" : "The Anthropic bridge supports text and tools, not images, hosted search, native thinking or structured output. Leave model reasoning values empty for this protocol; unsupported parameters fail explicitly."}</p>}
            {form.providerId === "codex" && (
              <Field label={locale === "zh-CN" ? "并发上限" : "Concurrency limit"} error={errors.concurrency}
                hint={locale === "zh-CN" ? "默认不限。主 Agent 和子 Agent 共用所设上限；超出时排队。实际并发取决于电脑资源和服务商限制。" : "Unlimited by default. The main agent and subagents share an optional limit; excess sessions queue. Actual concurrency depends on system resources and provider limits."}>
                <Input type="number" min={1} step={1}
                  aria-label={locale === "zh-CN" ? "并发上限" : "Concurrency limit"}
                  placeholder={locale === "zh-CN" ? "不限" : "Unlimited"}
                  value={form.appServerPoolSize}
                  onChange={(event) => patch({ appServerPoolSize: event.target.value })}
                />
              </Field>
            )}
            {form.providerId === "codex" && (
              <Field
                label={t("agents.editor.basic.webSearchMode")}
                hint={t("agents.editor.basic.webSearchModeHint")}
              >
                <SelectField
                  aria-label={t("agents.editor.basic.webSearchMode")}
                  value={form.webSearchMode}
                  onValueChange={(value) =>
                    patch({ webSearchMode: value as WebSearchMode })
                  }
                  options={[
                    {
                      value: "native",
                      label: t("agents.editor.basic.webSearchNative"),
                      hint: t("agents.editor.basic.webSearchNativeHint"),
                    },
                    {
                      value: "official",
                      label: t("agents.editor.basic.webSearchOfficial"),
                      hint: t("agents.editor.basic.webSearchOfficialHint"),
                    },
                    {
                      value: "off",
                      label: t("agents.editor.basic.webSearchOff"),
                      hint: t("agents.editor.basic.webSearchOffHint"),
                    },
                  ]}
                />
              </Field>
            )}
            {form.providerId === "codex" &&
              form.webSearchMode === "official" && (
                <Field
                  label={t("agents.editor.basic.webSearchInstance")}
                  hint={t("agents.editor.basic.webSearchInstanceHint")}
                >
                  <SelectField
                    aria-label={t("agents.editor.basic.webSearchInstance")}
                    value={form.webSearchInstanceId}
                    onValueChange={(value) =>
                      patch({
                        webSearchInstanceId: value,
                        webSearchModel: "",
                        webSearchReasoningEffort: "",
                      })
                    }
                    options={webSearchInstanceOptions}
                  />
                </Field>
              )}
            {form.providerId === "codex" &&
              form.webSearchMode === "official" &&
              form.webSearchInstanceId && (
                <>
                  <Field
                    label={t("agents.editor.basic.webSearchModel")}
                    hint={t("agents.editor.basic.webSearchModelHint")}
                  >
                    <SelectField
                      aria-label={t("agents.editor.basic.webSearchModel")}
                      value={form.webSearchModel}
                      onValueChange={(value) =>
                        patch({
                          webSearchModel: value,
                          webSearchReasoningEffort: "",
                        })
                      }
                      options={webSearchModelOptions}
                    />
                  </Field>
                  <Field
                    label={t("agents.editor.basic.webSearchReasoning")}
                    hint={t("agents.editor.basic.webSearchReasoningHint")}
                  >
                    <SelectField
                      aria-label={t("agents.editor.basic.webSearchReasoning")}
                      value={form.webSearchReasoningEffort}
                      onValueChange={(value) =>
                        patch({ webSearchReasoningEffort: value })
                      }
                      options={webSearchReasoningOptions}
                    />
                  </Field>
                </>
              )}
          </div>
        </div>
        <div className="sm:col-span-2 border-t border-line pt-6">
          <div className="mb-1 flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-ink-2">
              {t("agents.editor.models.title")}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={fetchingModels || !form.providerId || (form.connectionMode === "account" && (!instance || form.loginProfileDirectory !== instance.loginProfileDirectory))}
              onClick={() => void quickFetchModels()}
            >
              {fetchingModels ? (
                <LoaderCircle
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden
                />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              {t("agents.editor.models.fetch")}
            </Button>
          </div>
          {form.connectionMode === "account" && (!instance || form.loginProfileDirectory !== instance.loginProfileDirectory) && <p className="mt-2 text-xs text-ink-3">{locale === "zh-CN" ? "请先保存独立登录连接，再获取其模型。也可手动添加。" : "Save this isolated account connection before fetching its models, or add models manually."}</p>}
          <div className="mt-4"><ModelConfigurationEditor models={form.models} onChange={(models) => patch({ models })} /></div>
          {modelError && <p role="alert" className="mt-3 text-sm text-danger">{modelError}</p>}
        </div>
        <details className="group sm:col-span-2 border-t border-line pt-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <ChevronDown
              className="h-4 w-4 transition-transform group-open:rotate-180"
              aria-hidden
            />
            {locale === "zh-CN" ? "高级" : "Advanced"}
          </summary>
          <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label={t("agents.editor.basic.args")}
                hint={t("agents.editor.basic.argsHint")}
              >
                <TagInput
                  aria-label={t("agents.editor.basic.args")}
                  values={form.baseArgs}
                  onChange={(baseArgs) => patch({ baseArgs })}
                  placeholder={t("agents.editor.basic.argsPlaceholder")}
                />
              </Field>
            </div>

            <Field label={t("agents.editor.basic.envPolicy")}>
              <SelectField
                aria-label={t("agents.editor.basic.envPolicy")}
                value={form.envPolicyId}
                onValueChange={(envPolicyId) => patch({ envPolicyId })}
                options={envOptions}
              />
            </Field>

            {permissionModeOptions.length > 0 && (
              <Field
                label={t("agents.editor.basic.permissionMode")}
                hint={t("agents.editor.basic.permissionModeHint")}
              >
                <SelectField
                  aria-label={t("agents.editor.basic.permissionMode")}
                  value={form.permissionMode || undefined}
                  onValueChange={(permissionMode) => patch({ permissionMode })}
                  options={permissionModeOptions}
                  placeholder={t(
                    "agents.editor.basic.permissionModePlaceholder",
                  )}
                />
              </Field>
            )}

            <div className="flex items-center justify-between gap-3 border-b border-line py-4">
              <div>
                <p className="text-[13px] font-medium text-ink-2">
                  {t("agents.editor.basic.enabled")}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
                aria-label={t("agents.editor.basic.enabled")}
              />
            </div>
          </div>
        </details>
      </div>
    </Dialog>
  );
}
