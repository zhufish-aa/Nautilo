import type { AgentInstance, Project, ProjectInspection, Session, TeamDefinition } from "@agenthub/domain";
import { providerMeta } from "./provider-catalog";
import type { AgentInstanceConfig, ProjectScanResult, UiProject, UiSession, UiTeam } from "./types";

/** UI catalog id → Core Daemon provider id (only custom-cli differs). */
export function toDaemonProviderId(providerId: string): string {
  return providerId === "custom-cli" ? "custom" : providerId;
}

/** Core Daemon provider id → UI catalog id. */
export function toUiProviderId(providerId: string): string {
  return providerId === "custom" ? "custom-cli" : providerId;
}

export function toDomainAgent(instance: AgentInstanceConfig): AgentInstance {
  return {
    id: instance.id,
    providerId: instance.providerId === "custom-cli" ? "custom" : instance.providerId,
    displayName: instance.displayName,
    executable: instance.executable,
    baseArgs: instance.baseArgs,
    profile: instance.profile,
    models: instance.models?.length ? instance.models : undefined,
    providerOptions: {
      envPolicyId: instance.envPolicyId,
      ...(instance.permissionMode ? { permissionMode: instance.permissionMode } : {}),
      ...(instance.baseUrl ? { baseUrl: instance.baseUrl } : {}),
      ...(instance.apiType ? { apiType: instance.apiType } : {}),
      ...(instance.wireApi ? { wireApi: instance.wireApi } : {}),
      ...(instance.webSearchMode ? { webSearchMode: instance.webSearchMode } : {}),
      ...(instance.webSearchInstanceId ? { webSearchInstanceId: instance.webSearchInstanceId } : {}),
      ...(instance.webSearchModel ? { webSearchModel: instance.webSearchModel } : {}),
      ...(instance.webSearchReasoningEffort ? { webSearchReasoningEffort: instance.webSearchReasoningEffort } : {})
    },
    capabilities: providerMeta(instance.providerId).capabilities,
    enabled: instance.enabled,
    status: instance.status,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt
  };
}

export function toUiAgent(instance: AgentInstance): AgentInstanceConfig {
  return {
    id: instance.id,
    providerId: instance.providerId === "custom" ? "custom-cli" : instance.providerId,
    displayName: instance.displayName,
    executable: instance.executable,
    baseArgs: instance.baseArgs,
    profile: instance.profile,
    envPolicyId: typeof instance.providerOptions?.envPolicyId === "string" ? instance.providerOptions.envPolicyId : "env-standard",
    permissionMode: typeof instance.providerOptions?.permissionMode === "string" ? instance.providerOptions.permissionMode : undefined,
    baseUrl: typeof instance.providerOptions?.baseUrl === "string" ? instance.providerOptions.baseUrl : undefined,
    apiType: typeof instance.providerOptions?.apiType === "string" ? instance.providerOptions.apiType : undefined,
    wireApi: instance.providerOptions?.wireApi === "chat" ? "chat" : "responses",
    webSearchMode: instance.providerOptions?.webSearchMode === "official" || instance.providerOptions?.webSearchMode === "off"
      ? instance.providerOptions.webSearchMode
      : instance.providerOptions?.wireApi === "chat" ? "off" : "native",
    webSearchInstanceId: typeof instance.providerOptions?.webSearchInstanceId === "string" ? instance.providerOptions.webSearchInstanceId : undefined,
    webSearchModel: typeof instance.providerOptions?.webSearchModel === "string" ? instance.providerOptions.webSearchModel : undefined,
    webSearchReasoningEffort: typeof instance.providerOptions?.webSearchReasoningEffort === "string" ? instance.providerOptions.webSearchReasoningEffort : undefined,
    models: instance.models,
    enabled: instance.enabled,
    status: instance.status,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt
  };
}

