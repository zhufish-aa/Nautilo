import type { AdapterEvent, AdapterFileSnapshot } from "@agenthub/provider-sdk";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Native success is the evidence of a file change, never a tool input preview. */
export function completedFileChanges(part: Record<string, unknown>, raw: unknown): AdapterEvent[] {
  const state = object(part.state);
  const tool = String(part.tool ?? "");
  if (state.status !== "completed" || !["write", "edit", "apply_patch", "multiedit"].includes(tool)) return [];
  const metadata = object(state.metadata), input = object(state.input), filediff = object(metadata.filediff);
  const path = [filediff.file, metadata.filepath, input.filePath].find(value => typeof value === "string" && value.length > 0);
  if (typeof path !== "string") return [];
  const created = tool === "write" && metadata.exists === false;
  const snapshot: AdapterFileSnapshot | undefined = tool === "write" && typeof input.content === "string"
    ? { ...(created ? { before: "" } : {}), after: input.content } : undefined;
  return [{ kind: "file", path, changeType: created ? "added" : "modified", snapshot,
    diff: typeof filediff.patch === "string" ? filediff.patch : typeof metadata.diff === "string" ? metadata.diff : undefined,
    additions: typeof filediff.additions === "number" ? filediff.additions : undefined,
    deletions: typeof filediff.deletions === "number" ? filediff.deletions : undefined, raw }];
}
