import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "../../database/index.js";
import { CoreError } from "../../errors.js";
import type { AdapterRegistry } from "../../adapters/index.js";

interface StoredCredential { apiKey: string; envName?: string; }

/** Env vars for legacy provider ids that predate descriptor-driven lookup. */
const LEGACY_PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  kimi: ["KIMI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"]
};

/** AES-GCM local vault. Plaintext credentials are never persisted in AgentInstance JSON. */
export class CredentialService {
  private readonly keyPath: string;
  private key?: Buffer;
  constructor(
    private readonly database: Database,
    dataDir: string,
    private readonly adapters?: AdapterRegistry
  ) {
    this.keyPath = join(dataDir, "credential.key");
  }

  set(agentInstanceId: string, credential: StoredCredential): void {
    if (!credential.apiKey.trim()) throw new CoreError("IPC_INVALID_REQUEST", { field: "apiKey" });
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.keyValue(), iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
      this.database.credentials.save(agentInstanceId, {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
      });
    } catch (error) {
      throw new CoreError("CREDENTIAL_STORE_FAILED", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  remove(agentInstanceId: string): boolean { return this.database.credentials.remove(agentInstanceId); }
  has(agentInstanceId: string): boolean { return this.database.credentials.has(agentInstanceId); }

  environment(agentInstanceId: string, providerId: string): Record<string, string> {
    const credential = this.read(agentInstanceId);
    if (!credential) return {};
    if (credential.envName) return { [credential.envName]: credential.apiKey };
    const envNames = this.adapters?.find(providerId)?.descriptor?.credentialEnv ?? LEGACY_PROVIDER_ENV[providerId];
    if (envNames?.length) return Object.fromEntries(envNames.map((name) => [name, credential.apiKey]));
    return { AGENTHUB_API_KEY: credential.apiKey };
  }

  secretValues(): string[] {
    return this.database.agents.list().flatMap((agent) => {
      const credential = this.read(agent.id);
      return credential?.apiKey ? [credential.apiKey] : [];
    });
  }

  private read(agentInstanceId: string): StoredCredential | undefined {
    const encrypted = this.database.credentials.get(agentInstanceId);
    if (!encrypted) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.keyValue(), Buffer.from(encrypted.iv, "base64"));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as StoredCredential;
    } catch (error) {
      throw new CoreError("CREDENTIAL_STORE_FAILED", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  private keyValue(): Buffer {
    this.key ??= loadOrCreateKey(this.keyPath);
    return this.key;
  }
}

function loadOrCreateKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }
  const key = readFileSync(path);
  if (key.byteLength !== 32) throw new CoreError("CREDENTIAL_STORE_FAILED", { reason: "invalid_key_length" });
  return key;
}
