import { useEffect, useRef, useState } from "react";
import type {
  RemoteDevice,
  RemoteInvitation,
  RemotePendingDevice,
  RemoteSettings,
} from "@agenthub/schemas";
import {
  ArrowRight,
  Check,
  Copy,
  Globe2,
  Loader2,
  QrCode,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Unplug,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Switch } from "../../../components/ui/Switch";
import { Dialog } from "../../../components/ui/Dialog";
import { useSettingsStore } from "../../../stores/settings";
import { useRemoteAccess } from "./useRemoteAccess";
import { RemoteDeviceDialog } from "./RemoteDeviceDialog";
import { RemoteNetworkSettings } from "./RemoteNetworkSettings";
import { RemoteCopyButton } from "./RemoteCopyButton";
import { RemoteTopology } from "./RemoteTopology";
import { RelayLatency, useRelayCatalog } from "./RelayNodeSelect";
import { relayAddressKey } from "./relay-catalog";
import { normalizeRelayUrls, relaySettingsError, relayConnectionFeedback } from "./remote-network-settings";
import "./remote-access.css";

export function RemoteAccessPanel() {
  const zh = useSettingsStore((s) => s.locale === "zh-CN");
  const { status, error, busy, execute } = useRemoteAccess();
  const [draft, setDraft] = useState<RemoteSettings>();
  const [invitation, setInvitation] = useState<RemoteInvitation>();
  const [selected, setSelected] = useState<
    RemoteDevice | RemotePendingDevice
  >();
  const [revoking, setRevoking] = useState<RemoteDevice>();
  const [copied, setCopied] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [localError, setLocalError] = useState("");
  const relayProgress = useRef<{ since?: number; seenReady: boolean }>({ seenReady: false });
  const needsRelay = Boolean(status?.settings.enabled && status.settings.relayMode !== "lan");
  useEffect(() => {
    if (!needsRelay) relayProgress.current = { seenReady: false };
    else if (status?.internetReady) relayProgress.current = { seenReady: true };
    else relayProgress.current.since ??= Date.now();
  }, [needsRelay, status?.internetReady]);
  useEffect(() => {
    if (invitation || (needsRelay && !status?.internetReady)) {
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
    }
  }, [invitation, needsRelay, status?.internetReady]);
  const relayFeedback = relayConnectionFeedback({ ready: Boolean(status?.internetReady), seenReady: relayProgress.current.seenReady,
    elapsedMs: Math.max(0, clock - (relayProgress.current.since ?? clock)), errors: status?.relays?.flatMap(r => r.error ? [r.error] : []) ?? [] }, zh);
  const settings = draft ?? status?.settings;
  const measurements = useRelayCatalog(settings?.relayMode === "custom" || needsRelay ? settings?.relayUrls : undefined);
  const remaining = invitation
    ? Math.max(0, Math.ceil((invitation.expiresAt - clock) / 1000))
    : 0;
  const pending = status?.pending ?? [];
  const connected = status?.devices.filter((device) => device.connected && device.connectionState !== "punching") ?? [];
  const active = connected.length;
  const update = (values: Partial<RemoteSettings>) => {
    if (settings) setDraft({ ...settings, ...values });
  };
  const createInvitation = async () => {
    const result = await execute("remote.invite", {});
    if (result) {
      setClock(Date.now());
      setInvitation(result);
      setCopied(false);
    }
  };
  const closeInvitation = () => {
    setInvitation(undefined);
    void execute("remote.cancelInvite", {});
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invitation!.uri);
      setCopied(true);
    } catch {
      setLocalError(zh ? "复制失败，请重试" : "Copy failed");
    }
  };
  if (!status || !settings)
    return (
      <div className="remote-loading" role="status">
        <Loader2 size={20} className="animate-spin" />
        {error || (zh ? "正在读取连接状态" : "Loading connection status")}
      </div>
    );
  const mode = status.settings.relayMode;
  const directOnly = mode === "direct" || mode === "local";
  const routes = connected.map(device => device.paths?.find(path => path.selected)?.type ?? device.connectionType);
  const direct = routes.includes("direct") || routes.includes("mixed");
  const relayed = routes.includes("relay") || routes.includes("mixed");
  const topology = !status.settings.enabled || status.state === "error" ? "off"
    : relayed ? "relay" : direct || (mode === "lan" && active > 0) ? "direct"
    : status.internetReady && !directOnly ? "ready" : "waiting";
  const stateLabel = !status.settings.enabled ? (zh ? "未开启" : "Off")
    : status.state === "error" ? (zh ? "连接异常" : "Connection error")
    : active > 0 ? (zh ? `${active} 台设备已连接` : `${active} devices connected`)
    : status.state === "starting" ? (zh ? "正在启动" : "Starting")
    : directOnly && status.internetReady ? (zh ? "等待设备直连" : "Waiting for direct connection")
    : mode === "lan" ? (zh ? "局域网就绪" : "LAN ready")
    : status.internetReady ? (zh ? "可远程连接" : "Ready for remote connections") : relayFeedback.label;
  const channelLabel = direct && relayed ? (zh ? "P2P 与中继" : "P2P & relay")
    : direct ? (zh ? "P2P 直连" : "Direct P2P")
    : relayed ? (zh ? "中继转发" : "Relay transport")
    : mode === "lan" ? (zh ? "仅局域网" : "LAN only")
    : directOnly ? (zh ? "仅直连 · 辅助打洞" : "Direct only · NAT traversal")
    : mode === "custom" ? (zh ? "中继传输" : "Relay transport") : (zh ? "P2P + 中继回退" : "P2P + relay fallback");
  const relay = status.relays?.find(node => node.connected) ?? status.relays?.[0];
  const relayMeasurement = relay && measurements.nodes.find(node => relayAddressKey(node.url) === relayAddressKey(relay.url));
  const relayLatency = relayMeasurement?.latencyMs;
  const relayHosts = status.relays?.map(node => `${new URL(node.url).host} · ${node.connected ? (zh ? "就绪" : "Ready") : (zh ? "重连中" : "Reconnecting")}`).join("\n");
  const topologyLabel = topology === "off" ? stateLabel
    : topology === "direct" ? (mode === "lan" ? "LAN" : "P2P")
    : topology === "relay" ? (direct ? "P2P / Relay" : "Relay")
    : topology === "ready" ? (zh ? "中继就绪" : "Relay ready") : (zh ? "等待设备" : "Waiting for device");
  const save = async (next: RemoteSettings, commitDraft = true) => {
    const value = { ...next, relayUrls: normalizeRelayUrls(next.relayUrls) };
    const validation = relaySettingsError(value, zh);
    setLocalError(validation);
    if (!validation && await execute("remote.configure", value)) {
      setDraft(current => commitDraft ? undefined : current && { ...current, enabled: value.enabled });
    }
  };
  return (
    <section className="remote-access">
      {(error || localError || status.error || (needsRelay && active === 0 && relayFeedback.detail)) && (
        <div role="alert" className="remote-error">
          {error || localError || status.error || relayFeedback.detail}
          {(status.state === "error" || relayFeedback.retryable) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void save(status.settings, false)}
            >
              <RefreshCw size={14} />
              {zh ? "重试连接" : "Retry connection"}
            </Button>
          )}
        </div>
      )}
      <div className="remote-host" data-topology={topology}>
        <div className="remote-host-body">
          <div className="remote-host-copy">
            <span className="remote-status" data-state={status.state === "error" ? "error" : active > 0 ? "online" : topology}>
              <i aria-hidden />{stateLabel}
            </span>
            <span className="remote-eyebrow">{zh ? "本机电脑" : "This computer"}</span>
            <div className="remote-host-name">
              <h2 title={status.settings.deviceName}>{status.settings.deviceName}</h2>
              <RemoteCopyButton value={status.settings.deviceName} label={zh ? "复制电脑名称" : "Copy computer name"} zh={zh} />
            </div>
            <p>{zh ? "从手机继续你的工作" : "Continue your work from your phone"}</p>
            <Button type="button" variant="primary" className="remote-pair-action" size="sm"
              disabled={busy || status.state !== "listening"} onClick={() => void createInvitation()}>
              <QrCode size={15} aria-hidden />{zh ? "配对新设备" : "Pair a device"}<ArrowRight size={14} aria-hidden />
            </Button>
          </div>

          <div className="remote-host-visual">
            <div className="remote-master-switch">
              <span>{zh ? "远程连接" : "Remote access"}</span>
              <Switch aria-label={zh ? "开启远程连接" : "Enable remote access"} disabled={busy || !status.supported}
                checked={status.settings.enabled} onCheckedChange={enabled => void save({ ...status.settings, enabled }, false)} />
            </div>
            <RemoteTopology state={topology} zh={zh} label={topology === "relay" && relayLatency !== undefined ? `${topologyLabel} · ${relayLatency} ms` : topologyLabel} />
          </div>
        </div>

        <div className="remote-host-footer">
          <span><ShieldCheck size={14} aria-hidden />{zh ? "端到端加密" : "End-to-end encrypted"}</span>
          <span className="remote-online-count" data-online={active > 0}><i aria-hidden />{active} {zh ? "台设备在线" : "devices online"}</span>
          <span><Zap size={13} aria-hidden />{channelLabel}</span>
          {relay && <span className="remote-relay-telemetry" title={relayHosts}>
            <Globe2 size={14} aria-hidden />
            <span>{directOnly ? (zh ? "辅助节点" : "Rendezvous") : (zh ? "当前节点" : "Relay node")} <code>{new URL(relay.url).host}</code></span>
            {relayMeasurement && <RelayLatency {...relayMeasurement} loading={measurements.loading} zh={zh} />}
          </span>}
        </div>
      </div>

      {needsRelay && !status.internetReady && relayFeedback.retryable && !relayFeedback.detail && !status.error && !error && !localError && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(status.settings, false)}><RefreshCw size={14} />{zh ? "重试连接" : "Retry connection"}</Button>
      )}

      <div className="remote-workbench">
        <section className="remote-panel remote-paired-panel" aria-labelledby="remote-paired-title">
          <header className="remote-panel-heading">
            <h3 id="remote-paired-title">{zh ? "已配对设备" : "Paired devices"} <span>{status.devices.length}</span></h3>
          </header>

          {pending.length > 0 && <section className="remote-pending" aria-label={zh ? "待确认设备" : "Pending devices"}>
            {pending.map(device => <div className="remote-device" key={device.id}>
              <div className="remote-device-avatar"><Smartphone size={18} aria-hidden /><i data-online="pending" /></div>
              <div className="remote-device-content">
                <strong>{device.name}</strong>
                <span className="remote-device-detail">{zh ? "请求配对" : "Pairing request"} · {device.code}</span>
              </div>
              <div className="remote-device-actions">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setInvitation(undefined); setSelected(device); }}>
                  {zh ? "核对并连接" : "Review & connect"}
                </Button>
                <button type="button" className="remote-icon-button remote-device-remove" aria-label={zh ? "拒绝配对" : "Reject"}
                  disabled={busy} onClick={() => void execute("remote.reject", { deviceId: device.id })}><X size={15} aria-hidden /></button>
              </div>
            </div>)}
          </section>}
          <div className="remote-devices">
            {!status.devices.length && <div className="remote-empty">
              <span className="remote-device-avatar"><Smartphone size={20} aria-hidden /></span>
              <strong>{zh ? "连接你的第一台设备" : "Connect your first device"}</strong>
              <span>{zh ? "开启连接后，扫码并在本机确认配对" : "Enable access, scan the code and approve on this computer"}</span>
            </div>}
            {status.devices.map((device, index) => {
              const punching = device.connectionState === "punching";
              const presence = punching ? "pending" : device.connected ? "online" : "offline";
              const route = device.paths?.find(path => path.selected);
              const type = route?.type ?? device.connectionType;
              const latency = route?.latencyMs ?? device.latencyMs;
              const path = punching ? (zh ? "信令已连接，等待 P2P 直连" : "Signalling connected; waiting for P2P")
                : type === "direct" ? (zh ? "P2P 直连" : "Direct P2P")
                : type === "relay" ? (zh ? "加密中继" : "Encrypted relay")
                : type === "mixed" ? (zh ? "P2P 与中继" : "P2P & relay") : (zh ? "正在优化连接" : "Optimizing connection");
              return <article className="remote-device" key={device.id} style={{ animationDelay: `${index * 32}ms` }}>
                <div className="remote-device-avatar"><Smartphone size={18} aria-hidden /><i data-online={presence} /></div>
                <div className="remote-device-content">
                  <div className="remote-device-heading">
                    <strong title={device.name}>{device.name}</strong>
                    <span className="remote-presence" data-online={presence}>
                      {punching ? (zh ? "打洞中" : "Connecting") : device.connected ? (zh ? "在线" : "Online") : (zh ? "离线" : "Offline")}
                    </span>
                  </div>
                  <div className="remote-device-meta">
                    <span className="remote-device-chip">{zh ? "完整控制" : "Full control"}</span>
                    <span className="remote-device-chip">{zh ? "全部项目" : "All projects"}</span>
                    {!device.connected && <time dateTime={device.lastSeenAt}>
                      {zh ? "上次连接" : "Last seen"} {new Date(device.lastSeenAt).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </time>}
                  </div>
                  {device.connected && <span className="remote-device-detail"><Wifi size={12} aria-hidden />{path}{latency !== undefined && ` · ${latency} ms`}</span>}
                </div>
                <div className="remote-device-actions">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setSelected(device)}>{zh ? "管理" : "Manage"}</Button>
                  <button type="button" className="remote-icon-button remote-device-remove" disabled={busy}
                    aria-label={zh ? `解除 ${device.name} 的配对` : `Unpair ${device.name}`} onClick={() => setRevoking(device)}><Unplug size={15} aria-hidden /></button>
                </div>
              </article>;
            })}
          </div>
        </section>
        <RemoteNetworkSettings
          settings={settings}
          endpointId={status.endpointId}
          dirty={JSON.stringify(settings) !== JSON.stringify(status.settings)}
          busy={busy}
          zh={zh}
          measurements={measurements}
          update={update}
          save={save}
        />
      </div>

      <Dialog
        open={!!invitation}
        onOpenChange={(open) => {
          if (!open) closeInvitation();
        }}
        title={zh ? "配对新设备" : "Pair a new device"}
        widthClass="remote-dialog max-w-lg"
      >
        <div className="remote-pair-dialog">
          {invitation && (
            <div className="remote-qr" data-expired={!remaining}>
              <img
                src={`data:image/svg+xml,${encodeURIComponent(invitation.qrSvg)}`}
                alt={zh ? "设备配对二维码" : "Device pairing QR code"}
              />
              {!remaining && (
                <div>
                  <span>{zh ? "二维码已过期" : "Code expired"}</span>
                  <Button size="sm" onClick={() => void createInvitation()}>
                    <RefreshCw size={14} />
                    {zh ? "重新生成" : "Generate again"}
                  </Button>
                </div>
              )}
            </div>
          )}
          {(error || localError) && (
            <p className="remote-error" role="alert">
              {error || localError}
            </p>
          )}
          <strong>{status.settings.deviceName}</strong>
          <span>
            {remaining > 0
              ? `${zh ? "有效期" : "Expires in"} ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
              : zh
                ? "请刷新配对码"
                : "Refresh to pair"}
          </span>
          <Button
            variant="outline"
            disabled={!remaining}
            onClick={() => void copy()}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied
              ? zh
                ? "已复制"
                : "Copied"
              : zh
                ? "复制配对链接"
                : "Copy pairing link"}
          </Button>
          {pending.length > 0 && (
            <Button
              onClick={() => {
                setInvitation(undefined);
                setSelected(pending[0]);
              }}
            >
              {zh ? "查看配对请求" : "Review pairing request"}
              <ArrowRight size={14} />
            </Button>
          )}
        </div>
      </Dialog>
      <RemoteDeviceDialog
        open={!!selected}
        name={selected?.name ?? ""}
        code={selected && "code" in selected ? selected.code : undefined}
        busy={busy}
        error={error}
        zh={zh}
        onClose={() => setSelected(undefined)}
        onSave={async () => {
          if (!selected) return;
          const result =
            "code" in selected
              ? await execute("remote.approve", {
                  deviceId: selected.id,
                })
              : await execute("remote.updateDevice", {
                  deviceId: selected.id,
                  name: selected.name,
                });
          if (result) setSelected(undefined);
        }}
      />
      <Dialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title={zh ? "解除设备配对" : "Unpair device"}
        widthClass="remote-dialog max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(undefined)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button variant="danger"
              disabled={busy}
              onClick={async () => {
                if (
                  revoking &&
                  (await execute("remote.revoke", { deviceId: revoking.id }))
                )
                  setRevoking(undefined);
              }}
            >
              {zh ? "解除配对" : "Unpair"}
            </Button>
          </>
        }
      >
        <p className="p-6 text-sm">
          {zh
            ? `${revoking?.name ?? ""} 的连接将立即断开，再次访问需要重新配对。`
            : `${revoking?.name ?? ""} will disconnect immediately and require pairing again.`}
        </p>
      </Dialog>
    </section>
  );
}
