import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { Project, VerificationCommandTemplate, VerificationResult } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { ProcessRuntime } from "../process-runtime.js";
import { ArtifactService } from "./artifact-service.js";
import { CommandPolicyService, EnvironmentPolicyService, RedactionService } from "./security/index.js";

export interface VerificationContext {
  projectRunId: string;
  taskId?: string;
  sessionId: string;
  scope: "task" | "run" | "merge";
  templateIds?: string[];
  onStarted?: (template: VerificationCommandTemplate, verificationId: string) => void;
  onFinished?: (result: VerificationResult) => void;
}

export class VerificationEngine {
  private readonly artifacts: ArtifactService;
  private readonly runtime = new ProcessRuntime();
  private readonly commandPolicies: CommandPolicyService;
  private readonly environment = new EnvironmentPolicyService();
  constructor(private readonly database: Database, private readonly redaction = new RedactionService()) {
    this.artifacts = new ArtifactService(database);
    this.commandPolicies = new CommandPolicyService(database);
  }

  async run(project: Project, workspacePath: string, context: VerificationContext): Promise<VerificationResult[]> {
    const registered = project.verificationTemplates ?? [];
    const selected = context.templateIds?.length
      ? context.templateIds.map((id) => registered.find((template) => template.id === id) ?? missingTemplate(id))
      : registered.filter((template) => template.scopes.includes(context.scope));
    const results: VerificationResult[] = [];
    for (const template of selected) {
      const verificationId = randomUUID();
      context.onStarted?.(template, verificationId);
      const cwd = safeCwd(workspacePath, template.relativeCwd);
      const evaluation = this.commandPolicies.evaluate({ policyId: project.policyId, command: template.command, args: template.args, source: "verification" });
      if (evaluation.action === "blocked") throw new CoreError("COMMAND_BLOCKED", { commandTemplateId: template.id, ruleId: evaluation.ruleId });
      if (evaluation.action === "approval") throw new CoreError("COMMAND_APPROVAL_REQUIRED", { commandTemplateId: template.id, ruleId: evaluation.ruleId });
      const started = Date.now();
      const handle = this.runtime.start({ command: template.command, args: template.args, cwd, env: this.environment.build(this.commandPolicies.get(project.policyId)), timeoutMs: template.timeoutMs, idleTimeoutMs: Math.min(template.timeoutMs, 5 * 60_000), maxOutputBytes: 5 * 1024 * 1024 });
      let output = "";
      let exitCode = -1;
      for await (const event of handle.events) {
        if (event.kind === "stdout" || event.kind === "stderr") output += event.text;
        else if (event.kind === "exit") exitCode = event.exitCode ?? -1;
        else if (event.kind === "timeout") output += `\n[Nautilo] ${event.reason}\n`;
        else if (event.kind === "error") output += `\n[Nautilo] ${event.error.message}\n`;
      }
      output = this.redaction.text(output);
      const artifact = this.artifacts.save({ kind: "test_report", name: `${template.name}.log`, content: output, projectRunId: context.projectRunId, taskId: context.taskId, sessionId: context.sessionId, metadata: { commandTemplateId: template.id, exitCode } });
      const result: VerificationResult = {
        id: verificationId,
        projectRunId: context.projectRunId,
        taskId: context.taskId,
        commandTemplateId: template.id,
        command: template.command,
        args: template.args,
        cwd,
        passed: exitCode === 0,
        required: template.required,
        exitCode,
        durationMs: Date.now() - started,
        outputArtifactId: artifact.id,
        createdAt: new Date().toISOString()
      };
      this.database.verifications.save(result);
      results.push(result);
      context.onFinished?.(result);
      if (!result.passed && result.required) break;
    }
    return results;
  }

  passed(results: VerificationResult[]): boolean { return results.every((result) => result.passed || !result.required); }
}

function missingTemplate(id: string): never { throw new CoreError("IPC_INVALID_REQUEST", { commandTemplateId: id }); }

function safeCwd(workspacePath: string, relativeCwd?: string): string {
  const root = resolve(workspacePath);
  const cwd = resolve(root, relativeCwd ?? ".");
  if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) throw new CoreError("PATH_POLICY_VIOLATION", { relativeCwd });
  return cwd;
}
