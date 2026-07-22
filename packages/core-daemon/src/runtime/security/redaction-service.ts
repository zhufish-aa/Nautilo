const SECRET_FIELD = /(?:api[_-]?key|token|secret|password|authorization|credential)/i;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{8,})\b/gi;
const SAFE_TELEMETRY_FIELD = /^(?:input|output|cachedInput|reasoningOutput)Tokens$/;

export class RedactionService {
  constructor(private readonly values: () => string[] = () => []) {}

  text(value: string): string {
    let result = value.replace(SECRET_PATTERN, "[REDACTED]");
    for (const secret of this.values().filter((item) => item.length >= 4)) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  }

  value<T>(input: T): T {
    return redact(input, this) as T;
  }
}

function redact(input: unknown, service: RedactionService, key?: string): unknown {
  if (key && !SAFE_TELEMETRY_FIELD.test(key) && SECRET_FIELD.test(key)) return "[REDACTED]";
  if (typeof input === "string") return service.text(input);
  if (Array.isArray(input)) return input.map((item) => redact(item, service));
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([field, value]) => [field, redact(value, service, field)]));
  return input;
}
