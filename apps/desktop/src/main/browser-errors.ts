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
): Promise<T> {
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
                { operation: label, timeoutMs: milliseconds },
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

export function browserError(error: unknown) {
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
