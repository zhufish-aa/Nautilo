import { Check, ShieldCheck } from "lucide-react";
import { Dialog } from "../../../components/ui/Dialog";
import { Button } from "../../../components/ui/Button";

export function RemoteDeviceDialog({ open, name, code, busy, error, zh, onClose, onSave }: {
  open: boolean; name: string; code?: string; busy: boolean; error?: string; zh: boolean;
  onClose(): void; onSave(): Promise<void>;
}) {
  return <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) onClose(); }}
    title={zh ? "确认设备连接" : "Confirm device"}
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{zh ? "取消" : "Cancel"}</Button>
      <Button disabled={busy} onClick={() => void onSave()}><Check size={15} />{zh ? "确认连接" : "Connect"}</Button></>}>
    <div className="remote-device-form">
      {error && <p className="remote-error" role="alert">{error}</p>}
      <div className="remote-device-name"><ShieldCheck size={22} /><strong>{name}</strong></div>
      {code && <div className="remote-confirm-code"><span>{zh ? "核对手机上的配对码" : "Match the code on your phone"}</span><strong>{code.slice(0, 3)} {code.slice(3)}</strong></div>}
      <p>{zh ? "配对后可在手机上操作全部项目和会话。" : "Your phone can control all projects and conversations after pairing."}</p>
    </div>
  </Dialog>;
}
