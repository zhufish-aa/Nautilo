import { useEffect, useState } from "react";
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
  Link2,
  Loader2,
  Monitor,
  QrCode,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Unplug,
  Wifi,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Switch } from "../../../components/ui/Switch";
import { Dialog } from "../../../components/ui/Dialog";
import { useSettingsStore } from "../../../stores/settings";
import { useRemoteAccess } from "./useRemoteAccess";
import { RemoteDeviceDialog } from "./RemoteDeviceDialog";
import { RemoteNetworkSettings } from "./RemoteNetworkSettings";
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
  useEffect(() => {
    if (invitation) {
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
    }
  }, [invitation]);
  const settings = draft ?? status?.settings;
  const remaining = invitation
    ? Math.max(0, Math.ceil((invitation.expiresAt - clock) / 1000))
    : 0;
  const pending = status?.pending ?? [];
  const active = status?.devices.filter((d) => d.connected).length ?? 0;
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
  const stateLabel = !status.settings.enabled
    ? zh
      ? "未开启"
      : "Off"
    : status.state === "error"
      ? zh
        ? "连接异常"
        : "Connection error"
      : status.internetReady
        ? zh
          ? "可远程连接"
          : "Ready for remote connections"
        : status.state === "starting"
          ? zh
            ? "正在启动"
            : "Starting"
          : zh
            ? "局域网就绪"
            : "LAN ready";
  const save = async (next: RemoteSettings) => {
    if (await execute("remote.configure", next)) setDraft(undefined);
  };
  return (
    <section className="remote-access">
      {(error || localError || status.error) && (
        <div role="alert" className="remote-error">
          {error || localError || status.error}
          {status.state === "error" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void save(status.settings)}
            >
              <RefreshCw size={14} />
              {zh ? "重试连接" : "Retry connection"}
            </Button>
          )}
        </div>
      )}
      <div className="remote-host">
        <div className="remote-host-top">
          <span
            className="remote-status"
            data-ready={status.settings.enabled && status.state === "listening"}
          >
            <i />
            {stateLabel}
          </span>
          <Switch
            aria-label={zh ? "开启远程连接" : "Enable remote access"}
            disabled={busy || !status.supported}
            checked={status.settings.enabled}
            onCheckedChange={(enabled) =>
              void save({ ...status.settings, enabled })
            }
          />
        </div>
        <div className="remote-host-body">
          <div className="remote-host-copy">
            <span className="remote-eyebrow">
              {zh ? "这台电脑" : "THIS COMPUTER"}
            </span>
            <h2>{status.settings.deviceName}</h2>
            <p>
              {zh ? "从手机继续你的工作" : "Continue your work from your phone"}
            </p>
            <Button
              disabled={busy || status.state !== "listening"}
              onClick={() => void createInvitation()}
            >
              <QrCode size={16} />
              {zh ? "配对新设备" : "Pair a device"}
              <ArrowRight size={15} />
            </Button>
          </div>
          <div className="remote-connection-art" aria-hidden>
            <div className="remote-computer">
              <Monitor size={64} strokeWidth={1.2} />
              <span>Nautilo</span>
            </div>
            <div className="remote-link-track" data-active={active > 0}>
              <span />
              <Link2 size={18} />
              <span />
            </div>
            <div className="remote-phone">
              <Smartphone size={49} strokeWidth={1.3} />
              <ShieldCheck size={17} />
            </div>
          </div>
        </div>
        <div className="remote-host-footer">
          <span>
            <ShieldCheck size={14} />
            {zh ? "端到端加密" : "End-to-end encrypted"}
          </span>
          <span>
            <Radio size={14} />
            {active} {zh ? "台设备在线" : "devices online"}
          </span>
          <span>
            <Globe2 size={14} />
            {status.settings.relayMode === "local"
              ? zh
                ? "仅直连"
                : "Direct only"
              : status.internetReady
                ? zh
                  ? "中继已连接"
                  : "Relay connected"
                : status.settings.enabled
                  ? zh
                    ? "正在连接中继"
                    : "Connecting to relay"
                  : zh
                    ? "P2P + 中继回退"
                    : "P2P + relay fallback"}
          </span>
        </div>
      </div>

      {pending.length > 0 && (
        <section
          className="remote-pending"
          aria-label={zh ? "待确认设备" : "Pending devices"}
        >
          {pending.map((device) => (
            <div key={device.id}>
              <Smartphone size={22} />
              <div>
                <strong>{device.name}</strong>
                <span>
                  {zh ? "请求配对" : "Pairing request"} · {device.code}
                </span>
              </div>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setInvitation(undefined);
                  setSelected(device);
                }}
              >
                {zh ? "核对并连接" : "Review & connect"}
              </Button>
              <button
                className="remote-icon-button"
                aria-label={zh ? "拒绝配对" : "Reject"}
                disabled={busy}
                onClick={() =>
                  void execute("remote.reject", { deviceId: device.id })
                }
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </section>
      )}

      <div className="remote-section-title">
        <h3>
          {zh ? "已配对设备" : "Paired devices"}
          <span>{status.devices.length}</span>
        </h3>
      </div>
      <div className="remote-devices">
        {status.devices.length === 0 && (
          <div className="remote-empty">
            <div>
              <Smartphone size={24} />
              <Link2 size={17} />
            </div>
            <strong>
              {zh ? "连接你的第一台设备" : "Connect your first device"}
            </strong>
            <span>
              {zh
                ? "开启连接后，扫码并在本机确认配对"
                : "Enable access, scan the code and approve on this computer"}
            </span>
          </div>
        )}
        {status.devices.map((device) => (
          <article className="remote-device" key={device.id}>
            <div className="remote-device-avatar">
              <Smartphone size={23} />
            </div>
            <div className="remote-device-content">
              <strong>{device.name}</strong>
              <div>
                <span
                  className="remote-presence"
                  data-online={device.connected}
                >
                  <i />
                  {device.connected
                    ? zh
                      ? "在线"
                      : "Online"
                    : zh
                      ? "离线"
                      : "Offline"}
                </span>
                <span>
                  {zh ? "完整控制" : "Full control"}
                </span>
                <span>
                  {zh ? "全部项目" : "All projects"}
                </span>
              </div>
              {device.connected ? (
                <span className="remote-device-detail">
                  <Wifi size={12} />
                  {device.connectionType === "direct"
                    ? zh
                      ? "P2P 直连"
                      : "Direct P2P"
                    : device.connectionType === "relay"
                      ? zh
                        ? "加密中继"
                        : "Encrypted relay"
                      : zh
                        ? "正在优化连接"
                        : "Optimizing connection"}{" "}
                  · {device.latencyMs ?? "—"} ms
                </span>
              ) : (
                <span className="remote-device-detail">
                  {zh ? "上次连接" : "Last connected"}{" "}
                  {new Date(device.lastSeenAt).toLocaleString(
                    zh ? "zh-CN" : "en-US",
                    {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(device)}
            >
              {zh ? "管理" : "Manage"}
            </Button>
            <button
              className="remote-icon-button"
              aria-label={
                zh ? `解除 ${device.name} 的配对` : `Unpair ${device.name}`
              }
              onClick={() => setRevoking(device)}
            >
              <Unplug size={16} />
            </button>
          </article>
        ))}
      </div>
      <RemoteNetworkSettings
        settings={settings}
        endpointId={status.endpointId}
        dirty={!!draft}
        busy={busy}
        zh={zh}
        update={update}
        save={save}
      />

      <Dialog
        open={!!invitation}
        onOpenChange={(open) => {
          if (!open) closeInvitation();
        }}
        title={zh ? "配对新设备" : "Pair a new device"}
        widthClass="max-w-sm"
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
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(undefined)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button
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
