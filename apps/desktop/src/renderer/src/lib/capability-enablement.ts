import type { ProviderCapability } from "@agenthub/domain";

export function capabilityEnabledFor(capability: ProviderCapability, providerId: string): boolean {
  return capability.enabled && capability.providerIds.includes(providerId);
}

export function setCapabilityEnabledFor(capability: ProviderCapability, providerId: string, enabled: boolean): ProviderCapability {
  // A globally disabled legacy entry has no active targets. Enabling one target
  // must not reactivate its entire dormant provider list.
  const activeProviders = capability.enabled ? capability.providerIds : [];
  const providerIds = activeProviders.filter((id) => id !== providerId);
  if (enabled) providerIds.push(providerId);
  return { ...capability, enabled: providerIds.length > 0, providerIds, updatedAt: new Date().toISOString() };
}
