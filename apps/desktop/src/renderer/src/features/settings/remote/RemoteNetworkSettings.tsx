import type { RemoteSettings } from "@agenthub/schemas";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Switch } from "../../../components/ui/Switch";
import { relaySettingsError } from "./remote-network-settings";
import { RelayNodeSelect, type useRelayCatalog } from "./RelayNodeSelect";
import { RemoteCopyButton } from "./RemoteCopyButton";

export function RemoteNetworkSettings({
  settings,
  endpointId,
  dirty,
  busy,
  zh,
  measurements,
  update,
  save,
}: {
  settings: RemoteSettings;
  endpointId?: string;
  dirty: boolean;
  busy: boolean;
  zh: boolean;
  measurements: ReturnType<typeof useRelayCatalog>;
  update(values: Partial<RemoteSettings>): void;
  save(next: RemoteSettings): Promise<void>;
}) {
  const relayError = relaySettingsError(settings, zh);
  return (
    <section className="remote-network remote-panel" aria-labelledby="remote-network-title">
      <header className="remote-panel-heading">
        <h3 id="remote-network-title">{zh ? "连接与中继设置" : "Connection and relay settings"}</h3>
      </header>
      <div className="remote-network-fields">
        <label>
          {zh ? "电脑名称" : "Computer name"}
          <input
            value={settings.deviceName}
            maxLength={120}
            disabled={busy}
            onChange={(e) => update({ deviceName: e.target.value })}
          />
        </label>
        <label>
          {zh ? "网络方式" : "Network mode"}
          <span className="remote-mode-select"><select
            value={settings.relayMode === "local" ? "direct" : settings.relayMode}
            disabled={busy}
            onChange={(e) => {
              const relayMode = e.target.value as RemoteSettings["relayMode"];
              update({ relayMode });
              void save({ ...settings, relayMode });
            }}
          >
            <option value="automatic">
              {zh ? "自动 · P2P 与公共中继" : "Automatic · P2P & public relay"}
            </option>
            <option value="direct">{zh ? "仅直连 · 跨网络 NAT 打洞" : "Direct only · cross-network NAT traversal"}</option>
            <option value="custom">{zh ? "中继 · 公共或自定义节点" : "Relay · public or custom nodes"}</option>
            <option value="lan">{zh ? "局域网离线 · 关闭互联网辅助" : "Offline LAN · no Internet assistance"}</option>
          </select><ChevronDown size={14} aria-hidden /></span>
        </label>
      </div>
      <div className="remote-network-routes">
        {settings.enabled && settings.relayMode !== "custom" && settings.relayMode !== "lan" &&
          <div className="relay-picker-label">
            <div><strong>{zh ? "节点测速" : "Relay latency"}</strong>
              <span>{zh ? "电脑 → 节点 · HTTPS" : "PC → relay · HTTPS"}</span></div>
            <Button size="sm" variant="outline" className="relay-probe-button" disabled={busy || measurements.loading}
              onClick={() => void measurements.refresh()} aria-busy={measurements.loading}>
              <RefreshCw size={13} aria-hidden />{zh ? "重新测速" : "Retest latency"}
            </Button>
          </div>}
        {settings.relayMode === "custom" && <RelayNodeSelect urls={settings.relayUrls} zh={zh} disabled={busy} measurements={measurements} onChange={relayUrls => update({ relayUrls })} />}
        {(settings.relayMode === "direct" || settings.relayMode === "local") && (
          <label className="remote-full-width">
            {zh ? "打洞辅助节点（可选，留空使用公共节点）" : "Rendezvous nodes (optional)"}
            <textarea
              rows={2}
              disabled={busy}
              value={settings.relayUrls.join("\n")}
              onChange={(e) =>
                update({
                  relayUrls: e.target.value.split(/\r?\n/),
                })
              }
              placeholder="https://relay.example.com"
            />
          </label>
        )}
        {relayError && <p className="remote-network-error" role="alert">{relayError}</p>}
        {settings.relayMode === "automatic" && (
          <p className="remote-network-note">
            {zh
              ? "自动尝试 P2P 直连，无法直连时使用公共中继。实际路径与往返延迟显示在设备卡片中。"
              : "Attempts a direct P2P connection, with public relay fallback. Each device shows its actual data path and round-trip latency."}
          </p>
        )}
        {(settings.relayMode === "direct" || settings.relayMode === "local") && <p className="remote-network-note">{zh
          ? "支持不同网络间尝试 NAT 打洞。辅助节点用于发现和建立连接，聊天与文件只通过 P2P 直连；打洞失败会提示，业务数据不会自动改走中继。需要新版手机端。"
          : "Attempts NAT traversal across networks. Assistance nodes establish connectivity; chat and files use direct P2P only. Failure is reported without relaying stream data. Requires the updated mobile app."}</p>}
        {settings.relayMode === "lan" && (
          <p className="remote-network-note">{zh
            ? "关闭公网发现和中继，适合已知地址可互通的局域网。切换网络或重启后无法连接时，请重新扫码更新地址。"
            : "Disables public discovery and relays. Use on a reachable LAN; scan again if addresses change."}</p>
        )}
        {settings.relayMode === "custom" && (
          <p className="remote-network-note">
            {zh
              ? "通过所选中继传输，跳过直连尝试。设备卡片显示手机与电脑之间的实际连接延迟。"
              : "Uses the selected relay without direct attempts. Device cards show the actual phone-to-PC connection latency."}
          </p>
        )}
      </div>
      <div className="remote-network-system">
        <div className="remote-awake">
          <span>
            {zh
              ? "远程连接开启时保持电脑唤醒"
              : "Keep computer awake while remote access is on"}
          </span>
          <Switch
            aria-label={zh ? "保持电脑唤醒" : "Keep computer awake"}
            disabled={busy}
            checked={settings.keepAwake}
            onCheckedChange={(keepAwake) => update({ keepAwake })}
          />
        </div>
        {endpointId && (
          <div className="remote-endpoint">
            <span>{zh ? "设备 ID" : "Device ID"}</span>
            <code title={endpointId}>{endpointId}</code>
            <RemoteCopyButton value={endpointId} label={zh ? "复制设备 ID" : "Copy device ID"} zh={zh} />
          </div>
        )}
      </div>
      <footer className="remote-save">
        <Button type="button" variant="primary" size="sm" disabled={busy || !dirty || !settings.deviceName.trim() || !!relayError} onClick={() => void save(settings)}>
          {zh ? "保存设置" : "Save settings"}
        </Button>
      </footer>
    </section>
  );
}
