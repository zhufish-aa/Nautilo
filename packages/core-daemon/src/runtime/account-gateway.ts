import { createHash } from "node:crypto";
import type { RuntimeConnection } from "@agenthub/domain";
import type { AdapterStartRequest } from "../adapters/index.js";
import { AdapterRegistry } from "../adapters/index.js";
import { Database } from "../database/index.js";
import { CredentialService } from "./security/credential-service.js";
import { NativeRelay } from "./account-gateway/native-relay.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reference Node daemon uses the selected native CLI for both account kinds.
 * Production Rust additionally has the Codex native Responses/file-store path. */
export class AccountGateways {
  private readonly routes = new Map<string, Promise<NativeRelay>>();
  constructor(
    private readonly db: Database,
    private readonly adapters: AdapterRegistry,
    private readonly credentials: CredentialService,
  ) {}
  async bind(
    session: string,
    account: RuntimeConnection,
    request: AdapterStartRequest,
  ): Promise<void> {
    const identity = `${session}:${account.id}:${account.revision}`;
    let promise = this.routes.get(identity);
    if (!promise) {
      promise = NativeRelay.open(
        this.db,
        this.adapters,
        this.credentials,
        account,
        identity,
        request,
      );
      this.routes.set(identity, promise);
      promise.catch(() => this.routes.delete(identity));
    }
    const relay = await promise;
    await relay.checkLogin();
    relay.update(request);
    request.instance = {
      ...request.instance,
      providerOptions: {
        ...request.instance.providerOptions,
        baseUrl: relay.url,
        apiType: "openai-completions",
        ...(request.instance.providerId === "codex" ? { wireApi: "chat" } : {}),
      },
    };
    Object.assign((request.env ??= {}), {
      NAUTILO_CONNECTION_API_KEY: relay.key,
      AGENTHUB_API_KEY: relay.key,
      OPENAI_API_KEY: relay.key,
      OPENAI_BASE_URL: relay.url,
      NAUTILO_CONNECTION_DIRECTORY:
        this.credentials.connectionDirectory(account.id, account.revision) +
        `/account-relay/${hash(session)}`,
    });
    const descriptor = this.adapters.find(
      request.instance.providerId,
    )?.descriptor;
    for (const key of descriptor?.credentialEnv ?? [])
      request.env![key] = relay.key;
    if (descriptor?.baseUrlEnv) request.env![descriptor.baseUrlEnv] = relay.url;
  }
  async cancelSession(session: string): Promise<void> {
    for (const [id, promise] of this.routes)
      if (id.startsWith(`${session}:`)) await (await promise).cancel();
  }
  async close(): Promise<void> {
    for (const promise of this.routes.values()) {
      const route = await promise;
      await route.cancel();
      route.server.close();
    }
    this.routes.clear();
  }
}
