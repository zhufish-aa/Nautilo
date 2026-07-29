import type { RunMode } from "@agenthub/domain";
import type { ProviderDescriptor } from "@agenthub/provider-sdk";
import { useProvidersStore } from "../stores/providers";
import type { EnvironmentPolicy, PermissionModeOption, ProviderMeta } from "./types";

/**
 * Presentation metadata comes from the Core Daemon's provider catalog
 * (built-in adapters + loaded plugins). This module only adapts it to the
 * UI's id scheme and lookup helpers; nothing is hardcoded per provider here.
 */

/** Daemon provider id → UI catalog id (only custom-cli differs). */
function toUiId(daemonId: string): string {
  return daemonId === "custom" ? "custom-cli" : daemonId;
}

function toMeta(descriptor: ProviderDescriptor): ProviderMeta {
  return {
    id: toUiId(descriptor.providerId),
    name: descriptor.name,
    vendor: descriptor.vendor,
    capabilities: descriptor.capabilities as RunMode[]
  };
}

function findDescriptor(providerId: string): ProviderDescriptor | undefined {
  return useProvidersStore.getState().catalog.find(
    (item) => toUiId(item.providerId) === providerId || item.providerId === providerId
  );
}

/** Non-reactive snapshot for stores and one-shot mappings. */
export function providerMetas(): ProviderMeta[] {
  return useProvidersStore.getState().catalog.map(toMeta);
}

/** Reactive catalog for components (updates when plugins load/unload). */
export function useProviderMetas(): ProviderMeta[] {
  return useProvidersStore((state) => state.catalog).map(toMeta);
}

export const ENV_POLICIES: EnvironmentPolicy[] = [
  { id: "env-standard", nameKey: "envPolicies.env-standard.name", descriptionKey: "envPolicies.env-standard.description" },
  { id: "env-strict", nameKey: "envPolicies.env-strict.name", descriptionKey: "envPolicies.env-strict.description" },
  { id: "env-custom", nameKey: "envPolicies.env-custom.name", descriptionKey: "envPolicies.env-custom.description" }
];

export function permissionModesFor(providerId: string): PermissionModeOption[] {
  return findDescriptor(providerId)?.permissionModes ?? [];
}

/** Whether the provider passes instance.profile to its CLI (codex --profile). */
export function supportsConfigProfile(providerId: string): boolean {
  return findDescriptor(providerId)?.configProfile === true;
}

export function providerMeta(providerId: string): ProviderMeta {
  const descriptor = findDescriptor(providerId);
  if (descriptor) return toMeta(descriptor);
  return {
    id: providerId,
    name: providerId,
    vendor: "Custom",
    capabilities: ["headless_text"]
  };
}
