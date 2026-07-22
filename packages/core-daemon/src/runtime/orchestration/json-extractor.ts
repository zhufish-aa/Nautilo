/** Extracts the last balanced JSON object from a provider's text response. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const direct = tryParse(unfenced);
  if (direct !== undefined) return direct;

  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1));
    }
  }
  for (const candidate of candidates.reverse()) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }
  throw new Error("No valid JSON object was found in the Agent response");
}

function tryParse(value: string): unknown | undefined {
  try { return JSON.parse(value) as unknown; }
  catch { return undefined; }
}
