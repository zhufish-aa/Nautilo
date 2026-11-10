import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.NAUTILO_JSDOM_PATH ?? "jsdom")); } catch {}

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "The plugin panel did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("native plugin controls follow the selected account and the actions returned by its harness", { skip: !JSDOM }, async () => {
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  const esbuild = createRequire(require.resolve("vite/package.json"))("esbuild");
  const bundle = await esbuild.build({
    stdin: { resolveDir: desktop, loader: "tsx", contents: `
      import {createRoot} from "react-dom/client";
      import {flushSync} from "react-dom";
      import {I18nProvider} from "./src/renderer/src/lib/i18n";
      import {HarnessPluginsPanel} from "./src/renderer/src/features/agents/HarnessPluginsPanel";
      const root = createRoot(document.getElementById("root"));
      window.render = accounts => flushSync(() => root.render(<I18nProvider><HarnessPluginsPanel instanceId="harness-test" accounts={accounts} /></I18nProvider>));
      window.finish = () => flushSync(() => root.unmount());
    ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false,
    define: { "process.env.NODE_ENV": '"test"' }, loader: { ".css": "empty" },
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  const calls = [];
  let enabled = true;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  w.agenthub = { core: { request: async ({ method, input }) => {
    assert.equal(method, "provider.harnessPlugins");
    calls.push(input);
    if (input.operation.action === "disable") {
      enabled = false;
      return { application: "restart-required" };
    }
    assert.equal(input.operation.action, "list");
    return { items: [
      { id: "writable", name: "Editable", installed: true, enabled, actions: [enabled ? "disable" : "enable"] },
      { id: "protected", name: "Protected", installed: true, actions: [] },
      { id: "available", name: "Available extension", installed: false, actions: ["install"] },
    ] };
  } } };
  const button = label => [...w.document.querySelectorAll("button")].find(el => el.textContent === label || el.getAttribute("aria-label") === label);
  try {
    w.eval(bundle.outputFiles[0].text);
    w.render([{ id: "account-a", name: "Account A", revision: 1 }]);
    assert.equal(calls.length, 0, "collapsed managers are lazy");
    button("原生插件").click();
    await until(() => button("停用 Editable"));
    const protectedRow = [...w.document.querySelectorAll("li")].find(el => el.textContent.includes("Protected"));
    assert.equal(protectedRow.querySelector("button"), null);
    button("停用 Editable").click();
    await until(() => button("启用 Editable"));
    assert.match(w.document.querySelector('[role="status"]').textContent, /下次启动/);
    button("可安装").click();
    await until(() => button("安装 Available extension"));
    assert.equal(w.document.querySelector("form"), null, "arbitrary package install requires explicit support");
    assert.deepEqual(calls.map(c => c.operation.action), ["list", "disable", "list"]);
    assert.ok(calls.every(c => c.connectionId === "account-a" && c.agentInstanceId === "harness-test"));
    w.render([]);
    await until(() => w.document.body.textContent.includes("原账号已不可用"));
    assert.equal(button("安装 Available extension"), undefined);
    assert.equal(calls.length, 3, "removing the account must not silently operate on the default CLI profile");
  } finally {
    w.finish?.();
    w.close();
  }
});
