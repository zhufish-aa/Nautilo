import { useRef, useState } from "react";
import type { VerificationCommandTemplate } from "@agenthub/domain";
import { CircleHelp, FlaskConical, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Input";
import { Tooltip } from "../../components/ui/Tooltip";
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
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [removing, setRemoving] = useState<VerificationCommandTemplate>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const valid =
    draft.name.trim().length > 0 &&
    draft.command.trim().length > 0 &&
    draft.scopes.length > 0 &&
    Number(draft.timeoutSeconds) > 0 &&
    Number.isFinite(Number(draft.timeoutSeconds));
  const patch = (value: Partial<TemplateDraft>): void =>
    setDraft((current) => ({ ...current, ...value }));
  const edit = (template?: VerificationCommandTemplate): void => {
    setEditingId(template?.id);
    setDraft(
      template
        ? {
            name: template.name,
            command: template.command,
            argsText: template.args.join("\n"),
            relativeCwd: template.relativeCwd ?? "",
            timeoutSeconds: String((template.timeoutMs ?? 300_000) / 1000),
            required: template.required,
            scopes: [...template.scopes]
          }
        : EMPTY_DRAFT
    );
    setError("");
    setOpen(true);
  };
  const save = async (): Promise<void> => {
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const template: VerificationCommandTemplate = {
        id: editingId ?? newId("verify"),
        name: draft.name.trim(),
        command: draft.command.trim(),
        args: draft.argsText
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        relativeCwd: draft.relativeCwd.trim() || undefined,
        timeoutMs: Math.round(Number(draft.timeoutSeconds) * 1000),
        required: draft.required,
        scopes: draft.scopes
      };
      await setTemplates(
        project.id,
        editingId
          ? project.verificationTemplates.map((item) => (item.id === editingId ? template : item))
          : [...project.verificationTemplates, template]
      );
      setOpen(false);
      toast.success(zh ? "验收命令模板已保存" : "Verification command saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (!removing || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      await setTemplates(
        project.id,
        project.verificationTemplates.filter((item) => item.id !== removing.id)
      );
      setRemoving(undefined);
      toast.info(zh ? "验收命令模板已移除" : "Verification command removed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const scopeNames: Record<VerificationScope, string> = {
    task: zh ? "任务" : "Task",
    run: zh ? "运行" : "Run",
    merge: zh ? "合并" : "Merge"
  };
  return (
    <section aria-labelledby="verification-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 id="verification-title" className="text-[15px] font-medium">
            {zh ? "验收模板" : "Verification commands"}
          </h2>
          <Tooltip
            content={
              zh
                ? "只执行已注册的命令。命令与参数分离，不通过 Shell 拼接。"
                : "Only registered commands run. Executables and arguments are separate, without shell composition."
            }
          >
            <button
              type="button"
              aria-label={zh ? "验收模板说明" : "About verification commands"}
              className="rounded p-1 text-ink-3 focus-visible:ring-2 focus-visible:ring-accent"
            >
              <CircleHelp className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
        <Button variant="ghost" size="sm" onClick={() => edit()}>
          <Plus className="h-4 w-4" aria-hidden />
          {zh ? "新增模板" : "Add command"}
        </Button>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {project.verificationTemplates.map((template) => (
          <li key={template.id} className="flex flex-wrap items-center gap-4 py-4">
            <FlaskConical className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <span className="min-w-0 flex-1 text-sm font-medium sm:w-48 sm:flex-none">
              {template.name}
            </span>
            <code
              className="order-last w-full truncate pl-8 font-mono text-sm text-ink-3 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:pl-0"
              title={[template.command, ...template.args].join(" ")}
            >
              {[template.command, ...template.args].join(" ")}
            </code>
            <Tooltip
              content={`${template.scopes.map((scope) => scopeNames[scope]).join(" · ")}${template.required ? (zh ? " · 失败时阻止完成" : " · Required") : ""}`}
            >
              <button
                type="button"
                aria-label={zh ? "查看模板适用范围" : "Command scope"}
                className="rounded p-1 text-ink-3 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <CircleHelp className="h-4 w-4" aria-hidden />
              </button>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${zh ? "编辑" : "Edit"} ${template.name}`}
              onClick={() => edit(template)}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${zh ? "移除" : "Remove"} ${template.name}`}
              onClick={() => {
                setError("");
                setRemoving(template);
              }}
            >
              <Trash2 className="h-4 w-4 text-ink-3" aria-hidden />
            </Button>
          </li>
        ))}
        {!project.verificationTemplates.length && (
          <li className="py-6 text-sm text-ink-3">
            {zh
              ? "还没有验收模板。添加需要运行的测试或检查命令。"
              : "No commands yet. Add a test or check to use for verification."}
          </li>
        )}
      </ul>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
        title={
          editingId
            ? zh
              ? "编辑验收模板"
              : "Edit verification command"
            : zh
              ? "新增验收模板"
              : "Add verification command"
        }
        widthClass="max-w-2xl"
        footer={
          <>
            <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button variant="primary" disabled={!valid || saving} onClick={() => void save()}>
              {saving && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
              {zh ? "保存" : "Save"}
            </Button>
          </>
        }
      >
        <fieldset disabled={saving} className="space-y-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label={zh ? "模板名称" : "Name"} htmlFor="verification-name">
              <Input
                id="verification-name"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder={zh ? "例如：类型检查" : "e.g. Type check"}
                autoFocus
              />
            </Field>
            <Field
              label={zh ? "可执行命令" : "Executable"}
              htmlFor="verification-command"
              hint={
                zh
                  ? "只填命令名称或路径，参数在下方单独填写。"
                  : "Enter a command name or path. Add arguments separately below."
              }
            >
              <Input
                id="verification-command"
                className="font-mono"
                value={draft.command}
                onChange={(event) => patch({ command: event.target.value })}
                placeholder="pnpm"
              />
            </Field>
          </div>
          <Field
            label={zh ? "参数（每行一个）" : "Arguments (one per line)"}
            htmlFor="verification-args"
          >
            <Textarea
              id="verification-args"
              className="font-mono"
              value={draft.argsText}
              onChange={(event) => patch({ argsText: event.target.value })}
              placeholder={"--filter\n@agenthub/desktop\ntest"}
            />
          </Field>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field
              label={zh ? "相对目录" : "Relative directory"}
              htmlFor="verification-cwd"
              hint={zh ? "留空使用项目根目录。" : "Leave blank to use the project root."}
            >
              <Input
                id="verification-cwd"
                className="font-mono"
                value={draft.relativeCwd}
                onChange={(event) => patch({ relativeCwd: event.target.value })}
                placeholder="apps/desktop"
              />
            </Field>
            <Field label={zh ? "超时（秒）" : "Timeout (seconds)"} htmlFor="verification-timeout">
              <Input
                id="verification-timeout"
                type="number"
                min="1"
                value={draft.timeoutSeconds}
                onChange={(event) => patch({ timeoutSeconds: event.target.value })}
              />
            </Field>
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-3 text-sm font-medium text-ink-2">
              {zh ? "适用范围" : "Applies to"}
            </legend>
            <div className="flex flex-wrap gap-5">
              {(["task", "run", "merge"] as VerificationScope[]).map((scope) => (
                <label key={scope} className="inline-flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--ink)]"
                    checked={draft.scopes.includes(scope)}
                    onChange={() =>
                      patch({
                        scopes: draft.scopes.includes(scope)
                          ? draft.scopes.filter((item) => item !== scope)
                          : [...draft.scopes, scope]
                      })
                    }
                  />
                  {scopeNames[scope]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--ink)]"
              checked={draft.required}
              onChange={(event) => patch({ required: event.target.checked })}
            />
            {zh ? "失败时阻止完成" : "Block completion on failure"}
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </fieldset>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!saving && !value) setRemoving(undefined);
        }}
        title={zh ? "移除验收模板？" : "Remove verification command?"}
        description={
          removing
            ? zh
              ? `“${removing.name}”将不再用于后续验收。`
              : `“${removing.name}” will no longer be used for verification.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" disabled={saving} onClick={() => setRemoving(undefined)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button variant="danger" disabled={saving} onClick={() => void remove()}>
              {saving && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
              {zh ? "移除" : "Remove"}
            </Button>
          </>
        }
      >
        <code className="block break-all rounded-lg bg-panel p-3 text-sm text-ink-3">
          {removing && [removing.command, ...removing.args].join(" ")}
        </code>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </Dialog>
    </section>
  );
}
