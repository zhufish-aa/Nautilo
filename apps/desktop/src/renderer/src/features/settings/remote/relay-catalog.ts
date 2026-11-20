import type { RemoteRelayNode } from "@agenthub/schemas";

export function relayAddressKey(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hostname = url.hostname.replace(/\.$/, "");
    return url.toString();
  } catch { return value.trim(); }
}

export function relayRegion(node: RemoteRelayNode, zh: boolean): string {
  const names: Record<RemoteRelayNode["region"], readonly [string, string]> = {
    "asia-pacific": ["亚太 · 新加坡", "Asia Pacific · Singapore"],
    "europe": ["欧洲", "Europe"],
    "north-america-west": ["北美西部", "North America West"],
    "north-america-east": ["北美东部", "North America East"],
    "custom": ["自建中继", "Self-hosted relay"],
  };
  return names[node.region][zh ? 0 : 1];
}

export function relaySelection(urls: string[], nodes: RemoteRelayNode[]): string {
  const values = urls.map(relayAddressKey).filter(Boolean);
  if (!values.length) return "public-auto";
  const match = values.length === 1 && nodes.find(node => node.source === "public" && relayAddressKey(node.url) === values[0]);
  return match ? match.id : "custom";
}
