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
import { EnvironmentPolicyService } from "../security/environment-policy.js";
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
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
  private readonly records: JsonRepository<Checkpoint>;

  private constructor(
    private readonly db: Database,
    private readonly adapters: AdapterRegistry,
    private readonly account: RuntimeConnection,
    private readonly identity: string,
  ) {
    this.records = new JsonRepository(
      db.connection.raw,
      "account_gateway_sessions",
    );
    const saved = this.records.get(identity);
    this.nativeId = saved?.nativeSessionId;
    this.hashes = saved?.hashes ?? [];
    this.signature = saved?.tools;
  }

  static async open(
    db: Database,
    adapters: AdapterRegistry,
    credentials: CredentialService,
    account: RuntimeConnection,
    identity: string,
    outer: AdapterStartRequest,
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

  async cancel(): Promise<void> {
    this.callerTools.cancel();
    this.output?.push({ error: "Account relay cancelled" });
    this.output?.close();
    await this.active?.cancel();
    this.finishTurn();
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
      const body = await readRequest(req);
      if (this.active) {
        if (!this.callerTools.deliver(body.messages))
          throw new RelayError(
            409,
            "TOOL_RESULTS_REQUIRED",
            "Return pending tool results before starting another turn",
          );
      } else this.startTurn(body);
      const frames = this.frames!;
      await writeCompletion(
        res,
        body,
        () => frames.next(),
        () => this.cancel(),
        () => this.finishTurn(),
      );
    } finally {
      this.handling = false;
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
    if (
      this.hashes.length > hashes.length ||
      this.hashes.some((old, index) => old !== hashes[index])
    ) {
      throw new RelayError(
        409,
        "NATIVE_CONVERSATION_DIVERGED",
        "Start an explicit new chat for a different caller history",
      );
    }
    const signature = hash(body.tools ?? []);
    if (this.signature && this.signature !== signature)
      throw new RelayError(
        409,
        "NATIVE_TOOLS_CHANGED",
        "Start a new chat after changing the caller tool set",
      );
    const input = messages
      .slice(this.hashes.length)
      .filter((message) => !["assistant", "tool"].includes(message.role));
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
    const output = new AsyncQueue<Json>();
    const request: AdapterStartRequest = {
      ...this.template,
      model: body.model ?? this.template.model,
      reasoningEffort: body.reasoning_effort ?? this.template.reasoningEffort,
      prompt:
        "You provide the model for a separate harness. Preserve the supplied message roles. " +
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
    }, () => {
      this.hashes = hashes;
      this.signature = signature;
      this.checkpoint();
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
  }
  private checkpoint(): void {
    this.records.save(
      {
        id: this.identity,
        nativeSessionId: this.nativeId,
        hashes: this.hashes,
        tools: this.signature,
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
  outer: AdapterStartRequest,
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
      new EnvironmentPolicyService().build(undefined),
      credentials,
      adapter.descriptor,
    ),
  };
}
