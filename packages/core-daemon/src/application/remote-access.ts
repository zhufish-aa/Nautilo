import type { RemoteStatus } from "@agenthub/schemas";
import type { IpcGateway } from "../ipc-gateway.js";

/** QUIC is hosted by the production Rust daemon. Legacy Node clients receive
 * an explicit capability result instead of silently pretending to listen. */
export function registerRemoteAccess(gateway: IpcGateway): void {
  gateway.register(
    "remote.status",
    async (): Promise<RemoteStatus> => ({
      supported: false,
      state: "disabled",
      internetReady: false,
      devices: [],
      pending: [],
      settings: {
        enabled: false,
        deviceName: "Nautilo",
        relayMode: "automatic",
        relayUrls: [],
        keepAwake: true,
      },
      error: "Remote access requires the Rust backend",
    }),
  );
  const unsupported = async (): Promise<never> => {
    throw new Error(
      "REMOTE_BACKEND_REQUIRED: Remote access requires the Rust backend",
    );
  };
  gateway.register("remote.configure", unsupported);
  gateway.register("remote.invite", unsupported);
  gateway.register("remote.cancelInvite", unsupported);
  gateway.register("remote.approve", unsupported);
  gateway.register("remote.reject", unsupported);
  gateway.register("remote.revoke", unsupported);
  gateway.register("remote.updateDevice", unsupported);
}
