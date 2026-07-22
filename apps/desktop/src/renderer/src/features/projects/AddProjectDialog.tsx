import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderSearch, Loader2 } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";

export function AddProjectDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const addProject = useProjectsStore((state) => state.addProject);
  const bridge = getBridge();

  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const reset = (): void => {
    setRootPath("");
    setName("");
    setPending(false);
    setError(undefined);
  };

  const browse = async (): Promise<void> => {
    if (!bridge) return;
    const picked = await bridge.dialog.pickDirectory();
    if (picked) setRootPath(picked);
  };

  const submit = async (): Promise<void> => {
    if (!rootPath.trim()) {
      setError(t("projects.pathLabel"));
      return;
    }
    setPending(true);
    setError(undefined);
    const result = await addProject(rootPath, name || undefined);
    if (result === "duplicate") {
      setPending(false);
      toast.error(t("projects.duplicateToast"));
      return;
    }
    toast.success(t("projects.addedToast", { name: result.name }));
    onOpenChange(false);
    reset();
    navigate(`/projects/${result.id}`);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          onOpenChange(next);
          if (!next) reset();
        }
      }}
      title={t("projects.addTitle")}
      description={t("projects.addDesc")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {t("projects.scanning")}
              </>
            ) : (
              t("common.add")
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("projects.pathLabel")} htmlFor="project-path" error={error}>
          <div className="flex gap-2">
            <Input
              id="project-path"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={t("projects.pathPlaceholder")}
              className="font-mono text-[13px]"
              autoFocus
              disabled={pending}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            {bridge && (
              <Button
                variant="outline"
                onClick={() => void browse()}
                disabled={pending}
                aria-label={t("common.browse")}
              >
                <FolderSearch className="h-4 w-4" aria-hidden />
                {t("common.browse")}
              </Button>
            )}
          </div>
        </Field>
        {!bridge && (
          <p className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-xs text-warn">
            {t("projects.browserPickerHint")}
          </p>
        )}
        <Field label={`${t("projects.nameLabel")} (${t("common.optional")})`} htmlFor="project-name">
          <Input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("projects.namePlaceholder")}
            disabled={pending}
          />
        </Field>
        <p className="text-xs text-ink-3">{t("projects.scanHint")}</p>
      </div>
    </Dialog>
  );
}
