import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, modules = {}) {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  vm.runInNewContext(code, { exports, URL, require: (name) => modules[name] ?? require(name) });
  return exports;
}
const helpers = load("../src/renderer/src/features/settings/remote/remote-network-settings.ts");
const base = { enabled: true, deviceName: "Computer", relayMode: "direct", relayUrls: [], keepAwake: true };

test("relay feedback distinguishes initial connect, reconnect, timeout and recovery", () => {
  const initial = { ready:false, seenReady:false, elapsedMs:0, errors:[] };
  assert.equal(helpers.relayConnectionFeedback(initial, true).label, "正在连接中继");
  assert.equal(helpers.relayConnectionFeedback({ ...initial, seenReady:true }, true).label, "正在恢复中继连接");
  assert.equal(helpers.relayConnectionFeedback({ ...initial, elapsedMs:15000 }, true).retryable, true);
  assert.match(helpers.relayConnectionFeedback({ ...initial, errors:["relay refused"] }, true).detail, /relay refused/);
  assert.equal(helpers.relayConnectionFeedback({ ...initial, ready:true, elapsedMs:60000, errors:["old error"] }, true).detail, "");
});

test("public relay accepts blank addresses; active custom errors do not block automatic mode", () => {
  assert.equal(helpers.relaySettingsError({ ...base, relayMode: "custom" }, true), "");
  const invalid = { ...base, relayUrls: ["unfinished"] };
  assert.match(helpers.relaySettingsError(invalid, true), /HTTPS/);
  for (const relayMode of ["automatic", "lan"]) assert.equal(helpers.relaySettingsError({ ...invalid, relayMode }, true), "");
  assert.equal(JSON.stringify(helpers.normalizeRelayUrls([" \r", " https://node.example.com ", "https://node.example.com"])), '["https://node.example.com"]');
  assert.match(helpers.relaySettingsError({ ...base, relayUrls: Array.from({ length: 5 }, (_, i) => `https://node${i}.example.com`) }, true), /4/);
});

test("switching from direct to public relay saves immediately without entering a server", () => {
  const { RemoteNetworkSettings } = load("../src/renderer/src/features/settings/remote/RemoteNetworkSettings.tsx", {
    "./remote-network-settings": helpers,
    "lucide-react": { ChevronDown: () => null, Globe2: () => null },
    "../../../components/ui/Button": { Button: () => null },
    "../../../components/ui/Switch": { Switch: () => null },
  });
  const saved = [];
  const updated = [];
  const tree = RemoteNetworkSettings({ settings: base, endpointId: "", dirty: false, busy: false, zh: true,
    update: (next) => updated.push(next), save: async (next) => { saved.push(next); } });
  function find(node, type) {
    if (!node || typeof node !== "object") return;
    if (node.type === type) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, type); if (result) return result; }
  }
  find(tree, "select").props.onChange({ target: { value: "custom" } });
  assert.equal(updated[0].relayMode, "custom");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].relayMode, "custom");
  assert.equal(saved[0].relayUrls.length, 0);
});
