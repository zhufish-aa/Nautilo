export interface NativeResourceTarget {
  id: string;
  providerId: string;
  accountId?: string;
  label: string;
  mcpPath?: string;
  skillDirectory?: string;
  mode: "native-file" | "invocation";
}
export interface ManagedResource {
  id: string;
  name: string;
  kind: "skill" | "mcp";
  enabled: boolean;
  providerIds: string[];
  source: string;
  sourcePath?: string;
  owner: "nautilo";
  updatedAt: string;
}
export interface ResourceInventory {
  resources: ManagedResource[];
  targets: NativeResourceTarget[];
}
export type ResourceConflictResolution = "keep" | "replace" | "rename";
export interface ResourcePlanInput {
  targetId: string;
  capabilityIds: string[];
  resolution?: ResourceConflictResolution;
}
export interface ResourceSyncPlan {
  id: string;
  createdAt: string;
  targetId: string;
  state: "preview" | "applied" | "undone" | "conflict";
  changes: Array<{
    resourceId: string;
    name: string;
    path: string;
    operation: "create" | "update" | "unchanged" | "keep" | "rename";
    conflict: boolean;
    before?: string;
    after?: string;
    resourceFile?: boolean;
  }>;
}
export interface ConfigurationPreset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
  resources: unknown[];
  harnesses: unknown[];
  connections: unknown[];
}
export interface ConfigurationPreview {
  id: string;
  presetId: string;
  state: "preview" | "applied";
  entries: Array<{
    kind: "resource" | "harness" | "connection";
    id: string;
    name: string;
    operation: "create" | "replace" | "keep" | "unavailable";
    credentialRequired?: boolean;
  }>;
}
export interface ToolServiceBinding {
  purpose: "image" | "vision" | "search";
  enabled: boolean;
  connectionId?: string;
  connectionRevision?: number;
  model?: string;
}
export interface IntegrationSettings {
  id: "integration-settings";
  schemaVersion: 1;
  updatedAt: string;
  toolServices: ToolServiceBinding[];
  gateway: { enabled: boolean; connectionIds: string[] };
}
