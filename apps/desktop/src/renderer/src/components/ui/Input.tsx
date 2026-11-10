import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { cn } from "../../lib/utils";

const fieldClasses =
  "ui-field w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink placeholder:text-ink-3/70 outline-none transition-colors hover:border-accent/40 focus:border-accent/60 focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-45";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(fieldClasses, "h-9.5", className)} {...rest} />;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea ref={ref} className={cn(fieldClasses, "min-h-20 resize-y py-2", className)} {...rest} />
    );
  }
);

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-2"><label htmlFor={htmlFor} className="text-sm font-medium text-ink-2">{label}</label>
        {hint && <Tooltip content={hint}><button type="button" aria-label={hint} className="rounded text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"><HelpCircle className="h-3.5 w-3.5" /></button></Tooltip>}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
