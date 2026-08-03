/**
 * @agenthub/provider-sdk — public contract for Nautilo provider plugins.
 *
 * Version policy: PROVIDER_API_VERSION is bumped on incompatible changes to
 * AgentCliAdapter / AdapterEvent / ProviderPluginManifest. The daemon refuses
 * plugins whose manifest apiVersion differs from its own.
 */
export const PROVIDER_API_VERSION = 1;

export * from "./types.js";
export * from "./descriptor.js";
