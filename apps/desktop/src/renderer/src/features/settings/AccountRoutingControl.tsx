import { useState } from "react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Switch } from "../../components/ui/Switch";
import { useConnectionsStore } from "../../stores/connections";
import { useI18n } from "../../lib/i18n";
import { accountHarnessName } from "./account-connect";

export function AccountRoutingControl({ connection, disabled }: { connection: RuntimeConnection; disabled?: boolean }): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const setRoute = useConnectionsStore(state => state.setAccountRoute);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = zh ? "用于其他 Harness" : "Use with other harnesses";
  const references = connection.accountMeta?.referencedByHarnesses?.map(accountHarnessName).join(zh ? "、" : ", ");
  const change = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await setRoute(connection.id, enabled); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="connection-enabled-control">
    <div><strong>{label}</strong><p>{connection.accountGateway && references ? (zh ? `正被 ${references} 引用` : `Used by ${references}`) : (zh ? "允许其他兼容 Harness 共享此账号" : "Share this account with compatible harnesses")}</p>{error && <p className="text-danger" role="alert">{error}</p>}</div>
    <Switch checked={connection.accountGateway === true} disabled={disabled || busy || !connection.enabled} onCheckedChange={enabled => void change(enabled)} aria-label={label} />
  </div>;
}
