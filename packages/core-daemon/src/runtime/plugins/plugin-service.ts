import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { PROVIDER_API_VERSION, type AgentCliAdapter, type ProviderPluginFactory, type ProviderPluginManifest, type ProviderRegistryEntry } from "@agenthub/provider-sdk";
import { CoreError } from "../../errors.js";
import type { AdapterRegistry } from "../../adapters/index.js";

const execFileAsync = promisify(execFile);

/** Default marketplace registry; overridable per-call or via env. */
const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/zhufish-aa/nautilo-provider-registry/main/registry.json";

export interface ProviderPluginRecord {
  id: string;
  enabled: boolean;
  status: "loaded" | "error" | "disabled";
  error?: string;
  dir: string;
  manifest?: ProviderPluginManifest;
}

/** Presence of this marker file inside a plugin dir keeps it unloaded. */
const DISABLED_MARKER = ".disabled";
const MANIFEST_FILE = "agenthub-plugin.json";

/**
 * Loads provider plugins from `<dataDir>/plugins/<id>/` and registers their
 * adapters. One broken plugin never blocks the daemon — it is recorded with
 * status "error" and surfaced via plugin.list.
 *
 * Trust model: plugins are arbitrary local code, installed only by explicit
 * user action (marketplace install or local directory pick).
 */
export class PluginService {
  private readonly pluginsDir: string;
  private readonly records = new Map<string, ProviderPluginRecord>();
  /** Ids currently registered by this service (plugins may be reloaded). */
  private readonly loadedIds = new Set<string>();
  /**
   * Adapters a loaded plugin replaced (typically built-ins), restored when
   * the plugin is disabled or uninstalled.
   */
  private readonly overridden = new Map<string, AgentCliAdapter>();
  /** Resolves once the startup scan finished; startDaemon awaits it. */
  readonly ready: Promise<void>;

  constructor(
    dataDir: string,
    private readonly adapters: AdapterRegistry
  ) {
    this.pluginsDir = join(dataDir, "plugins");
    this.ready = this.loadAll();
  }

