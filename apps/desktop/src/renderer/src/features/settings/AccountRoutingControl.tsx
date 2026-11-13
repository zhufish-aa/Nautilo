import { useState } from "react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Switch } from "../../components/ui/Switch";
import { useConnectionsStore } from "../../stores/connections";
import { useI18n } from "../../lib/i18n";

export function AccountRoutingControl({ connection, disabled }: { connection: RuntimeConnection; disabled?: boolean }): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const setRoute = useConnectionsStore(state => state.setAccountRoute);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = zh ? "用于其他 Harness" : "Use with other harnesses";
  const change = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await setRoute(connection.id, enabled); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="connection-full-field">
    <div className="connection-enabled-control"><span className="text-sm">{label}</span><Switch checked={connection.accountGateway === true} disabled={disabled || busy || !connection.enabled} onCheckedChange={enabled => void change(enabled)} aria-label={label} /></div>
    {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
  </div>;
}
