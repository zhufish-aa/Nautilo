import type { RuntimeConnection } from "@agenthub/domain";
import type { AdapterStartRequest } from "../adapters/index.js";
import { resolveCodexInvocation } from "../adapters/codex/executable.js";
import { CoreError } from "../errors.js";
import { ProcessRuntime } from "../process-runtime.js";

export function isAccountAuthenticationError(message: string): boolean {
  return /AGENT_NOT_AUTHENTICATED|authentication required|not logged in|signed out|sign in (?:to this account )?again|401 unauthorized|http 401|status 401|token[_ ](?:has[_ ])?expired|invalid_grant|refresh_token_(?:reused|expired|revoked)|missing bearer or basic authentication/i.test(message);
}

export function accountLoginRequired(account: RuntimeConnection): CoreError {
  const error = new CoreError("AGENT_NOT_AUTHENTICATED", {
    connectionId: account.id,
    reason: `账号“${account.name}”登录已失效，请重新登录。`,
  });
  error.message = `账号“${account.name}”登录已失效，请重新登录。`;
  error.descriptor.message = error.message;
  return error;
}

export async function checkNativeAccountLogin(account: RuntimeConnection, request: AdapterStartRequest): Promise<void> {
  if (account.harness === "antigravity") return; // Official ACP reports authentication on its own connection.
  const args = [...request.instance.baseArgs, ...(account.harness === "codex" ? ["login", "status"] : ["auth", "status", "--json"])];
  const invocation = account.harness === "codex"
    ? resolveCodexInvocation(request.instance.executable, args, request.env?.PATH)
    : { command: request.instance.executable, args };
  const handle = new ProcessRuntime().start({ ...invocation, cwd: request.cwd, env: request.env, timeoutMs: 8_000, maxOutputBytes: 64 * 1024 });
  let output = "";
  let exit: number | undefined | null;
  for await (const event of handle.events) {
    if (event.kind === "stdout" || event.kind === "stderr") output += event.text;
    if (event.kind === "exit") exit = event.exitCode;
    if (event.kind === "timeout") throw new CoreError("RUN_START_FAILED", { reason: "账号登录状态检查超时，请重试。" });
  }
  let signedOut = isAccountAuthenticationError(output);
  try { signedOut ||= JSON.parse(output).loggedIn === false; } catch { /* Codex returns plain text. */ }
  if (signedOut) throw accountLoginRequired(account);
  if (exit !== 0) throw new CoreError("RUN_START_FAILED", { reason: "无法检查所选账号的登录状态，请查看原生 CLI 是否正常。" });
}
