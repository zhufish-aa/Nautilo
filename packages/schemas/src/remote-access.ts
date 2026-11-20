/** Desktop management API. The network protocol only exposes RemoteMethod. */
export interface RemoteSettings {
  enabled: boolean;
  deviceName: string;
  relayMode: "automatic" | "custom" | "direct" | "lan" | "local";
  relayUrls: string[];
  keepAwake: boolean;
}
export interface RemoteRelayNode {
  id: string;
  url: string;
  region: "asia-pacific" | "north-america-east" | "north-america-west" | "europe" | "custom";
  source: "public" | "custom";
  /** PC-to-relay HTTPS /ping time, not the phone-to-PC QUIC RTT. */
  latencyMs?: number;
  measuredAt?: string;
  error?: string;
  viaProxy?: boolean;
}
export interface RemoteRelayCatalog {
  nodes: RemoteRelayNode[];
  measurement: "https";
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
  connectionState?: "punching" | "ready";
  latencyMs?: number;
  paths?: { type: "direct" | "relay"; selected: boolean; latencyMs: number }[];
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
  /** Home relay readiness is independent of the selected device data path. */
  relays?: { url: string; connected: boolean; error?: string | null }[];
  network?: { udpV4: boolean; udpV6: boolean; mappingVariesV4: boolean | null; mappingVariesV6: boolean | null } | null;
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
  | "session.modes"
  | "sessions.list"
  | "session.history"
  | "session.create"
  | "session.details"
  | "session.snapshot"
  | "session.models"
  | "session.configure"
  | "session.workspace"
  | "session.compact"
  | "session.team"
  | "session.team.cancel"
  | "session.team.retry"
  | "events.wait"
  | "session.send"
  | "session.followUp"
  | "attachment.upload"
  | "attachment.read"
  | "run.list"
  | "run.cancel"
  | "interaction.list"
  | "interaction.respond"
  | "approval.list"
  | "approval.resolve";
/** Resumable phone attachment upload, limited to 20 MiB per file. */
export interface RemoteAttachmentChunk {
  uploadId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  offset: number;
  /** Base64, at most 128 KiB decoded. Empty data queries the durable offset. */
  data: string;
}
/** Read an existing message attachment by reference, never by a desktop path. */
export interface RemoteAttachmentRead {
  sessionId: string;
  attachmentId: string;
  offset?: number;
  /** At most 512 KiB decoded bytes per response; total file limit is 20 MiB. */
  length?: number;
}
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
