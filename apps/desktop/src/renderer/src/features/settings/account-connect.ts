import type { RuntimeConnection } from "@agenthub/domain";
import type { ConnectionDraft } from "../../stores/connections";
export type AccountHarness = "codex" | "claude-code" | "antigravity";
export const ACCOUNT_HARNESSES: AccountHarness[] = ["codex", "claude-code", "antigravity"];
export const accountHarnessName = (harness: string): string => ({ codex: "Codex", "claude-code": "Claude Code", antigravity: "Antigravity" } as Record<string, string>)[harness] ?? harness;
export type ConnectStage = "detecting" | "preparing" | "login" | "saving";
export interface AccountConnectDependencies {
  detect(harness: AccountHarness): Promise<string>;
  prepare(harness: AccountHarness): Promise<{ profileId: string; directory: string }>;
  start(input: { profileId: string; providerId: string; executable: string; directory: string }): Promise<{ ok: boolean; reason?: string }>;
  status(profileId: string): Promise<{ state: string; reason?: string }>;
  cancel(profileId: string): Promise<void>;
  save(connection: ConnectionDraft): Promise<RuntimeConnection>;
  reusePrepared?: boolean;
  acknowledge?: (profileId: string, providerId: AccountHarness) => Promise<void>;
  wait?: (signal: AbortSignal) => Promise<void>;
}
function check(signal: AbortSignal): void { if (signal.aborted) throw new DOMException("Account login cancelled", "AbortError"); }
function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); reject(new DOMException("Account login cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 1000);
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
  });
}
/** No connection exists until the official login process reports successful exit. */
export async function connectOfficialAccount(harness: AccountHarness, name: string, signal: AbortSignal, stage: (value: ConnectStage) => void, deps: AccountConnectDependencies): Promise<RuntimeConnection> {
  let profileId: string | undefined;
  let finished = false;
  try {
    check(signal); stage("detecting"); const executable = await deps.detect(harness); check(signal);
    stage("preparing"); const profile = await deps.prepare(harness); profileId = `${profile.profileId}:${profile.directory}`; check(signal);
    stage("login");
    const previous = deps.reusePrepared ? await deps.status(profileId) : undefined; check(signal);
    if (previous?.state !== "running" && previous?.state !== "succeeded") {
      const result = await deps.start({ profileId, directory: profile.directory, providerId: harness, executable }); check(signal);
      if (!result.ok) throw new Error(result.reason || "Official CLI login could not start");
    }
    for (;;) {
      check(signal); const status = await deps.status(profileId); check(signal);
      if (status.state === "succeeded") break;
      if (status.state !== "running") throw new Error(status.reason || "Official login did not complete. The account has not been added.");
      await (deps.wait ?? wait)(signal);
    }
    finished = true; check(signal); stage("saving");
    const saved = await deps.save({ id: profile.profileId, name, kind: "login", enabled: true, harness, loginProfileDirectory: profile.directory, ...(harness === "antigravity" ? { nativeLogin: true } : {}), models: [] });
    // Acknowledgement only removes recovery metadata, never credentials.
    await deps.acknowledge?.(profile.profileId, harness).catch(() => undefined);
    return saved;
  } finally { if (profileId && !finished) await deps.cancel(profileId).catch(() => undefined); }
}
