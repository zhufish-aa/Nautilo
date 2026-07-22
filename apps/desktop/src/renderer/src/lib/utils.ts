import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/** Normalize a filesystem path for duplicate comparison (Windows-insensitive). */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function newId(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${uuid}`;
}

export type LocaleCode = "zh-CN" | "en-US";

const RELATIVE_STEPS: Array<{ limit: number; unit: Intl.RelativeTimeFormatUnit; size: number }> = [
  { limit: 60, unit: "second", size: 1 },
  { limit: 3600, unit: "minute", size: 60 },
  { limit: 86400, unit: "hour", size: 3600 },
  { limit: 604800, unit: "day", size: 86400 },
  { limit: 2592000, unit: "week", size: 604800 },
  { limit: 31536000, unit: "month", size: 2592000 },
  { limit: Number.POSITIVE_INFINITY, unit: "year", size: 31536000 }
];

export function formatRelativeTime(iso: string, locale: LocaleCode): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diffSeconds = Math.round((time - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const step = RELATIVE_STEPS.find((candidate) => abs < candidate.limit)!;
  const value = Math.round(diffSeconds / step.size);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, step.unit);
}

export function formatDateTime(iso: string, locale: LocaleCode): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
