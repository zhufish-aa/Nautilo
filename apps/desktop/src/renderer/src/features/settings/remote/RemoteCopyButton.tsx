import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "../../../stores/toast";

export function RemoteCopyButton({ value, label, zh }: { value: string; label: string; zh: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error(zh ? "复制失败，请重试" : "Copy failed");
    }
  };
  const title = copied ? (zh ? "已复制" : "Copied") : label;
  return <button type="button" className="remote-icon-button remote-copy" data-copied={copied}
    title={title} aria-label={title} onClick={() => void copy()}>
    {copied ? <Check size={15} aria-hidden /> : <Copy size={14} aria-hidden />}
    <span className="remote-copy-feedback" role="status">{copied ? title : ""}</span>
  </button>;
}
