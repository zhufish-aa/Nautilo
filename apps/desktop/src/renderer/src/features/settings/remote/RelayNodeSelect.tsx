import { useEffect, useRef, useState } from "react";
import * as Select from "@radix-ui/react-select";
import type { RemoteRelayCatalog, RemoteRelayNode } from "@agenthub/schemas";
import { Check, ChevronDown, Globe2, Loader2, RefreshCw, Server, Signal } from "lucide-react";
import { requestCore } from "../../../lib/bridge";
import { Button } from "../../../components/ui/Button";
import { relayAddressKey, relayRegion, relaySelection } from "./relay-catalog";
import "./relay-node-select.css";

// Persist results across page switches. No polling or dropdown-open rescan.
const catalogs = new Map<string, RemoteRelayCatalog>();
const pending = new Map<string, Promise<RemoteRelayCatalog>>();
let automaticProbeStarted = false;
function loadCatalog(key: string, urls: string[], refresh: boolean): Promise<RemoteRelayCatalog> {
  const requestKey = `${key}:${refresh}`;
  const current = pending.get(requestKey);
  if (current) return current;
  const promise = requestCore<RemoteRelayCatalog>("remote.relays", { urls, refresh }).then(result => {
    if (catalogs.size >= 8) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, result);
    return result;
  }).finally(() => pending.delete(requestKey));
  pending.set(requestKey, promise);
  return promise;
}

function Latency({ node, loading, zh }: { node: RemoteRelayNode; loading: boolean; zh: boolean }) {
  return <span className="relay-latency" data-quality={node.latencyMs === undefined ? "unknown" : node.latencyMs < 150 ? "good" : "normal"}
    title={node.error || (zh ? "电脑到中继的 HTTPS 往返时间" : "PC-to-relay HTTPS round-trip time")}>
    {loading ? <Loader2 size={12} className="animate-spin" /> : <Signal size={12} />}
    {node.latencyMs !== undefined ? `${node.latencyMs} ms` : node.error ? (zh ? "无法测速" : "Probe failed") : "—"}
  </span>;
}

