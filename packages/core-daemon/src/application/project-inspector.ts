import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Project, ProjectInspection } from "@agenthub/domain";

export class ProjectInspector {
  inspect(project: Project): ProjectInspection {
    const git = this.inspectGit(project.rootPath);
    const stacks = this.inspectStack(project.rootPath);
    const frontendPaths = existing(project.rootPath, ["apps/web", "apps/desktop/src/renderer", "src/components", "src/pages", "app"]);
    const backendPaths = existing(project.rootPath, ["apps/api", "packages/core-daemon", "server", "api", "src/services"]);
    return {
      projectId: project.id,
      scannedAt: new Date().toISOString(),
      git,
      stacks,
      frontendPaths,
      backendPaths,
      risks: existsSync(project.rootPath) ? [] : [{ id: "path-missing", level: "critical", textKey: "risk.pathMissing", detail: project.rootPath }]
    };
  }

  private inspectGit(rootPath: string): ProjectInspection["git"] {
    if (!existsSync(rootPath)) return { isRepo: false, dirtyFiles: 0 };
    const top = git(rootPath, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) return { isRepo: false, dirtyFiles: 0 };
    const status = git(rootPath, ["status", "--porcelain"]);
    const branch = git(rootPath, ["branch", "--show-current"]);
    const remote = git(rootPath, ["remote", "get-url", "origin"]);
    const defaultBranch = git(rootPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return {
      isRepo: true,
      branch: branch.value || undefined,
      defaultBranch: defaultBranch.value.replace(/^origin\//, "") || branch.value || undefined,
      remote: remote.ok ? remote.value : undefined,
      dirtyFiles: status.value ? status.value.split(/\r?\n/).filter(Boolean).length : 0
    };
  }

  private inspectStack(rootPath: string): ProjectInspection["stacks"] {
    const stacks: ProjectInspection["stacks"] = [];
    if (existsSync(join(rootPath, "tsconfig.json"))) stacks.push({ name: "TypeScript", kind: "language", confidence: 99 });
    if (existsSync(join(rootPath, "pnpm-workspace.yaml"))) stacks.push({ name: "pnpm workspace", kind: "tooling", confidence: 99 });
    if (existsSync(join(rootPath, "go.mod"))) stacks.push({ name: "Go", kind: "language", confidence: 99 });
    if (existsSync(join(rootPath, "Cargo.toml"))) stacks.push({ name: "Rust", kind: "language", confidence: 99 });
    const packageJson = readPackageJson(rootPath);
    const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies } as Record<string, string>;
    for (const [dependency, name, kind] of [["react", "React", "framework"], ["vue", "Vue", "framework"], ["electron", "Electron", "runtime"], ["vite", "Vite", "tooling"]] as const) {
      if (dependencies?.[dependency]) stacks.push({ name, kind, detail: dependencies[dependency], confidence: 98 });
    }
    return stacks;
  }
}

function existing(root: string, candidates: string[]): string[] {
  return candidates.filter((candidate) => existsSync(join(root, candidate)));
}

function git(cwd: string, args: string[]): { ok: boolean; value: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  return { ok: result.status === 0, value: String(result.stdout ?? "").trim() };
}

function readPackageJson(rootPath: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined {
  try { return JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }; }
  catch { return undefined; }
}
