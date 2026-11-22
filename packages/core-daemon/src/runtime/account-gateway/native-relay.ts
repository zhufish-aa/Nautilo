import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AgentInstance, RuntimeConnection } from "@agenthub/domain";
import type { AdapterRun, AdapterStartRequest } from "../../adapters/index.js";
import { AdapterRegistry } from "../../adapters/index.js";
import { AsyncQueue } from "../../adapters/async-queue.js";
import { Database } from "../../database/index.js";
import { JsonRepository } from "../../database/json-repository.js";
import { CredentialService } from "../security/credential-service.js";
import { EnvironmentPolicyService, providerEnvironmentPassthrough } from "../security/environment-policy.js";
import {
  applyConnection,
  connectionEnvironment,
} from "../runtime-connection.js";
import { writeCompletion } from "./completion.js";
import { forwardNativeEvents } from "./events.js";
import { CallerTools } from "./caller-tools.js";
import { accountLoginRequired, checkNativeAccountLogin, isAccountAuthenticationError } from "../account-auth.js";
import {
  RelayError,
  readRequest,
  respondError,
  respondJson,
  type Json,
} from "./http.js";

type Checkpoint = {
  id: string;
  nativeSessionId?: string;
  hashes: string[];
  tools?: string;
  routeId?: string;
  model?: string;
  localSessionId?: string;
  reusable?: boolean;
  lastAssistant?: string;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assistantMatches = (message: Json | undefined, expected: string | undefined) => {
  if (!message || expected === undefined || message.role !== "assistant" || message.tool_calls?.length) return false;
  const content = Array.isArray(message.content)
    ? message.content.every((part: Json) => part.type === "text") && message.content.map((part: Json) => part.text).join("")
    : message.content ?? "";
  return content === expected;
};

export const ASSISTANT_SESSION_ID = "workspace-assistant";

export class NativeRelay {
  url = "";
  readonly key = randomUUID();
  server!: Server;
  private active?: AdapterRun;
  private frames?: AsyncIterator<Json>;
  private output?: AsyncQueue<Json>;
  private readonly callerTools = new CallerTools();
  private hashes: string[] = [];
  private nativeId?: string;
  private signature?: string;
  private handling = false;
  private template!: AdapterStartRequest;
  private readonly conversations: NativeRelay[] = [];
  private model?: string;
  private lastAssistant?: string;
  private reusable = true;
  private usedAt = Date.now();
  private inflightHashes?: string[];
  private inflightSignature?: string;
  private readonly records: JsonRepository<Checkpoint>;

  private constructor(
    private readonly db: Database,
    private readonly adapters: AdapterRegistry,
    private readonly account: RuntimeConnection,
    private readonly identity: string,
    private readonly routeId = identity,
  ) {
    this.records = new JsonRepository(
      db.connection.raw,
      "account_gateway_sessions",
    );
    const saved = this.records.get(identity);
    this.nativeId = saved?.nativeSessionId;
    this.hashes = saved?.hashes ?? [];
    this.signature = saved?.tools;
    this.model = saved?.model;
    this.lastAssistant = saved?.lastAssistant;
    this.reusable = saved?.reusable !== false;
  }

  static async open(
    db: Database,
    adapters: AdapterRegistry,
    credentials: CredentialService,
    account: RuntimeConnection,
    identity: string,
    outer: Pick<AdapterStartRequest, "cwd">,
  ): Promise<NativeRelay> {
    const relay = new NativeRelay(db, adapters, account, identity);
    relay.template = accountRequest(
      db,
      adapters,
      credentials,
      account,
      identity,
      outer,
    );
    for (const saved of relay.records.list().filter(saved => (saved.routeId === identity || saved.id === identity) && saved.nativeSessionId && saved.reusable !== false).slice(0,8)) {
      const child = new NativeRelay(db, adapters, account, saved.id, identity);
      child.template = { ...relay.template, localSessionId: saved.localSessionId ?? `relay-${saved.id}` };
      relay.conversations.push(child);
    }
    relay.server = createServer((req, res) => {
      void relay.handle(req, res).catch((error) => respondError(res, error));
    });
    relay.server.headersTimeout = 15_000;
    relay.server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      relay.server.once("error", reject);
      relay.server.listen(0, "127.0.0.1", resolve);
    });
    relay.server.unref();
    const address = relay.server.address();
    if (!address || typeof address === "string")
      throw Error("Account gateway listener unavailable");
    relay.url = `http://127.0.0.1:${address.port}/${relay.key}/v1`;
    return relay;
  }

  update(outer: AdapterStartRequest): void {
    Object.assign(this.template, {
      requestInteraction: outer.requestInteraction,
      permissionMode: outer.permissionMode,
      timeoutMs: outer.timeoutMs,
      idleTimeoutMs: outer.idleTimeoutMs,
      model: outer.model,
      reasoningEffort: outer.reasoningEffort,
      serviceTier: outer.serviceTier,
    });
  }

  async checkLogin(): Promise<void> {
    await checkNativeAccountLogin(this.account, this.template);
  }

  async configureModels(outer: AdapterStartRequest): Promise<void> {
    if (this.account.harness !== "opencode" || !outer.model) return;
    const catalog = await this.adapters.listModels(this.template.instance, { env: this.template.env });
    const discovered = catalog.models.find(model => model.id === outer.model);
    if (!discovered) return;
    const models = [...(outer.instance.models ?? [])];
    const index = models.findIndex(model => model.id === outer.model);
    if (index < 0) models.push(discovered);
    else models[index] = { ...discovered, ...models[index] };
    outer.instance = { ...outer.instance, models };
  }

  async cancel(): Promise<void> {
    await Promise.all(this.conversations.map(child => child.cancel()));
    if (!this.active && !this.handling) return;
    this.reusable = false;
    this.callerTools.cancel();
    this.output?.push({ error: "Account relay cancelled" });
    this.output?.close();
    await this.active?.cancel();
    this.finishTurn();
    this.checkpoint();
  }

  private authorized(req: IncomingMessage): void {
    if (
      req.headers.authorization !== `Bearer ${this.key}` ||
      !req.url?.startsWith(`/${this.key}/v1/`)
    ) {
      throw new RelayError(
        401,
        "GATEWAY_AUTH_REQUIRED",
        "Invalid local gateway credential",
      );
    }
    const settings = this.db.integrationSettings.get("integration-settings");
    if (
      !this.db.runtimeConnections.get(this.account.id)?.enabled ||
      !settings?.gateway.enabled ||
      !settings.gateway.connectionIds.includes(this.account.id)
    ) {
      throw new RelayError(
        403,
        "ACCOUNT_ROUTE_DISABLED",
        "The selected account route is disabled",
      );
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    this.authorized(req);
    if (req.url!.endsWith("/models")) {
      respondJson(res, 200, {
        object: "list",
        data: (this.account.models ?? []).map((model) => ({
          id: model.id,
          object: "model",
        })),
      });
      return;
    }
    if (req.method !== "POST" || !req.url!.endsWith("/chat/completions"))
      throw new RelayError(
        404,
        "GATEWAY_ROUTE_NOT_FOUND",
        "Use the Chat Completions endpoint",
      );
    const body = await readRequest(req);
    const child = this.selectConversation(body);
    try { await child.complete(body, res); }
    finally {
      if (this.isAssistant()) {
        // Assistant steps carry their own context and never resume parked tools.
        child.reusable = false;
        await child.cancel();
      }
      this.pruneConversations();
    }
  }

  private selectConversation(body: Json): NativeRelay {
    const hashes = body.messages.map(hash);
    const signature = hash(body.tools ?? []);
    const model = body.model ?? this.template.model;
    for (const child of [...this.conversations].reverse()) {
      if (child.handling || !child.reusable || (child.model && child.model !== model)) continue;
      const prefix = child.inflightHashes ?? child.hashes;
      if ((child.inflightSignature ?? child.signature) !== signature || prefix.length > hashes.length || prefix.some((old,index)=>old !== hashes[index])) continue;
      const pending = !!child.active && child.callerTools.ownsResults(body.messages);
      const next = !child.active && child.nativeId && this.adapters.get(this.account.harness!).resume
        && assistantMatches(body.messages[prefix.length], child.lastAssistant)
        && body.messages.slice(prefix.length).some((message: Json)=>message.role !== "assistant" && message.role !== "tool");
      if (!pending && !next) continue;
      child.template = { ...this.template, localSessionId: child.template.localSessionId };
      return child;
    }
    const identity = `${this.identity}:request:${randomUUID()}`;
    const child = new NativeRelay(this.db,this.adapters,this.account,identity,this.identity);
    child.template = { ...this.template, localSessionId: `relay-${identity}` };
    child.model = model;
    this.conversations.push(child);
    return child;
  }

  private pruneConversations(): void {
    let idle = 0;
    for (let i = this.conversations.length-1; i >= 0; i--) {
      const child = this.conversations[i];
      if (child.handling || child.active || child.callerTools.hasPending) continue;
      if (++idle > 8 || !child.reusable || Date.now()-child.usedAt > 3_600_000) this.conversations.splice(i,1);
    }
  }

  private async complete(body: Json, res: ServerResponse): Promise<void> {
    if (this.handling)
      throw new RelayError(
        409,
        "CONVERSATION_BUSY",
        "This conversation already has an active request",
      );
    this.handling = true;
    const onClose = () => {
      if (!res.writableEnded) void this.cancel();
    };
    res.once("close", onClose);
    try {
      if (this.active) {
        if (!this.callerTools.deliver(body.messages))
          throw new RelayError(
            409,
            "TOOL_RESULTS_REQUIRED",
            "Return pending tool results before starting another turn",
          );
        this.inflightHashes = body.messages.map(hash);
        this.inflightSignature = hash(body.tools ?? []);
      } else this.startTurn(body);
      const frames = this.frames!;
      await writeCompletion(
        res,
        body,
        () => frames.next(),
        () => this.cancel(),
        content => {
          this.hashes = this.inflightHashes ?? this.hashes;
          this.signature = this.inflightSignature ?? this.signature;
          this.lastAssistant = content;
          this.finishTurn();
          this.checkpoint();
        },
      );
    } catch (error) {
      this.reusable = false;
      await this.cancel();
      this.checkpoint();
      throw error;
    } finally {
      this.handling = false;
      this.usedAt = Date.now();
      res.off("close", onClose);
    }
  }

  private prepareInput(body: Json): {
    input: Json[];
    hashes: string[];
    signature: string;
  } {
    const messages = body.messages as Json[];
    const hashes = messages.map(hash);
    const signature = hash(body.tools ?? []);
    const input = messages
      .slice(this.hashes.length)
      .filter((message) => !this.nativeId || !["assistant", "tool"].includes(message.role));
    if (!input.length)
      throw new RelayError(400, "NO_NEW_INPUT", "No new caller input");
    if (
      input.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part: Json) => part.type === "image_url"),
      )
    ) {
      throw new RelayError(
        400,
        "IMAGE_REQUIRES_RUST",
        "The reference Node relay requires the Rust backend for image requests",
      );
    }
    return { input, hashes, signature };
  }

  private startTurn(body: Json): void {
    const { input, hashes, signature } = this.prepareInput(body);
    this.inflightHashes = hashes;
    this.inflightSignature = signature;
    const output = new AsyncQueue<Json>();
    const request: AdapterStartRequest = {
      ...this.template,
      model: body.model ?? this.template.model,
      reasoningEffort: body.reasoning_effort ?? this.template.reasoningEffort,
      prompt:
        "You handle a model request for a separate harness. Preserve every supplied message role, assistant tool call and tool result. Do not execute historical calls again. " +
        "Use the corresponding nautilo_relay_N tool for caller tools, then wait for its real result. " +
        `The outer harness executes those tools.\n${JSON.stringify(input)}`,
      ...this.callerTools.bind(body.tools ?? [], output),
    };
    const adapter = this.adapters.get(this.account.harness!);
    if (this.nativeId && !adapter.resume)
      throw new RelayError(
        409,
        "NATIVE_RESUME_UNAVAILABLE",
        "The selected native runtime cannot resume its account conversation",
      );
    const run = this.nativeId
      ? adapter.resume!({ ...request, providerSessionId: this.nativeId })
      : adapter.start(request);
    this.active = run;
    this.output = output;
    this.frames = output[Symbol.asyncIterator]();
    void forwardNativeEvents(run, output, nativeId => {
      this.nativeId = nativeId;
    }, message => {
      return isAccountAuthenticationError(message)
        ? `AGENT_NOT_AUTHENTICATED ${accountLoginRequired(this.account).message}`
        : message;
    });
  }

  private finishTurn(): void {
    this.active = undefined;
    this.frames = undefined;
    this.output = undefined;
    this.inflightHashes = undefined;
    this.inflightSignature = undefined;
  }
  private isAssistant(): boolean {
    return this.routeId.startsWith(`${ASSISTANT_SESSION_ID}:`);
  }
  private checkpoint(): void {
    if (this.isAssistant()) return;
    this.records.save(
      {
        id: this.identity,
        nativeSessionId: this.nativeId,
        hashes: this.hashes,
        tools: this.signature,
        routeId: this.routeId,
        model: this.model,
        lastAssistant: this.lastAssistant,
        localSessionId: this.template.localSessionId,
        reusable: this.reusable,
      },
      new Date().toISOString(),
    );
  }
}

function accountRequest(
  db: Database,
  adapters: AdapterRegistry,
  credentials: CredentialService,
  account: RuntimeConnection,
  identity: string,
  outer: Pick<AdapterStartRequest, "cwd">,
): AdapterStartRequest {
  const provider = account.harness!;
  const adapter = adapters.get(provider);
  const source =
    db.agents.list().find((agent) => agent.providerId === provider) ??
    ({
      id: `account-relay:${provider}`,
      providerId: provider,
      displayName: provider,
      executable: adapter.descriptor.defaultExecutable!,
      baseArgs: [],
      enabled: true,
      providerOptions: {},
      capabilities: [],
      createdAt: "",
      updatedAt: "",
      status: "offline",
    } as AgentInstance);
  const instance = applyConnection(account, source);
  return {
    instance,
    prompt: "",
    cwd: outer.cwd,
    localSessionId: `relay-${identity}`,
    env: connectionEnvironment(
      account,
      instance,
      new EnvironmentPolicyService().build(undefined, providerEnvironmentPassthrough(instance, process.env, adapter.descriptor)),
      credentials,
      adapter.descriptor,
    ),
  };
}