export function RelayNodeSelect({ urls, zh, disabled, onChange }: {
  urls: string[]; zh: boolean; disabled: boolean; onChange(urls: string[]): void;
}) {
  const validUrls = urls.map(relayAddressKey).filter(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  }).slice(0, 4);
  const key = JSON.stringify(validUrls);
  const [catalog, setCatalog] = useState<RemoteRelayCatalog | undefined>(() => catalogs.get(key));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    let active = true;
    requestVersion.current += 1;
    const cached = catalogs.get(key);
    setCatalog(cached);
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const value = cached ?? await loadCatalog(key, JSON.parse(key), false);
        if (!active) return;
        setCatalog(value);
        const shouldMeasure = !automaticProbeStarted && value.nodes.some(node => !node.measuredAt);
        automaticProbeStarted = true;
        if (shouldMeasure) {
          const measured = await loadCatalog(key, JSON.parse(key), true);
          if (active) setCatalog(measured);
        }
      } catch (cause) { if (active) setError(String(cause)); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; requestVersion.current += 1; };
  }, [key]);
  const nodes = catalog?.nodes ?? [];
  const value = custom ? "custom" : relaySelection(urls, nodes);
  const selected = nodes.find(node => node.id === value);
  const refresh = async () => {
    const version = ++requestVersion.current;
    setLoading(true); setError("");
    try { const value = await loadCatalog(key, validUrls, true); if (version === requestVersion.current) setCatalog(value); }
    catch (cause) { if (version === requestVersion.current) setError(String(cause)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  };
  const change = (id: string) => {
    setCustom(id === "custom");
    if (id === "public-auto") onChange([]);
    else if (id !== "custom") {
      const node = nodes.find(node => node.id === id);
      if (node) onChange([node.url]);
    }
  };
  return <div className="remote-full-width relay-picker">
    <div className="relay-picker-label">
      <span id="relay-node-label">{zh ? "中继服务器" : "Relay server"}</span>
      <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()} aria-label={zh ? "刷新节点延迟" : "Refresh relay latency"}>
        <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
        {zh ? "测速" : "Test latency"}
      </Button>
    </div>
    <Select.Root value={value} onValueChange={change} disabled={disabled}>
      <Select.Trigger aria-labelledby="relay-node-label" className="relay-picker-trigger">
        {value === "custom" ? <Server size={17} /> : <Globe2 size={17} />}
        <span className="relay-trigger-name">{selected ? relayRegion(selected, zh) : value === "custom" ? (zh ? "自建中继" : "Self-hosted relay") : (zh ? "公共节点 · 自动选择" : "Public relays · automatic")}</span>
        {selected && <Latency node={selected} loading={loading} zh={zh} />}
        <Select.Icon><ChevronDown size={15} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="relay-picker-menu ui-menu-motion" position="popper" sideOffset={7}>
          <Select.Viewport>
            <Select.Item value="public-auto" className="relay-picker-item">
              <Globe2 size={16} /><Select.ItemText>{zh ? "公共节点 · 自动选择" : "Public relays · automatic"}</Select.ItemText>
              <Select.ItemIndicator className="relay-check"><Check size={15} /></Select.ItemIndicator>
            </Select.Item>
            <Select.Separator className="relay-picker-separator" />
            {nodes.filter(node => node.source === "public").map(node => <Select.Item key={node.id} value={node.id} className="relay-picker-item">
              <Globe2 size={16} />
              <div className="relay-node-copy"><Select.ItemText>{relayRegion(node, zh)}</Select.ItemText><span>{new URL(node.url).hostname}</span></div>
              <Latency node={node} loading={loading} zh={zh} />
              <Select.ItemIndicator className="relay-check"><Check size={15} /></Select.ItemIndicator>
            </Select.Item>)}
            <Select.Separator className="relay-picker-separator" />
            <Select.Item value="custom" className="relay-picker-item">
              <Server size={16} /><Select.ItemText>{zh ? "自建中继" : "Self-hosted relay"}</Select.ItemText>
              <Select.ItemIndicator className="relay-check"><Check size={15} /></Select.ItemIndicator>
            </Select.Item>
          </Select.Viewport>
          <div className="relay-picker-footnote">{zh ? "电脑 → 节点 · HTTPS 探测" : "PC → relay · HTTPS probe"}</div>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
    {value === "custom" && <label className="relay-custom-urls">
      {zh ? "服务器地址" : "Server URLs"}
      <textarea value={urls.join("\n")} placeholder="https://relay.example.com" onChange={e => onChange(e.target.value.split(/\r?\n/))} />
      {nodes.filter(node => node.source === "custom").map(node => <span className="relay-custom-probe" key={node.url}>
        <span>{new URL(node.url).host}</span><Latency node={node} loading={loading} zh={zh} />
      </span>)}
    </label>}
    <div className="relay-picker-meta" aria-live="polite">
      <span>{error ? (zh ? "测速未完成，可点击测速重试；不影响保存节点。" : "Latency test failed. Retry manually; the relay can still be saved.")
        : loading ? (zh ? "正在测量节点延迟…" : "Measuring relay latency…")
        : (zh ? "手机连接此电脑时使用所选中继。" : "The phone uses this relay when connecting to this computer.")}</span>
      <details><summary>{zh ? "自部署要求" : "Self-hosting"}</summary>
        <p>{zh ? "兼容 Iroh Relay 1.4.1、可访问的公网地址、TCP 443 与受信任的 HTTPS 证书。无域名时可使用公网 IP 证书。" : "Iroh Relay 1.4.1, a reachable public address, TCP 443 and a trusted HTTPS certificate. A public-IP certificate works without a domain."}</p>
      </details>
    </div>
  </div>;
}
