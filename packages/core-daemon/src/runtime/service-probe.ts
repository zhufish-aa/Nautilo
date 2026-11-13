import { homedir } from "node:os";
import type { ProviderCapability, ProviderModelCatalog, RuntimeConnection } from "@agenthub/domain";
import type { DiagnosticStage, DiagnosticState, ServiceDiagnostic } from "@agenthub/schemas";
import { ProcessRuntime } from "../process-runtime.js";
import { JsonRpcProcessClient } from "../adapters/json-rpc-process.js";
import { capabilityToMcpServer } from "../application/capability-service.js";
import { RedactionService } from "./security/redaction-service.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
export class ProbeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const timeout = () => new ProbeError("TIMEOUT", "The service did not answer this handshake step within 15 seconds.");
async function within<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const makeReport = (id: string, version: string, scope: ServiceDiagnostic["scope"]): ServiceDiagnostic => ({ subjectId: id, configurationVersion: version, scope, state: "passed", checkedAt: new Date().toISOString(), elapsedMs: 0, steps: [] });
function step(report: ServiceDiagnostic, id: DiagnosticStage, state: DiagnosticState, started: number, error?: ProbeError): void {
  report.steps.push({ id, state, elapsedMs: Math.round(performance.now() - started), ...(error ? { code: error.code, message: error.message.slice(0, 1600) } : {}) });
  if (state === "failed" || state === "warning" && report.state !== "failed") report.state = state;
}

