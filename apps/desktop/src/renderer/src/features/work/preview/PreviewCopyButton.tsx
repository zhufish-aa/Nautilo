import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "../../../lib/i18n";

export function PreviewCopyButton({ value, label, children, shortcut }: { value: string; label: string; children?: ReactNode; shortcut?: string }): JSX.Element {
  const { locale } = useI18n();
  const [feedback, setFeedback] = useState<"copied" | "failed">();
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    let result: "copied" | "failed" = "copied";
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      result = "failed";
    }
    if (!button.current) return;
    window.clearTimeout(timer.current);
    setFeedback(result);
    timer.current = window.setTimeout(() => setFeedback(undefined), 1500);
  }

  const zh = locale === "zh-CN";
  const status = feedback === "copied" ? (zh ? "已复制" : "Copied")
    : feedback === "failed" ? (zh ? "复制失败" : "Copy failed") : undefined;
  return (
    <button ref={button} type="button" className="preview-tool preview-copy" data-feedback={feedback} data-path-label={!!children}
      aria-label={label} title={status ?? (children ? value : label) + (shortcut ? " (" + shortcut + ")" : "")} onClick={() => void copy()}>
      {children}
      {feedback === "copied" ? <Check className="preview-copy-check" size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span className="preview-copy-feedback" role="status">{status}</span>
    </button>
  );
}
