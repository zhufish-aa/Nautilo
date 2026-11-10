import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderSearch, Loader2 } from "lucide-react";
import { getBridge } from "../../lib/bridge";
import { normalizePath } from "../../lib/utils";
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
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const addProject = useProjectsStore((state) => state.addProject);
  const bridge = getBridge();

  const inFlight = useRef(false);
  const pickerSequence = useRef(0);
  const [addedId, setAddedId] = useState<string>();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const reset = (): void => {
    pickerSequence.current += 1;
    setAddedId(undefined);
    setRootPath("");
    setName("");
    setPending(false);
    setError(undefined);
  };

  const browse = async (): Promise<void> => {
    if (!bridge) return;
    const sequence = ++pickerSequence.current;
    try {
      const picked = await bridge.dialog.pickDirectory();
      if (sequence === pickerSequence.current && picked) setRootPath(picked);
    } catch (cause) {
      if (sequence === pickerSequence.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const submit = async (): Promise<void> => {
    if (inFlight.current || addedId) return;
    if (!rootPath.trim()) {
      setError(t("projects.pathLabel"));
      return;
    }
    pickerSequence.current += 1;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    setAddedId(undefined);
    const before = new Set(useProjectsStore.getState().projects.map((project) => project.id));
    try {
      const result = await addProject(rootPath, name || undefined);
      if (result === "duplicate") {
        setError(t("projects.duplicateToast"));
        return;
      }
      toast.success(t("projects.addedToast", { name: result.name }));
      onOpenChange(false);
      reset();
      navigate(`/projects/${encodeURIComponent(result.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const added = useProjectsStore
        .getState()
        .projects.find(
          (project) =>
            !before.has(project.id) && normalizePath(project.rootPath) === normalizePath(rootPath)
        );
      if (added) setAddedId(added.id);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
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
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              reset();
            }}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={pending || Boolean(addedId)}
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                {t("projects.scanning")}
              </>
            ) : (
              t("common.add")
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {addedId && (
          <div
            role="status"
            className="space-y-3 rounded-lg border border-line bg-panel p-4 text-sm text-ink-2"
          >
            <p>
              {zh
                ? "项目已添加，但扫描未完成。可以进入项目后重新扫描。"
                : "The project was added, but scanning did not finish. Open it to retry the scan."}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                const id = addedId;
                onOpenChange(false);
                reset();
                navigate(`/projects/${encodeURIComponent(id)}`);
              }}
            >
              {zh ? "查看项目" : "Open project"}
            </Button>
          </div>
        )}
        <Field label={t("projects.pathLabel")} htmlFor="project-path" error={error}>
          <div className="flex gap-2">
            <Input
              id="project-path"
              aria-invalid={Boolean(error)}
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={t("projects.pathPlaceholder")}
              className="font-mono text-sm"
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
          <p className="rounded-lg border border-line bg-panel px-3 py-3 text-sm text-ink-3">
            {t("projects.browserPickerHint")}
          </p>
        )}
        <Field
          label={`${t("projects.nameLabel")} (${t("common.optional")})`}
          htmlFor="project-name"
        >
          <Input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("projects.namePlaceholder")}
            disabled={pending}
          />
        </Field>
        <p className="text-sm leading-relaxed text-ink-3">{t("projects.scanHint")}</p>
      </div>
    </Dialog>
  );
}
