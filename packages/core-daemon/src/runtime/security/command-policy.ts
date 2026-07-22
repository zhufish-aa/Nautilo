import type { CommandPolicyAction, PermissionPolicy } from "@agenthub/domain";
import { basename } from "node:path";
import { Database } from "../../database/index.js";

export interface CommandEvaluation {
  action: CommandPolicyAction;
  ruleId?: string;
  reason: string;
}

export class CommandPolicyService {
  constructor(private readonly database: Database) { this.ensureDefault(); }
  list(): PermissionPolicy[] { return this.database.policies.list(); }
  get(id: string): PermissionPolicy { return this.database.policies.get(id) ?? this.database.policies.get("default")!; }
  save(policy: PermissionPolicy): PermissionPolicy { this.database.policies.save(policy, policy.updatedAt); return policy; }

  evaluate(input: { policyId?: string; command: string; args?: string[]; source: "agent" | "verification" | "system" }): CommandEvaluation {
    const policy = this.get(input.policyId ?? "default");
    const executable = basename(input.command).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
    const args = input.args ?? [];
    const rule = policy.commandRules.find((candidate) => {
      if (candidate.sources?.length && !candidate.sources.includes(input.source)) return false;
      if (candidate.executable && candidate.executable !== "*" && candidate.executable.toLowerCase() !== executable) return false;
      return !candidate.argsPrefix?.length || candidate.argsPrefix.every((value, index) => args[index]?.toLowerCase() === value.toLowerCase());
    });
    return { action: rule?.action ?? policy.defaultCommandAction, ruleId: rule?.id, reason: rule?.description ?? `Default ${policy.defaultCommandAction} policy` };
  }

  private ensureDefault(): void {
    if (this.database.policies.get("default")) return;
    const policy: PermissionPolicy = {
      id: "default",
      name: "Default local safety policy",
      defaultCommandAction: "approval",
      environmentAllowlist: DEFAULT_KEYS,
      allowedPaths: [],
      commandRules: [
        { id: "block-rm", action: "blocked", executable: "rm", description: "Recursive deletion is blocked by default" },
        { id: "block-format", action: "blocked", executable: "format", description: "Disk formatting is blocked" },
        { id: "block-force-push", action: "blocked", executable: "git", argsPrefix: ["push", "--force"], description: "Force push is blocked" },
        { id: "safe-agent-launch", action: "safe", executable: "*", sources: ["agent"], description: "Configured Agent CLI launch" },
        { id: "safe-registered-verification", action: "safe", executable: "*", sources: ["verification"], description: "Project-registered verification command" },
        { id: "safe-system", action: "safe", executable: "*", sources: ["system"], description: "AgentHub internal command" }
      ],
      updatedAt: new Date().toISOString()
    };
    this.database.policies.save(policy, policy.updatedAt);
  }
}

const DEFAULT_KEYS = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]
  : ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"];
