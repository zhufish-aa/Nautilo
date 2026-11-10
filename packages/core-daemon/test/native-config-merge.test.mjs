import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareKimiConnection } from "../dist/adapters/kimi/connection.js";
import { buildOpenCodeEnvironment } from "../../provider-plugin-opencode/dist/index.js";
import { buildOpenSourceConfiguration } from "../../provider-plugin-trae/dist/index.js";
import { piRunArgs } from "../../provider-plugin-pi/dist/index.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nautilo-native-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const model = { id: "custom/model", enabled: true, reasoningEfforts: ["low", "max"] };
const instance = { providerId: "kimi-code", baseArgs: [], models: [model], providerOptions: {
  runtimeConnectionId: "test", apiType: "openai-responses", baseUrl: "https://selected.example/v1"
} };

test("Kimi preserves native MCP options, preferences and skill resources while binding the selected API", t => {
  const root = fixture(t), native = join(root, "native");
  mkdirSync(join(native, "skills", "native", "scripts"), { recursive: true });
  writeFileSync(join(native, "config.toml"), "[hooks]\nenabled=true\n[providers.old]\napi_key='old-secret'\n");
  const mcp = JSON.stringify({ custom: true, mcpServers: { existing: { command: "native" }, shared: { command: "old", timeout: 123, deferred: true } } });
  writeFileSync(join(native, "mcp.json"), mcp);
  writeFileSync(join(native, "skills/native/SKILL.md"), "# Native");
  writeFileSync(join(native, "skills/native/scripts/run.py"), "print(1)");
  const request = { instance, env: { KIMI_CODE_HOME: native, NAUTILO_CONNECTION_DIRECTORY: join(root,"bound") },
    mcpServers: [{ name: "shared", transport: "http", url: "https://mcp.example" }, { name: "added", transport: "stdio", command: "added" }] };
  const env = prepareKimiConnection(request);
  const config = readFileSync(join(env.KIMI_CODE_HOME, "config.toml"), "utf8");
  assert.match(config, /\[hooks\]/); assert.match(config, /selected.example/); assert.doesNotMatch(config,/old-secret/);
  const merged = JSON.parse(readFileSync(join(env.KIMI_CODE_HOME,"mcp.json"),"utf8"));
  assert.equal(merged.mcpServers.existing.command,"native");
  assert.equal(merged.mcpServers.shared.timeout,123); assert.equal(merged.mcpServers.shared.deferred,true);
  assert.equal(merged.mcpServers.shared.command,undefined);
  assert.equal(readFileSync(join(native,"mcp.json"),"utf8"),mcp);
  assert.equal(readFileSync(join(env.KIMI_CODE_HOME,"skills/native/scripts/run.py"),"utf8"),"print(1)");
  unlinkSync(join(native,"skills/native/scripts/run.py"));
  prepareKimiConnection({...request,mcpServers:[]});
  assert.equal(existsSync(join(env.KIMI_CODE_HOME,"skills/native/scripts/run.py")),false);
  assert.deepEqual(JSON.parse(readFileSync(join(env.KIMI_CODE_HOME,"mcp.json"),"utf8")),JSON.parse(mcp));
});

test("OpenCode adds run MCP and provider configuration without discarding plugins or native entries", () => {
  const original = { plugin: ["native-plugin"], mcp: { native: { type:"local",command:["native"] }, shared: { type:"remote",url:"https://old.example",timeout:123 } } };
  const request = {instance,env:{OPENCODE_CONFIG_CONTENT:JSON.stringify(original)},mcpServers:[{name:"shared",transport:"http",url:"https://new.example"}]};
  const env = buildOpenCodeEnvironment(request);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.plugin,["native-plugin"]); assert.equal(config.mcp.native.command[0],"native");
  assert.equal(config.mcp.shared.timeout,123); assert.equal(config.mcp.shared.url,"https://new.example");
  assert.equal(config.provider.nautilo.options.baseURL,"https://selected.example/v1");
  assert.deepEqual(JSON.parse(request.env.OPENCODE_CONFIG_CONTENT),original);
});

test("Trae reads native YAML tools and MCP before applying the selected connection", t => {
  const cwd = fixture(t);
  const yaml = "agents:\n  trae_agent:\n    model: native\n    max_steps: 47\n    enable_lakeview: false\n    tools: [bash, task_done]\nmodels:\n  native:\n    max_tokens: 777\nmcp_servers:\n  existing:\n    command: native-mcp\nallow_mcp_servers: [existing]\n";
  writeFileSync(join(cwd,"trae_config.yaml"),yaml);
  const config = buildOpenSourceConfiguration({cwd,instance,model:model.id,mcpServers:[{name:"added",transport:"http",url:"https://mcp.example"}]},"https://selected.example");
  assert.deepEqual(config.agents.trae_agent.tools,["bash","task_done"]); assert.equal(config.agents.trae_agent.max_steps,47);
  assert.equal(config.agents.trae_agent.enable_lakeview,false); assert.equal(config.models.selected.max_tokens,777);
  assert.equal(config.mcp_servers.existing.command,"native-mcp"); assert.equal(config.mcp_servers.added.http_url,"https://mcp.example");
  assert.deepEqual(config.allow_mcp_servers,["existing","added"]);
  assert.equal(readFileSync(join(cwd,"trae_config.yaml"),"utf8"),yaml);
});

test("Pi normal turns keep native session persistence, startup and extension discovery", () => {
  const args = piRunArgs({instance:{...instance,providerId:"pi"},model:model.id,reasoningEffort:"max",providerSessionId:"native-id"},true);
  for (const flag of ["--offline","--no-session","--no-extensions","--no-skills"]) assert.equal(args.includes(flag),false);
  assert.equal(args[args.indexOf("--session")+1],"native-id");
  assert.equal(args[args.indexOf("--thinking")+1],"max");
});
