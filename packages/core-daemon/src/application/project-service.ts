import { randomUUID } from "node:crypto";
import type { Project } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { ProjectInspector } from "./project-inspector.js";
export class ProjectService {
  private readonly inspector = new ProjectInspector();
  constructor(private readonly database: Database) {}
  list(): Project[] { return this.database.projects.list(); }
  add(input: { rootPath: string; name?: string }): Project {
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name: input.name ?? input.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? "Project", rootPath: input.rootPath, repositoryType: "none" as const, frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default", createdAt: now, updatedAt: now } as Project;
    this.database.projects.save(project, now);
    return project;
  }
  remove(projectId: string): { removed: true } { this.database.projects.remove(projectId); return { removed: true }; }
  scan(projectId: string) {
    const project = this.database.projects.get(projectId);
    if (!project) throw new CoreError("IPC_NOT_FOUND", { resource: "project", id: projectId });
    const inspection = this.inspector.inspect(project);
    const updated = { ...project, repositoryType: inspection.git.isRepo ? "git" as const : "none" as const, defaultBranch: inspection.git.defaultBranch, frontendPaths: inspection.frontendPaths, backendPaths: inspection.backendPaths };
    this.database.projects.save(updated, inspection.scannedAt);
    return { project: updated, inspection };
  }
}
