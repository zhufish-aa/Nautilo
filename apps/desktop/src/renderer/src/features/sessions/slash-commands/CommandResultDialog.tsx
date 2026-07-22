import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { SlashCommandResult } from "@agenthub/domain";
import { Button } from "../../../components/ui/Button";
import { Dialog } from "../../../components/ui/Dialog";
import { cn } from "../../../lib/utils";

export function CommandResultDialog({
  result,
  loading,
  error,
  onClose,
  onAction
}: {
  result?: SlashCommandResult;
  loading: boolean;
  error?: string;
  onClose(): void;
  onAction(actionId: string, selectedOptionIds: string[]): void;
}): JSX.Element | null {
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setSelected(result?.selection?.options.filter((option) => option.selected).map((option) => option.id) ?? []);
  }, [result]);

  if (!result) return null;
  const selection = result.selection;
  const toggle = (id: string): void => {
    if (!selection) return;
    if (selection.mode === "single") setSelected([id]);
    else setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !loading) onClose(); }}
      title={result.title}
      description={result.description}
      widthClass="max-w-xl"
      footer={result.actions.map((action) => (
        <Button
          key={action.id}
          variant={action.kind === "primary" ? "primary" : action.kind === "danger" ? "danger" : "outline"}
          disabled={loading || (action.requiresSelection && selected.length < (selection?.minimum ?? 0))}
          onClick={() => action.id === "close" ? onClose() : onAction(action.id, selected)}
        >
          {loading && action.kind === "primary" && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
          {action.label}
        </Button>
      ))}
    >
      <div className="space-y-4">
        {result.sections.map((section, index) => {
          if (section.kind === "text") return <p key={index} className="text-sm leading-6 text-ink-2">{section.text}</p>;
          if (section.kind === "key_value") return (
            <dl key={index} className="overflow-hidden rounded-xl border border-line">
              {section.items.map((item) => (
                <div key={item.label} className="grid grid-cols-[128px_1fr] gap-3 border-b border-line px-4 py-3 last:border-b-0">
                  <dt className="text-xs text-ink-3">{item.label}</dt>
                  <dd className="min-w-0 break-words text-sm text-ink">{item.value}</dd>
                </div>
              ))}
            </dl>
          );
          return (
            <div key={index} className="space-y-1">
              {section.items.map((item) => (
                <div key={item.label} className="rounded-xl px-3 py-2.5 hover:bg-card-hover">
                  <div className="font-mono text-sm font-medium text-ink">{item.label}</div>
                  {item.description && <p className="mt-0.5 text-xs leading-5 text-ink-3">{item.description}</p>}
                </div>
              ))}
            </div>
          );
        })}

        {selection && (
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1" role={selection.mode === "single" ? "radiogroup" : "group"}>
            {selection.options.map((option) => {
              const checked = selected.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role={selection.mode === "single" ? "radio" : "checkbox"}
                  aria-checked={checked}
                  disabled={option.disabled}
                  onClick={() => toggle(option.id)}
                  className={cn(
                    "grid w-full grid-cols-[1fr_22px] items-center gap-3 rounded-xl border px-4 py-3 text-left outline-none transition-all focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-45",
                    checked ? "border-accent/55 bg-accent-soft/55" : "border-line bg-card hover:border-accent/30 hover:bg-card-hover"
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{option.label}</span>
                    {option.description && <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-ink-3">{option.description}</span>}
                  </span>
                  <span className={cn("grid h-5 w-5 place-items-center border", selection.mode === "single" ? "rounded-full" : "rounded-md", checked ? "border-accent bg-accent text-white" : "border-line-strong") }>
                    {checked && <Check className="h-3.5 w-3.5" aria-hidden />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {error && <p className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
