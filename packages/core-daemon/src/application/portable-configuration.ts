/** Portable configuration never carries native account storage or credentials. */
export function portableConfiguration(value: unknown, key = ""): unknown {
  if (
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential|loginProfileDirectory|hasCredential)/i.test(
      key,
    )
  )
    return undefined;
  if (Array.isArray(value)) return value.map((v) => portableConfiguration(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, v]) => {
        const n = portableConfiguration(v, k);
        return n === undefined ? [] : [[k, n]];
      }),
    );
  return typeof value === "string" &&
    /^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)/.test(value)
    ? undefined
    : value;
}
