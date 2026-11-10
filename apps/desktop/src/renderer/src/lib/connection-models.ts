import type { ProviderModelCatalog, RuntimeConnection } from "@agenthub/domain";

export interface ConnectionModelSelection {
  model?: string;
  agentMode?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  permissionMode?: string;
  connectionId?: string;
  connectionRevision?: number;
}

export function hasConfiguredConnectionModels(connection: RuntimeConnection): boolean {
  // A newly signed-in account discovers its catalog automatically. An API
  // connection uses only the models explicitly saved in its configuration.
  return connection.kind === "api" || Boolean(connection.models?.length);
}

/** Discovery supplies metadata, while saved models define the selectable list.
 * In particular, a relay's /models response must not enable unrelated models.
 */
export function connectionModelCatalog(connection: RuntimeConnection, discovered?: ProviderModelCatalog): ProviderModelCatalog {
  const base: ProviderModelCatalog = {
    providerId: `connection:${connection.id}`,
    models: [],
    source: connection.kind === "api" ? "provider_api" : "provider_cli",
    fetchedAt: connection.updatedAt,
  };
  if (!connection.enabled) return base;
  if (!hasConfiguredConnectionModels(connection)) return discovered ?? base;
  const models = (connection.models ?? []).filter(model => model.enabled !== false).map((configured, index) => {
    const known = discovered?.models.find(model => model.id === configured.id);
    const efforts = [...(configured.reasoningEfforts ?? [])];
    const preferred = configured.defaultReasoningEffort;
    return {
      ...known,
      ...configured,
      displayName: configured.displayName?.trim() || known?.displayName || configured.id,
      capabilities: known?.capabilities ?? [],
      serviceTiers: known?.serviceTiers ?? [],
      reasoningEfforts: efforts,
      defaultReasoningEffort: preferred && efforts.includes(preferred) ? preferred : efforts[0],
      isDefault: index === 0,
    };
  });
  return { ...base, models, defaultModel: models[0]?.id };
}

/** Unsent drafts follow the saved head; persisted sessions stay revision-pinned. */
export function resolveDraftConnectionConfiguration<T extends ConnectionModelSelection>(
  selection: T,
  connection: RuntimeConnection,
  discovered?: ProviderModelCatalog,
): T {
  const catalog = connectionModelCatalog(connection, discovered);
  const model = catalog.models.find(item => item.id === selection.model)
    ?? catalog.models.find(item => item.id === catalog.defaultModel)
    ?? catalog.models[0];
  // Account discovery may still be in flight. Do not erase a pending choice.
  const pending = !hasConfiguredConnectionModels(connection) && !discovered;
  return {
    ...selection,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    model: pending ? selection.model : model?.id,
    reasoningEffort: pending ? selection.reasoningEffort : model?.reasoningEfforts.includes(selection.reasoningEffort ?? "")
      ? selection.reasoningEffort : model?.defaultReasoningEffort ?? model?.reasoningEfforts[0],
    serviceTier: pending ? selection.serviceTier : model?.serviceTiers.some(item => item.id === selection.serviceTier)
      ? selection.serviceTier : model?.defaultServiceTier,
  };
}
