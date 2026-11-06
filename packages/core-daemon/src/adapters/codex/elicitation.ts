import { randomUUID } from "node:crypto";
import type { AdapterInteractionInput, AdapterResumeRequest, AdapterStartRequest } from "../types.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
type Rpc = { request(method: string, params: unknown): Promise<unknown> };

function link(label: string, value: unknown): { label: string; url: string } {
  const url = new URL(string(value));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("插件未提供有效的 HTTPS 授权地址");
  return { label, url: url.href };
}

/** A native install suggestion is a client action, not a completed installation. */
export async function handleCodexElicitation(
  rpc: Rpc,
  request: Pick<AdapterStartRequest | AdapterResumeRequest, "requestInteraction" | "cwd">,
  params: ObjectValue
): Promise<ObjectValue> {
  const ask = request.requestInteraction;
  if (!ask) throw new Error("当前会话无法显示原生授权请求");
  const meta = object(params._meta);
  const name = string(meta.tool_name) || string(params.serverName) || "MCP";
  const detail = string(params.message);
  const cancelled = { action: "cancel", content: null };
  const confirm = async (input: Omit<AdapterInteractionInput, "kind" | "options">, label: string): Promise<boolean> => {
    const response = await ask({ ...input, kind: "approval", options: [
      { id: "confirm", label, intent: "approve" }, { id: "decline", label: "暂不", intent: "reject" }
    ] });
    return response.outcome === "selected" && response.optionId === "confirm";
  };
  if (params.serverName === "codex_apps" && meta.codex_approval_kind === "tool_suggestion" && meta.suggest_type === "install") {
    const presentation = { type: meta.tool_type === "connector" ? "plugin_authorization" as const : "plugin_install" as const, name, pluginId: string(meta.tool_id) };
    if (meta.tool_type !== "connector" && !await confirm({ title: `安装 ${name}`, detail, presentation }, "安装")) return cancelled;
    const connectorIds = Array.isArray(meta.app_connector_ids) ? meta.app_connector_ids.filter((id): id is string => typeof id === "string") : [];
    let apps: ObjectValue[] = [];
    if (meta.tool_type === "plugin") {
      const reference = string(meta.tool_id);
      const separator = reference.lastIndexOf("@");
      if (separator < 1) throw new Error("Codex 未提供完整的插件来源");
      let pluginName = reference.slice(0, separator);
      const marketplace = reference.slice(separator + 1);
      let source: ObjectValue = { remoteMarketplaceName: marketplace };
      if (!marketplace.endsWith("-remote")) {
        const catalog = object(await rpc.request("plugin/list", { cwds: [request.cwd] }));
        const local = (Array.isArray(catalog.marketplaces) ? catalog.marketplaces : []).map(object).find((entry) => entry.name === marketplace && typeof entry.path === "string");
        if (local) source = { marketplacePath: local.path };
      }
      if (!source.marketplacePath) {
        let remoteId = string(meta.remote_plugin_id);
        if (!remoteId) {
          const detail = object(await rpc.request("plugin/read", { remoteMarketplaceName: marketplace, pluginName }));
          remoteId = string(object(object(detail.plugin).summary).remotePluginId);
        }
        if (!remoteId) throw new Error("插件目录未返回远端安装标识，请刷新目录后重试");
        pluginName = remoteId;
      }
      const installed = object(await rpc.request("plugin/install", { ...source, pluginName, installAttemptId: randomUUID() }));
      apps = (Array.isArray(installed.appsNeedingAuth) ? installed.appsNeedingAuth : []).map(object);
    } else if (meta.tool_type === "connector") {
      connectorIds.push(string(meta.tool_id));
      apps = [{ id: meta.tool_id, name, installUrl: meta.install_url }];
    } else throw new Error("Codex 返回了未知的插件安装类型");
    const expected = [...new Set([...connectorIds, ...apps.map((app) => string(app.id))].filter(Boolean))];
    const links = apps.map((app) => link(`连接 ${string(app.name) || name}`, app.installUrl));
    let checked = false;
    while (expected.length) {
      const snapshot = object(await rpc.request("app/installed", { threadId: params.threadId, forceRefresh: true }));
      const installedApps = (Array.isArray(snapshot.apps) ? snapshot.apps : []).map(object);
      if (expected.every((id) => installedApps.some((app) => app.id === id && app.enabled === true && app.callable === true))) break;
      if (!await confirm({ title: `连接 ${name}`, detail: checked ? "尚未检测到当前账号的连接，请完成授权后重试。" : detail, links, presentation: { ...presentation, type: "plugin_authorization" } }, "检查连接")) return cancelled;
      checked = true;
    }
    return { action: "accept", content: {} };
  }
  if (params.mode === "url") {
    return await confirm({ title: `${name} 授权`, detail, links: [link("打开授权页面", params.url)] }, "已完成授权")
      ? { action: "accept", content: {} } : cancelled;
  }
  if (!params.mode || ["form", "openai/form", "openaiForm"].includes(string(params.mode))) {
    const schema = object(params.requestedSchema);
    const properties = object(schema.properties);
    const fields = Object.entries(properties);
    if (!fields.length) return await confirm({ title: name, detail }, "允许") ? { action: "accept", content: {} } : cancelled;
    const response = await ask({ kind: "question", title: name, questions: fields.map(([id, value]) => {
      const field = object(value);
      const values = field.type === "boolean" ? ["true", "false"] : Array.isArray(field.enum) ? field.enum.map(String) : [];
      return { id, question: string(field.title) || string(field.description) || id, options: values.map((value) => ({ id: value, label: value })) };
    }) });
    if (response.outcome === "cancelled") return cancelled;
    const content: ObjectValue = {};
    for (const [id, value] of fields) {
      const field = object(value);
      const answer = response.answers?.[id]?.[0];
      if (answer === undefined) { if (Array.isArray(schema.required) && schema.required.includes(id)) throw new Error(`缺少授权信息：${id}`); continue; }
      if (field.type === "boolean") {
        if (!["true", "false"].includes(answer)) throw new Error(`无效的布尔值：${id}`);
        content[id] = answer === "true";
      } else if (field.type === "number" || field.type === "integer") {
        const number = Number(answer);
        if (!answer.trim() || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new Error(`无效的数值：${id}`);
        content[id] = number;
      } else if (!field.type || field.type === "string") content[id] = answer;
      else throw new Error(`暂无法填写此授权字段类型：${field.type}`);
    }
    return { action: "accept", content };
  }
  throw new Error(`当前 Codex 请求需要专用验证：${params.mode}`);
}
