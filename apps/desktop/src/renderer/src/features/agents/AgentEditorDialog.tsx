import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { ENV_POLICIES, PROVIDERS } from "../../lib/provider-catalog";
import type { AgentInstanceConfig } from "../../lib/types";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { TagInput } from "../../components/ui/TagInput";
import { useAgentsStore, type AgentInstanceDraft } from "../../stores/agents";
import { toast } from "../../stores/toast";

/**
 * Instance editor: how AgentHub connects to a CLI. Execution choices such as
 * model and reasoning effort belong to TeamMember or Session, never here.
 */
interface FormState {
  displayName: string;
  providerId: string;
  executable: string;
  baseArgs: string[];
  profile: string;
  envPolicyId: string;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
}

function emptyForm(): FormState {
  return {
    displayName: "",
    providerId: "",
    executable: "",
    baseArgs: [],
    profile: "",
    envPolicyId: "env-standard",
    apiKey: "",
    baseUrl: "",
    enabled: true
  };
}

function formFromInstance(instance: AgentInstanceConfig): FormState {
  return {
    displayName: instance.displayName,
    providerId: instance.providerId,
    executable: instance.executable,
    baseArgs: instance.baseArgs,
    profile: instance.profile ?? "",
    envPolicyId: instance.envPolicyId,
    apiKey: instance.apiKey ?? "",
    baseUrl: instance.baseUrl ?? "",
    enabled: instance.enabled
  };
}

export function AgentEditorDialog({
  open,
  onOpenChange,
  instance
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance?: AgentInstanceConfig;
}): JSX.Element {
  const { t } = useI18n();
  const createInstance = useAgentsStore((state) => state.createInstance);
  const updateInstance = useAgentsStore((state) => state.updateInstance);
  const installations = useAgentsStore((state) => state.installations);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [showApiKey, setShowApiKey] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; provider?: string; executable?: string }>({});

  useEffect(() => {
    if (open) {
      setForm(instance ? formFromInstance(instance) : emptyForm());
      setShowApiKey(false);
      setErrors({});
    }
  }, [open, instance]);

  const patch = (changes: Partial<FormState>): void => setForm((prev) => ({ ...prev, ...changes }));

  const providerOptions = useMemo(
    () =>
      PROVIDERS.map((provider) => {
        const installation = installations.find((item) => item.providerId === provider.id);
        return {
          value: provider.id,
          label: provider.name,
          hint: installation ? t(`status.provider.${installation.status}` as MessageKey) : undefined
        };
      }),
    [installations, t]
  );

  const envOptions = useMemo(
    () =>
      ENV_POLICIES.map((policy) => ({
        value: policy.id,
        label: t(policy.nameKey as MessageKey),
        hint: t(policy.descriptionKey as MessageKey)
      })),
    [t]
  );

  const save = async (): Promise<void> => {
    const nextErrors: typeof errors = {};
    if (!form.displayName.trim()) nextErrors.name = t("agents.editor.nameRequired");
    if (!form.providerId) nextErrors.provider = t("agents.editor.providerRequired");
    if (!form.executable.trim()) nextErrors.executable = "请先探测 CLI，或填写可执行文件路径";
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.provider || nextErrors.executable) return;

    const draft: AgentInstanceDraft = {
      displayName: form.displayName.trim(),
      providerId: form.providerId,
      executable: form.executable.trim(),
      baseArgs: form.baseArgs,
      profile: form.profile.trim() || undefined,
      envPolicyId: form.envPolicyId,
      apiKey: form.apiKey.trim() || undefined,
      baseUrl: form.baseUrl.trim() || undefined,
      enabled: form.enabled
    };

    if (instance) {
      await updateInstance(instance.id, draft);
      toast.success(t("agents.editor.savedToast", { name: draft.displayName }));
    } else {
      await createInstance(draft);
      toast.success(t("agents.editor.createdToast", { name: draft.displayName }));
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={instance ? t("agents.editor.editTitle") : t("agents.editor.createTitle")}
      widthClass="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("agents.editor.basic.name")} htmlFor="agent-name" error={errors.name}>
          <Input
            id="agent-name"
            value={form.displayName}
            onChange={(event) => patch({ displayName: event.target.value })}
            placeholder={t("agents.editor.basic.namePlaceholder")}
            autoFocus
          />
        </Field>

        <Field label={t("agents.editor.basic.provider")} error={errors.provider}>
          <SelectField
            aria-label={t("agents.editor.basic.provider")}
            value={form.providerId || undefined}
            onValueChange={(value) => patch({
              providerId: value,
              executable: installations.find((item) => item.providerId === value)?.executable ?? ""
            })}
            options={providerOptions}
            placeholder={t("agents.editor.basic.providerPlaceholder")}
          />
        </Field>

        <Field label={t("agents.providers.executable")} htmlFor="agent-executable" error={errors.executable}>
          <Input
            id="agent-executable"
            value={form.executable}
            onChange={(event) => patch({ executable: event.target.value })}
            placeholder="codex / kimi / C:\\path\\to\\cli.exe"
            className="font-mono text-[13px]"
          />
        </Field>

        <Field label={t("agents.editor.basic.profile")} htmlFor="agent-profile">
          <Input
            id="agent-profile"
            value={form.profile}
            onChange={(event) => patch({ profile: event.target.value })}
            placeholder={t("agents.editor.basic.profilePlaceholder")}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label={t("agents.editor.basic.args")} hint={t("agents.editor.basic.argsHint")}>
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

        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card-hover px-3.5 py-3">
          <div>
            <p className="text-[13px] font-medium text-ink-2">{t("agents.editor.basic.enabled")}</p>
            <p className="text-xs text-ink-3">{t("agents.editor.basic.enabledHint")}</p>
          </div>
          <Switch
            checked={form.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
            aria-label={t("agents.editor.basic.enabled")}
          />
        </div>

        <div className="sm:col-span-2 rounded-xl border border-line bg-card-hover/50 p-3.5">
          <p className="mb-3 text-[13px] font-medium text-ink-2">
            {t("agents.editor.basic.credentials")}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  aria-label={showApiKey ? t("agents.editor.basic.hideKey") : t("agents.editor.basic.showKey")}
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
          </div>
        </div>
      </div>
    </Dialog>
  );
}
