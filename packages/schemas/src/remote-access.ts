/** Desktop management API. The network protocol only exposes RemoteMethod. */
export interface RemoteSettings {
  enabled: boolean;
  deviceName: string;
  relayMode: "automatic" | "custom" | "local";
  relayUrls: string[];
  keepAwake: boolean;
}
export interface RemoteGrant {
  /** Kept optional for old local clients. Pairing grants the owner's full workspace. */
  access?: "control";
  projectIds?: string[];
}
export interface RemoteDevice extends RemoteGrant {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
  connected: boolean;
  connectionType?: "direct" | "relay" | "mixed" | "connecting";
  latencyMs?: number;
}
export interface RemotePendingDevice {
  id: string;
  name: string;
  code: string;
  expiresAt: number;
}
export interface RemoteStatus {
  supported: boolean;
  settings: RemoteSettings;
  state: "disabled" | "starting" | "listening" | "error";
  endpointId?: string;
  internetReady: boolean;
  error?: string;
  devices: RemoteDevice[];
  pending: RemotePendingDevice[];
}
export interface RemoteInvitation {
  uri: string;
  qrSvg: string;
  expiresAt: number;
}
export type RemoteMethod =
  | "hello"
  | "pair"
  | "pair.status"
  | "projects.list"
  | "project.browse"
  | "project.create"
  | "session.options"
  | "session.catalog"
  | "sessions.list"
  | "session.history"
  | "session.create"
  | "session.details"
  | "session.models"
  | "session.configure"
  | "session.workspace"
  | "events.wait"
  | "session.send"
  | "session.followUp"
  | "run.list"
  | "run.cancel"
  | "interaction.list"
  | "interaction.respond"
  | "approval.list"
  | "approval.resolve";
/** One bounded JSON request/response per QUIC bidirectional stream. */
export interface RemoteRequest {
  v: 1;
  id: string;
  method: RemoteMethod;
  params: Record<string, unknown>;
}
export type RemoteResponse =
  | { v: 1; id: string; ok: true; data: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } };
