import { useState } from "react";
import type { VerificationCommandTemplate } from "@agenthub/domain";
import { FlaskConical, Plus, Save, Trash2 } from "lucide-react";
import { MotionCard } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { useI18n } from "../../lib/i18n";
import type { UiProject } from "../../lib/types";
import { newId } from "../../lib/utils";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";

type VerificationScope = VerificationCommandTemplate["scopes"][number];

interface TemplateDraft {
  name: string;
  command: string;
  argsText: string;
  relativeCwd: string;
  timeoutSeconds: string;
  required: boolean;
  scopes: VerificationScope[];
}

const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  command: "",
  argsText: "",
  relativeCwd: "",
  timeoutSeconds: "300",
  required: true,
  scopes: ["task", "run", "merge"]
};

export function VerificationTemplatesCard({ project }: { project: UiProject }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const setTemplates = useProjectsStore((state) => state.setVerificationTemplates);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const valid = draft.name.trim().length > 0 && draft.command.trim().length > 0 && draft.scopes.length > 0;

  const toggleScope = (scope: VerificationScope): void => {
    setDraft((current) => ({
      ...current,
      scopes: current.scopes.includes(scope)
        ? current.scopes.filter((item) => item !== scope)
        : [...current.scopes, scope]
    }));
  };

  const addTemplate = async (): Promise<void> => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const timeoutSeconds = Number(draft.timeoutSeconds);
      const template: VerificationCommandTemplate = {
        id: newId("verify"),
        name: draft.name.trim(),
        command: draft.command.trim(),
        args: draft.argsText.split("\n").map((item) => item.trim()).filter(Boolean),
        relativeCwd: draft.relativeCwd.trim() || undefined,
        timeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.round(timeoutSeconds * 1000) : 300_000,
        required: draft.required,
        scopes: draft.scopes
      };
      await setTemplates(project.id, [...project.verificationTemplates, template]);
      setDraft(EMPTY_DRAFT);
      toast.success(zh ? "验收命令模板已保存" : "Verification command saved");
    } finally {
      setSaving(false);
    }
  };

  const removeTemplate = async (templateId: string): Promise<void> => {
    await setTemplates(project.id, project.verificationTemplates.filter((template) => template.id !== templateId));
    toast.info(zh ? "验收命令模板已移除" : "Verification command removed");
  };

  return (
    <MotionCard className="p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/20 bg-accent-soft text-accent">
          <FlaskConical className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">{zh ? "验收命令模板" : "Verification commands"}</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            {zh ? "运行时只会执行这里注册的命令；命令与参数分离，不通过 Shell 拼接。" : "Only registered commands run; executable and arguments stay separate without shell composition."}
          </p>
        </div>
      </div>

      {project.verificationTemplates.length > 0 && (
        <ul className="mb-5 space-y-2">
          {project.verificationTemplates.map((template) => (
            <li key={template.id} className="flex items-start gap-3 rounded-xl border border-line bg-card-hover px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{template.name}</span>
                  <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{template.scopes.join(" · ")}</span>
                  {template.required && <span className="text-[10px] text-warn">{zh ? "必需" : "required"}</span>}
                </div>
                <code className="mt-1 block truncate font-mono text-xs text-ink-3" title={[template.command, ...template.args].join(" ")}>
                  {[template.command, ...template.args].join(" ")}
                </code>
              </div>
              <Button variant="ghost" size="icon" aria-label={zh ? "删除模板" : "Remove template"} onClick={() => void removeTemplate(template.id)}>
                <Trash2 className="h-4 w-4 text-danger" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={zh ? "模板名称" : "Template name"}>
          <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={zh ? "例如：前端测试" : "e.g. Frontend tests"} />
        </Field>
        <Field label={zh ? "可执行命令" : "Executable"} hint={zh ? "例如 pnpm、npm、go；不要填整段 Shell。" : "For example pnpm, npm, or go; do not enter a shell script."}>
          <Input className="font-mono" value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} placeholder="pnpm" />
        </Field>
        <Field label={zh ? "参数（每行一个）" : "Arguments (one per line)"}>
          <Textarea className="font-mono" value={draft.argsText} onChange={(event) => setDraft((current) => ({ ...current, argsText: event.target.value }))} placeholder={"--filter\n@agenthub/desktop\ntest"} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={zh ? "相对目录" : "Relative cwd"} hint={zh ? "留空表示项目根目录" : "Blank uses the project root"}>
            <Input className="font-mono" value={draft.relativeCwd} onChange={(event) => setDraft((current) => ({ ...current, relativeCwd: event.target.value }))} placeholder="apps/desktop" />
          </Field>
          <Field label={zh ? "超时（秒）" : "Timeout (seconds)"}>
            <Input type="number" min="1" value={draft.timeoutSeconds} onChange={(event) => setDraft((current) => ({ ...current, timeoutSeconds: event.target.value }))} />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
          {(["task", "run", "merge"] as VerificationScope[]).map((scope) => (
            <label key={scope} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={draft.scopes.includes(scope)} onChange={() => toggleScope(scope)} />
              {scope}
            </label>
          ))}
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={draft.required} onChange={(event) => setDraft((current) => ({ ...current, required: event.target.checked }))} />
            {zh ? "失败时阻止完成" : "Block completion on failure"}
          </label>
        </div>
        <Button variant="primary" size="sm" disabled={!valid || saving} onClick={() => void addTemplate()}>
          {project.verificationTemplates.length === 0 ? <Plus className="h-3.5 w-3.5" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
          {saving ? (zh ? "保存中…" : "Saving…") : (zh ? "添加模板" : "Add template")}
        </Button>
      </div>
    </MotionCard>
  );
}