export function toDomainTeam(team: UiTeam): TeamDefinition {
  const roles = [...new Map(team.members.map((member) => [member.role.id, {
    ...member.role,
    permissionPolicyId: member.role.permissionPolicyId ?? "default"
  }])).values()];
  return {
    id: team.id,
    name: team.name,
    delegationPolicy: team.delegationPolicy,
    roles,
    members: team.members.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      agentInstanceId: member.agentInstanceId,
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      serviceTier: member.serviceTier,
      roleId: member.role.id,
      strengths: member.role.strengths,
      allowedTaskTypes: member.allowedTaskTypes,
      maxConcurrentTasks: member.maxConcurrentTasks,
      enabled: member.enabled
    })),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt
  };
}

export function toUiTeam(team: TeamDefinition): UiTeam {
  const roles = new Map((team.roles ?? []).map((role) => [role.id, role]));
  return {
    id: team.id,
    name: team.name,
    delegationPolicy: team.delegationPolicy,
    members: team.members.map((member) => {
      const role = roles.get(member.roleId);
      return {
        id: member.id,
        displayName: member.displayName,
        agentInstanceId: member.agentInstanceId,
        model: member.model,
        reasoningEffort: member.reasoningEffort,
        serviceTier: member.serviceTier,
        role: role ? {
          id: role.id,
          name: role.name,
          description: role.description,
          responsibilities: role.responsibilities,
          strengths: role.strengths,
          limitations: role.limitations,
          systemInstructions: role.systemInstructions,
          permissionPolicyId: role.permissionPolicyId ?? "default"
        } : {
          id: member.roleId,
          name: member.roleId,
          description: "",
          responsibilities: [],
          strengths: member.strengths,
          limitations: [],
          systemInstructions: "",
          permissionPolicyId: "default"
        },
        allowedTaskTypes: member.allowedTaskTypes,
        maxConcurrentTasks: member.maxConcurrentTasks,
        enabled: member.enabled
      };
    }),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt
  };
}

export function toUiProject(project: Project, inspection?: ProjectInspection, previous?: UiProject): UiProject {
  const now = new Date().toISOString();
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    repositoryType: project.repositoryType,
    workspaceMode: project.workspaceMode ?? "direct",
    scan: inspection ? toUiInspection(inspection) : previous?.scan,
    scanning: false,
    activeRun: previous?.activeRun,
    verificationTemplates: project.verificationTemplates ?? previous?.verificationTemplates ?? [],
    addedAt: previous?.addedAt ?? now,
    lastOpenedAt: previous?.lastOpenedAt
  };
}

export function toUiInspection(inspection: ProjectInspection): ProjectScanResult {
  return {
    scannedAt: inspection.scannedAt,
    git: inspection.git,
    stacks: inspection.stacks,
    frontendPaths: inspection.frontendPaths,
    backendPaths: inspection.backendPaths,
    risks: inspection.risks
  };
}

export function toDomainProject(project: UiProject): Project {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    repositoryType: project.repositoryType,
    workspaceMode: project.workspaceMode,
    defaultBranch: project.scan?.git.defaultBranch,
    frontendPaths: project.scan?.frontendPaths ?? [],
    backendPaths: project.scan?.backendPaths ?? [],
    ignoredPaths: [],
    policyId: "default",
    verificationTemplates: project.verificationTemplates
  };
}

export function toStandaloneUiSession(session: Session): UiSession {
  return {
    id: session.id,
    projectId: session.projectId,
    // Mirror MemberRouter.resolveSession: an explicit agentInstanceId means an
    // agent-targeted session; a teamId without one is member-routed (delegated
    // child sessions persist agentInstanceId as null). Falling back to memberId
    // here would corrupt the target and later fail with "Agent instance
    // <memberId> is missing" on the next send.
    target: session.teamId && !session.agentInstanceId
      ? { type: "member", teamId: session.teamId, memberId: session.memberId }
      : { type: "agent", instanceId: session.agentInstanceId ?? session.memberId, teamId: session.teamId },
    title: session.title,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    serviceTier: session.serviceTier,
    permissionMode: session.permissionMode?.trim() || undefined,
    mode: session.mode,
    status: session.status,
    parentSessionId: session.parentSessionId,
    taskId: session.taskId,
    projectRunId: session.projectRunId,
    runId: session.projectRunId,
    unreadCount: session.unreadCount,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}