  list(): ProviderPluginRecord[] {
    return [...this.records.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Installs from a local plugin directory (copies it into the plugins root). */
  async installLocal(sourceDir: string): Promise<ProviderPluginRecord> {
    const manifest = await this.readManifest(sourceDir);
    this.validateManifest(manifest, sourceDir);
    const target = join(this.pluginsDir, manifest.id);
    await mkdir(this.pluginsDir, { recursive: true });
    await rm(target, { recursive: true, force: true });
    // Skip symlinks (e.g. pnpm workspace links in a developer checkout):
    // Windows refuses to recreate them without privilege, and plugin runtime
    // code must be self-contained anyway.
    await cp(sourceDir, target, { recursive: true, filter: (source) => !lstatSync(source).isSymbolicLink() });
    return this.loadOne(manifest.id);
  }

  /** Fetches the marketplace registry entries. */
  async fetchRegistry(registryUrl?: string): Promise<ProviderRegistryEntry[]> {
    const url = registryUrl ?? process.env.AGENTHUB_PLUGIN_REGISTRY ?? DEFAULT_REGISTRY_URL;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new CoreError("PLUGIN_REGISTRY_UNAVAILABLE", { url, reason: errorMessage(error) });
    }
    if (!response.ok) throw new CoreError("PLUGIN_REGISTRY_UNAVAILABLE", { status: response.status, url, reason: `HTTP ${response.status}` });
    const data = await response.json().catch((error) => {
      throw new CoreError("PLUGIN_REGISTRY_UNAVAILABLE", { url, reason: `registry JSON 解析失败：${errorMessage(error)}` });
    }) as { plugins?: ProviderRegistryEntry[] };
    return (data.plugins ?? []).filter((entry) => entry?.id && entry.tarball);
  }

  /** Installs a plugin from the marketplace registry (download → sha256 → extract → load). */
  async installFromRegistry(pluginId: string, registryUrl?: string): Promise<ProviderPluginRecord> {
    const entries = await this.fetchRegistry(registryUrl);
    const entry = entries.find((item) => item.id === pluginId);
    if (!entry) throw new CoreError("IPC_NOT_FOUND", { resource: "registryPlugin", id: pluginId });
    return this.installTarball(entry.tarball, entry.sha256);
  }

  /** Downloads a .tgz plugin package, verifies its checksum and installs it. */
  async installTarball(tarballUrl: string, sha256?: string): Promise<ProviderPluginRecord> {
    const scratch = await mkdtemp(join(tmpdir(), "agenthub-plugin-"));
    try {
      let response: Response;
      try {
        response = await fetch(tarballUrl);
      } catch (error) {
        throw new CoreError("PLUGIN_DOWNLOAD_FAILED", { url: tarballUrl, reason: errorMessage(error) });
      }
      if (!response.ok) throw new CoreError("PLUGIN_DOWNLOAD_FAILED", { status: response.status, url: tarballUrl, reason: `HTTP ${response.status}` });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (sha256) {
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== sha256.toLowerCase()) {
          throw new CoreError("PLUGIN_CHECKSUM_MISMATCH", { expected: sha256.toLowerCase(), actual: digest });
        }
      }
      const archive = join(scratch, "plugin.tgz");
      await writeFile(archive, buffer);
      const extractDir = join(scratch, "extract");
      await mkdir(extractDir, { recursive: true });
      // bsdtar ships with Windows 10+ and every supported unix — no npm tar
      // dep. --force-local keeps GNU tar from treating "C:\..." as a remote
      // host:path spec, and forward slashes keep MSYS GNU tar happy when Git
      // Bash's tar shadows the system bsdtar.
      await execFileAsync("tar", ["--force-local", "-xzf", tarPath(archive), "-C", tarPath(extractDir)]);
      return await this.installLocal(await this.findPluginRoot(extractDir));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Tarballs may wrap the plugin in a top-level folder (e.g. npm pack's package/). */
  private async findPluginRoot(dir: string): Promise<string> {
    if (await exists(join(dir, MANIFEST_FILE))) return dir;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && await exists(join(dir, entry.name, MANIFEST_FILE))) return join(dir, entry.name);
    }
    throw new CoreError("PLUGIN_MANIFEST_MISSING", { dir });
  }

  async uninstall(pluginId: string): Promise<{ removed: true }> {
    await this.unload(pluginId);
    this.records.delete(pluginId);
    await rm(join(this.pluginsDir, pluginId), { recursive: true, force: true });
    return { removed: true };
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<ProviderPluginRecord> {
    const dir = join(this.pluginsDir, pluginId);
    const manifest = await this.readManifest(dir).catch(() => undefined);
    if (!manifest) throw new CoreError("IPC_NOT_FOUND", { resource: "plugin", id: pluginId });
    if (enabled) {
      await rm(join(dir, DISABLED_MARKER), { force: true });
      return this.loadOne(pluginId);
    }
    await writeFile(join(dir, DISABLED_MARKER), new Date().toISOString(), "utf8");
    await this.unload(pluginId);
    const record: ProviderPluginRecord = { id: pluginId, enabled: false, status: "disabled", dir, manifest };
    this.records.set(pluginId, record);
    return record;
  }

  async stop(): Promise<void> {
    for (const pluginId of [...this.loadedIds]) await this.unload(pluginId);
  }

  private async unload(pluginId: string): Promise<void> {
    if (!this.loadedIds.delete(pluginId)) return;
    const adapter = this.adapters.find(pluginId);
    await adapter?.dispose?.();
    const previous = this.overridden.get(pluginId);
    if (previous) {
      // The plugin had replaced another adapter (e.g. a built-in): put it back.
      this.overridden.delete(pluginId);
      this.adapters.register(previous);
    } else {
      this.adapters.unregister(pluginId);
    }
  }

  private async loadAll(): Promise<void> {
    await mkdir(this.pluginsDir, { recursive: true });
    const entries = await readdir(this.pluginsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.pluginsDir, entry.name);
      const manifest = await this.readManifest(dir).catch(() => undefined);
      if (!manifest) continue;
      if (await exists(join(dir, DISABLED_MARKER))) {
        this.records.set(entry.name, { id: entry.name, enabled: false, status: "disabled", dir, manifest });
        continue;
      }
      await this.loadOne(entry.name);
    }
  }

  private async loadOne(pluginId: string): Promise<ProviderPluginRecord> {
    const dir = join(this.pluginsDir, pluginId);
    try {
      const manifest = await this.readManifest(dir);
      this.validateManifest(manifest, dir);
      await this.unload(pluginId);
      // Cache-buster so reinstalling the same plugin path picks up new code.
      const entryUrl = `${pathToFileURL(join(dir, manifest.main)).href}?v=${Date.now()}`;
      const module = await import(entryUrl) as { default?: ProviderPluginFactory };
      if (typeof module.default !== "function") throw new Error("插件入口缺少默认导出的工厂函数");
      const adapter: AgentCliAdapter = module.default({ sdkVersion: String(PROVIDER_API_VERSION) });
      if (adapter?.providerId !== manifest.id) throw new Error(`适配器 providerId（${adapter?.providerId ?? "缺失"}）与插件 id（${manifest.id}）不一致`);
      // Snapshot whatever the plugin is about to replace (a built-in, or an
      // adapter from outside this service) so unload() can restore it. On a
      // plugin reload, unload() already restored the previous adapter, which
      // is exactly what we snapshot here.
      const existing = this.adapters.find(manifest.id);
      if (existing) this.overridden.set(manifest.id, existing);
      this.adapters.register(adapter);
      this.loadedIds.add(pluginId);
      const record: ProviderPluginRecord = { id: pluginId, enabled: true, status: "loaded", dir, manifest };
      this.records.set(pluginId, record);
      return record;
    } catch (error) {
      const record: ProviderPluginRecord = {
        id: pluginId,
        enabled: true,
        status: "error",
        // CoreError carries the actionable cause in details.reason; its
        // top-level message is the generic catalog text.
        error: error instanceof CoreError && typeof error.descriptor.details?.reason === "string"
          ? error.descriptor.details.reason
          : errorMessage(error),
        dir
      };
      this.records.set(pluginId, record);
      return record;
    }
  }

  private async readManifest(dir: string): Promise<ProviderPluginManifest> {
    const file = join(dir, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new CoreError("PLUGIN_MANIFEST_MISSING", { dir, reason: `未找到 ${MANIFEST_FILE}：${file}` });
    }
    try {
      return JSON.parse(raw) as ProviderPluginManifest;
    } catch (error) {
      throw new CoreError("PLUGIN_INVALID", { dir, reason: `清单 JSON 解析失败：${errorMessage(error)}` });
    }
  }

  private validateManifest(manifest: ProviderPluginManifest, dir: string): void {
    const fail = (reason: string): never => {
      throw new CoreError("PLUGIN_INVALID", { dir, reason });
    };
    if (!manifest || typeof manifest !== "object") fail("插件清单不是有效的 JSON 对象");
    if (!manifest.id || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) fail("插件 id 缺失或含非法字符");
    if (manifest.apiVersion !== PROVIDER_API_VERSION) {
      fail(`插件 API 版本不兼容（插件 ${manifest.apiVersion}，宿主 ${PROVIDER_API_VERSION}）`);
    }
    if (!manifest.main) fail("插件清单缺少 main 入口");
    if (manifest.descriptor?.providerId !== manifest.id) fail("descriptor.providerId 必须与插件 id 一致");
    if (!manifest.descriptor.name || !manifest.descriptor.vendor) fail("descriptor 缺少 name/vendor");
    if (!Array.isArray(manifest.descriptor.capabilities)) fail("descriptor.capabilities 必须是数组");
    // A plugin whose id matches a built-in provider deliberately overrides
    // it: the built-in adapter is restored when the plugin is disabled or
    // uninstalled (see unload()).
    void dir;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node accepts forward slashes on Windows; MSYS GNU tar requires them. */
function tarPath(path: string): string {
  return path.replaceAll("\\", "/");
}
