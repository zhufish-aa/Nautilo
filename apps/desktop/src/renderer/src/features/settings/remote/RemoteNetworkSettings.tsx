import type { RemoteSettings } from "@agenthub/schemas";
import { ChevronDown, Globe2 } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Switch } from "../../../components/ui/Switch";

export function RemoteNetworkSettings({
  settings,
  endpointId,
  dirty,
  busy,
  zh,
  update,
  save,
}: {
  settings: RemoteSettings;
  endpointId?: string;
  dirty: boolean;
  busy: boolean;
  zh: boolean;
  update(values: Partial<RemoteSettings>): void;
  save(next: RemoteSettings): Promise<void>;
}) {
  return (
    <details className="remote-network">
      <summary>
        <span>
          <Globe2 size={17} />
          {zh ? "连接设置" : "Connection settings"}
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="remote-network-body">
        <label>
          {zh ? "电脑名称" : "Computer name"}
          <input
            value={settings.deviceName}
            maxLength={120}
            onChange={(e) => update({ deviceName: e.target.value })}
          />
        </label>
        <label>
          {zh ? "网络方式" : "Network mode"}
          <select
            value={settings.relayMode}
            onChange={(e) =>
              update({
                relayMode: e.target.value as RemoteSettings["relayMode"],
              })
            }
          >
            <option value="automatic">
              {zh ? "自动 · P2P 与公共中继" : "Automatic · P2P & public relay"}
            </option>
            <option value="custom">{zh ? "自托管中继" : "Custom relay"}</option>
            <option value="local">{zh ? "仅直连" : "Direct only"}</option>
          </select>
        </label>
        {settings.relayMode === "custom" && (
          <label className="remote-full-width">
            {zh
              ? "Iroh 中继地址（每行一个）"
              : "Iroh relay URLs (one per line)"}
            <textarea
              value={settings.relayUrls.join("\n")}
              onChange={(e) =>
                update({
                  relayUrls: e.target.value.split("\n").filter(Boolean),
                })
              }
              placeholder="https://relay.example.com"
            />
          </label>
        )}
        {settings.relayMode === "automatic" && (
          <p className="remote-network-note">
            {zh
              ? "使用 Iroh 公共中继与设备发现服务。可在此切换到自托管中继。"
              : "Uses Iroh public relay and device discovery services. A custom relay can be configured here."}
          </p>
        )}
        {settings.relayMode === "custom" && (
          <p className="remote-network-note">
            {zh
              ? "设备发现仍使用 Iroh 公共服务，以便网络地址变化后重新连接。"
              : "Public Iroh discovery locates this computer when its network address changes."}
          </p>
        )}
        <div className="remote-awake">
          <span>
            {zh
              ? "远程连接开启时保持电脑唤醒"
              : "Keep computer awake while remote access is on"}
          </span>
          <Switch
            checked={settings.keepAwake}
            onCheckedChange={(keepAwake) => update({ keepAwake })}
          />
        </div>
        {endpointId && (
          <div className="remote-endpoint">
            <span>{zh ? "设备 ID" : "Device ID"}</span>
            <code>{endpointId}</code>
          </div>
        )}
        <div className="remote-save">
          <Button
            disabled={busy || !dirty || !settings.deviceName.trim()}
            onClick={() => void save(settings)}
          >
            {zh ? "保存设置" : "Save settings"}
          </Button>
        </div>
      </div>
    </details>
  );
}