/** GET /models checks only the catalog, never inference or a tool call. */
export async function diagnoseConnection(connection: RuntimeConnection, discover: () => Promise<ProviderModelCatalog>): Promise<ServiceDiagnostic> {
  const started = performance.now();
  const report = makeReport(connection.id, String(connection.revision), connection.kind === "login" ? "account_catalog" : "api_catalog");
  if (!connection.enabled) { step(report, "configuration", "warning", started, new ProbeError("DISABLED", "Enable this connection before checking it.")); return report; }
  step(report, "configuration", "passed", started);
  if (connection.kind === "api") step(report, "credential", !connection.hasCredential ? "warning" : "passed", performance.now(), !connection.hasCredential ? new ProbeError("CREDENTIAL_MISSING", "No API key is stored for this connection. No other account will be used.") : undefined);
  const check = performance.now();
  try {
    const catalog = await within(discover(), 30_000);
    if (catalog.source === "unavailable" || catalog.warning) step(report,"catalog","warning",check,new ProbeError("CATALOG_UNAVAILABLE","The selected account did not return a model catalog. Check its native login state."));
    else { report.modelCount = catalog.models.length; step(report,"catalog",catalog.models.length ? "passed" : "warning",check,catalog.models.length ? undefined : new ProbeError("EMPTY_CATALOG","The catalog is empty.")); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ProbeError ? error.code : /401|403/.test(message) ? "AUTH_REQUIRED" : /404/.test(message) ? "CATALOG_NOT_SUPPORTED" : /timeout|timed out/i.test(message) ? "TIMEOUT" : "CATALOG_UNAVAILABLE";
    step(report,"catalog",code === "CATALOG_NOT_SUPPORTED" ? "warning" : "failed",check,new ProbeError(code,message));
  }
  report.elapsedMs = Math.round(performance.now() - started);
  return report;
}

interface Rpc { request(id: number, method: string, params: unknown): Promise<ObjectValue>; initialized(version: string): Promise<void>; close(): Promise<void> }
function rpcResult(reply: ObjectValue, id: number): ObjectValue {
  if (reply.id !== id) throw new ProbeError("PROTOCOL_ERROR", "The service returned a different request ID.");
  if (reply.error) throw new ProbeError("PROTOCOL_ERROR", text(object(reply.error).message) || "JSON-RPC returned an error.");
  if (!reply.result || typeof reply.result !== "object" || Array.isArray(reply.result)) throw new ProbeError("PROTOCOL_ERROR", "Expected a JSON-RPC result object.");
  return object(reply.result);
}
function httpRpc(url: string, headers: Record<string, string>): Rpc {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new ProbeError("INVALID_ENDPOINT", "Use an absolute HTTP(S) MCP URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new ProbeError("INVALID_ENDPOINT", "Use an HTTP(S) MCP URL without credentials or a fragment.");
  let session: string | undefined, protocol: string | undefined;
  const requestHeaders = () => ({ ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}), ...(protocol ? { "MCP-Protocol-Version": protocol } : {}) });
  const send = async (body: ObjectValue): Promise<ObjectValue> => {
    let response: Response;
    try { response = await fetch(url, { method:"POST", headers:requestHeaders(), body:JSON.stringify(body), redirect:"manual", signal:AbortSignal.timeout(15_000) }); }
    catch (error) { throw new ProbeError(error instanceof Error && /timeout|abort/i.test(error.name) ? "TIMEOUT" : "NETWORK_ERROR", "Unable to reach the MCP HTTP endpoint."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProbeError([401,403].includes(response.status) ? "AUTH_REQUIRED" : response.status === 404 ? "ENDPOINT_NOT_FOUND" : "HTTP_ERROR", `The MCP endpoint returned HTTP ${response.status}.`);
    }
    session = response.headers.get("mcp-session-id") ?? session;
    if (body.id === undefined) { await response.body?.cancel(); return {}; }
    const reader = response.body?.getReader();
    if (!reader) throw new ProbeError("PROTOCOL_ERROR", "The MCP response has no body.");
    const decoder = new TextDecoder();
    let buffer = "", size = 0;
    const sse = response.headers.get("content-type")?.includes("text/event-stream");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new ProbeError("RESPONSE_TOO_LARGE", "The service exceeded the diagnostic response limit.");
        buffer += decoder.decode(value, { stream:true });
        if (sse) {
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0,match.index); buffer = buffer.slice(match.index + match[0].length);
            const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            let reply: ObjectValue; try { reply = object(JSON.parse(data)); } catch { continue; }
            if (reply.id === body.id) return rpcResult(reply, body.id as number);
          }
        }
      }
      try { return rpcResult(object(JSON.parse(buffer + decoder.decode())), body.id as number); }
      catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError("PROTOCOL_ERROR", "The endpoint did not return a JSON-RPC response."); }
    } finally { await reader.cancel().catch(() => undefined); }
  };
  return {
    request: (id,method,params) => within(send({ jsonrpc:"2.0", id, method, params })),
    initialized: async version => { protocol = version; await within(send({ jsonrpc:"2.0", method:"notifications/initialized" })); },
    close: async () => { if (session) await fetch(url, {method:"DELETE",headers:requestHeaders(),redirect:"manual",signal:AbortSignal.timeout(2000)}).then(r=>r.body?.cancel()).catch(()=>undefined); }
  };
}
function stdioRpc(server: NonNullable<ReturnType<typeof capabilityToMcpServer>>): Rpc {
  if (!server.command?.trim()) throw new ProbeError("COMMAND_MISSING", "No MCP executable is configured.");
  const process = new ProcessRuntime().start({ command:server.command, args:server.args, cwd:server.cwd || homedir(), env:{...globalThis.process.env,...server.env}, timeoutMs:65_000, maxOutputBytes:2 * 1024 * 1024 });
  const rpc = new JsonRpcProcessClient(process);
  let transportError: ProbeError | undefined;
  // Answer only harmless diagnostic client requests. Never execute a server's request.
  void (async () => { for await (const event of rpc) {
    if (event.kind === "transport") {
      if (event.event.kind === "error") transportError = new ProbeError("SPAWN_FAILED", event.event.error.message);
      else if (event.event.kind === "timeout") transportError = event.event.reason === "max_output" ? new ProbeError("RESPONSE_TOO_LARGE", "The service exceeded the diagnostic response limit.") : timeout();
      else if (event.event.kind === "exit") transportError ??= new ProbeError("PROCESS_EXITED", `MCP exited (${event.event.exitCode ?? event.event.signal ?? "unknown"}) before answering.`);
      continue;
    }
    if (event.kind !== "request") continue;
    if (event.method === "ping") rpc.respond(event.id,{});
    else if (event.method === "roots/list") rpc.respond(event.id,{roots:[]});
    else rpc.respondError(event.id,-32601,"Unsupported by the diagnostic client");
  } })();
  return {
    request: async (_id,method,params) => {
      try { return object(await within(rpc.request(method,params))); }
      catch (error) { throw transportError ?? error; }
    },
    initialized: async () => { rpc.notify("notifications/initialized"); },
    close: async () => { process.child.stdin.end(); await within(process.cancel(),3000).catch(()=>undefined); }
  };
}
export async function diagnoseMcp(capability: ProviderCapability): Promise<ServiceDiagnostic> {
  const report = makeReport(capability.id,capability.updatedAt,"mcp_handshake");
  const started = performance.now();
  const server = capabilityToMcpServer(capability);
  if (!server) throw new ProbeError("INVALID_CONFIGURATION", "Only MCP capabilities have a connection handshake.");
  const refs = [capability.mcp?.bearerTokenEnvVar,...Object.values(capability.mcp?.envHeaders ?? {})].filter((v): v is string => !!v);
  const missing = refs.filter(name => !process.env[name]);
  if (missing.length) { step(report,"configuration","failed",started,new ProbeError("ENVIRONMENT_MISSING",`Required environment variables are unavailable to the daemon: ${missing.join(", ")}`)); return report; }
  step(report,"configuration","passed",started);
  let rpc: Rpc | undefined, phase: DiagnosticStage = "launch", phaseStarted = performance.now();
  try {
    rpc = server.transport === "stdio" ? stdioRpc(server) : httpRpc(server.url ?? "",server.headers ?? {});
    step(report,"launch","passed",phaseStarted);
    phase = "initialize"; phaseStarted = performance.now();
    const init = await rpc.request(1,"initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"nautilo-diagnostics",version:"1"}});
    const version = text(init.protocolVersion);
    if (!version) throw new ProbeError("PROTOCOL_ERROR", "The initialize response has no protocol version.");
    await rpc.initialized(version); report.protocolVersion = version; report.serverName = text(object(init.serverInfo).name) || undefined;
    step(report,phase,"passed",phaseStarted);
    phase = "tools"; phaseStarted = performance.now();
    if (!object(init.capabilities).tools) step(report,phase,"warning",phaseStarted,new ProbeError("NO_TOOLS_CAPABILITY","This MCP server does not advertise tools; it may provide resources or prompts instead."));
    else {
      const tools: NonNullable<ServiceDiagnostic["tools"]> = [], names = new Set<string>(), cursors = new Set<string>();
      let cursor = "";
      const deadline = performance.now() + 30_000;
      for (let page = 0; page < 20; page++) {
        if (performance.now() >= deadline) throw timeout();
        const result = await rpc.request(2 + page,"tools/list",cursor ? {cursor} : {});
        if (!Array.isArray(result.tools)) throw new ProbeError("PROTOCOL_ERROR","tools/list did not return a tools array.");
        for (const row of result.tools) {
          const tool = object(row), name = text(tool.name);
          if (!name) throw new ProbeError("PROTOCOL_ERROR","A listed tool has no name.");
          if (names.has(name)) continue; names.add(name);
          if (tools.length < 200) tools.push({name,description:text(tool.description).slice(0,600) || undefined});
        }
        cursor = text(result.nextCursor);
        if (!cursor) break;
        if (cursors.has(cursor)) throw new ProbeError("PROTOCOL_ERROR","tools/list repeated a pagination cursor.");
        cursors.add(cursor);
      }
      report.tools = tools; report.toolCount = names.size; report.truncated = !!cursor || names.size > 200;
      step(report,phase,cursor ? "warning" : "passed",phaseStarted,cursor ? new ProbeError("TOOL_LIST_LIMIT","Tool pagination reached the diagnostic limit.") : undefined);
    }
  } catch (error) { step(report,phase,"failed",phaseStarted,error instanceof ProbeError ? error : new ProbeError(phase === "launch" ? "SPAWN_FAILED" : "PROTOCOL_ERROR",error instanceof Error ? error.message : String(error))); }
  finally { await rpc?.close(); }
  report.elapsedMs = Math.round(performance.now() - started);
  const secrets = [...Object.values(server.env ?? {}),...Object.values(server.headers ?? {})];
  for (const value of Object.values(server.headers ?? {})) if (/^Bearer\s+/i.test(value)) secrets.push(value.replace(/^Bearer\s+/i,""));
  if (server.url) {
    try { for (const value of new URL(server.url).searchParams.values()) secrets.push(value); }
    catch { /* The launch step already records an invalid endpoint. */ }
  }
  return new RedactionService(() => secrets).value(report);
}
