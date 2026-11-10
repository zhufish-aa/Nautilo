export class BrowserToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly recovery?: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "BrowserToolError";
  }
}

export async function browserDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
  timeoutClass?: string,
): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserToolError(
                "browser_operation_timeout",
                "The browser did not answer the requested operation in time.",
                { operation: label, timeoutMs: milliseconds, timeout_ms: milliseconds,
                  timeout_class: timeoutClass ?? browserTimeoutClass(label), elapsed_ms: Date.now() - started },
                "Inspect the current tab before retrying; a navigation or page dialog may still be pending.",
              ),
            ),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function browserTimeoutClass(operation: string) {
  if (/viewport|content.type|probe|position/i.test(operation)) return "probe";
  if (/eval|Runtime\./i.test(operation)) return "eval";
  if (/popup|new.tab/i.test(operation)) return "popup";
  if (/navigat|loadURL|reload/i.test(operation)) return "navigation";
  if (/read|snapshot|Accessibility|DOM\.(get|describe)/i.test(operation)) return "read";
  return "action";
}

export function browserError(error: unknown): {code:string;message:string;retryable:boolean;recovery?:string;[key:string]:any} {
  if (error instanceof BrowserToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      recovery: error.recovery,
      ...error.details,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /could not find (?:object|node) with given (?:backend )?id|no node with given id|node is detached from document/i.test(
      message,
    )
  )
    return {
      code: "stale_ref",
      message,
      retryable: true,
      recovery:
        "The element or remote object is no longer valid. Read a fresh snapshot and retry only the unfinished steps with a new ref or locator.",
    };
  return {
    code: "browser_error",
    message,
    retryable: true,
    recovery:
      "Inspect the current tab before retrying any action that may already have run.",
  };
}
