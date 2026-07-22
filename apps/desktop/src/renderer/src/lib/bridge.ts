import type { AgentHubBridge } from "../types/bridge";

/**
 * Returns the Electron preload bridge when running inside the desktop shell.
 * In a plain browser it is undefined; business operations remain unavailable
 * instead of silently switching to fabricated data.
 */
export function getBridge(): AgentHubBridge | undefined {
  return typeof window !== "undefined" ? window.agenthub : undefined;
}

export const isElectron = typeof window !== "undefined" && !!window.agenthub?.isElectron;

export async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  const bridge = getBridge();
  if (!bridge) throw new Error("Core Daemon is only available in the desktop shell");
  return (await bridge.core.request({ method, input })) as T;
}
