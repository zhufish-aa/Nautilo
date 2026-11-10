/**
 * Presentation + integration metadata for one provider. Built-in adapters
 * declare it inline; provider plugins ship it in their manifest. The desktop
 * renders the provider catalog (detection page, instance editor, permission
 * mode picker) purely from these descriptors.
 */

/** Bilingual UI text; the renderer picks the entry matching its locale. */
export interface LocalizedText {
  "zh-CN": string;
  "en-US": string;
}

/** One CLI-native permission/approval mode selectable from the UI. */
export interface ProviderPermissionMode {
  /** Value passed to the CLI (AdapterStartRequest.permissionMode). */
  value: string;
  name: LocalizedText;
  description: LocalizedText;
}

/** One provider-native upstream protocol selectable in the instance editor. */
export interface ProviderApiType {
  /** Value persisted in AgentInstance.providerOptions.apiType. */
  value: string;
  name: LocalizedText;
  description: LocalizedText;
}

/** One provider-native command that the adapter can execute headlessly. */
export interface ProviderNativeCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** Dedicated provider transport used instead of sending command text as chat. */
  providerCommand?: string;
  /** Native transport advertised this command; terminal-only commands are not sent as model text. */
  transport?: "prompt" | "rpc" | "terminal";
}

export interface ProviderDescriptor {
  providerId: string;
  name: string;
  vendor: string;
  /** Capability tags surfaced in the UI (e.g. "headless_structured"). */
  capabilities: string[];
  /** Executable name used for detection probes when nothing is configured. */
  defaultExecutable?: string;
  /**
   * Env var name(s) a stored API key is injected as. Every listed variable
   * receives the key (e.g. codex wants both OPENAI_API_KEY and CODEX_API_KEY).
   */
  credentialEnv?: string[];
  /** Shell env vars passed through to provider discovery/run processes. */
  envPassthrough?: string[];
  /** Env var fed from the instance's providerOptions.baseUrl, if supported. */
  baseUrlEnv?: string;
  /** CLI-native permission modes; omit when the CLI has no selectable modes. */
  permissionModes?: ProviderPermissionMode[];
  /** Provider-native upstream API protocols; omit when the provider has no choice. */
  apiTypes?: ProviderApiType[];
  /** Optional native wire for host-managed protocol translation on API bindings. */
  nativeApiProtocol?: "responses" | "anthropic";
  /** Native plugins may negotiate the wire for the installed CLI version. */
  connectionProtocolDiscovery?: boolean;
  /** Version of the provider's durable context format; changes rebuild saved chat once. */
  nativeContextVersion?: string;
  /** The native headless CLI omits API deltas; observe its run-scoped wire. */
  observeApiOutput?: boolean;
  /** Commands available immediately after the provider/plugin is loaded. */
  nativeCommands?: ProviderNativeCommand[];
  /**
   * Whether instances support a named config profile passed to the CLI
   * (codex --profile). The instance editor hides the profile field otherwise.
   */
  configProfile?: boolean;
  /** Native, extensible per-conversation modes, discovered from the runtime. */
  modeDiscovery?: boolean;
  /** The Nautilo plugin supplies native plugin inventory and item-specific operations. */
  harnessPlugins?: boolean;
  /** Companion package for a harness whose run adapter remains built in. */
  pluginManagerFor?: string;
  /** Static model id suggestions shown before discovery runs. */
  modelSuggestions?: string[];
  /**
   * Whether run launch should discover the active model's context window via
   * listModels (kimi/claude behavior; discovery can be slow for others).
   */
  contextWindowDiscovery?: boolean;
}

/** agenthub-plugin.json — the package manifest of a provider plugin. */
export interface ProviderPluginManifest {
  /** Unique plugin id; also the providerId registered by the adapter. */
  id: string;
  /** Must equal PROVIDER_API_VERSION supported by the host. */
  apiVersion: number;
  /** Entry module relative to the plugin root (ESM, default-exports the factory). */
  main: string;
  /** Plugin version; used by the marketplace to detect updates. */
  version?: string;
  descriptor: ProviderDescriptor;
  minAppVersion?: string;
}

/** One entry of the plugin marketplace registry (registry.json). */
export interface ProviderRegistryEntry {
  id: string;
  name: string;
  version: string;
  vendor: string;
  description: LocalizedText;
  /** URL of the .tgz plugin package. */
  tarball: string;
  /** Expected sha256 of the tarball (hex, lowercase); verified before install. */
  sha256?: string;
  /** Native packages keyed by Node platform and architecture, e.g. darwin-arm64. */
  platforms?: Record<string, { tarball: string; sha256: string }>;
  minAppVersion?: string;
}

/** Context passed to a plugin's adapter factory. */
export interface ProviderPluginContext {
  sdkVersion: string;
}

/** Entry signature of a provider plugin's main module (default export). */
export type ProviderPluginFactory = (context: ProviderPluginContext) => import("./types.js").AgentCliAdapter;
