import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workspace } from "./rust-build.mjs";

const version = JSON.parse(readFileSync(join(workspace, "apps/desktop/package.json"), "utf8")).version;
const releaseFlag = process.argv.indexOf("--release-dir");
const release = releaseFlag < 0 ? join(workspace, "release") : resolve(process.argv[releaseFlag + 1]);
const scratch = mkdtempSync(join(tmpdir(), "nautilo-packaged-smoke-"));
const fromCheckout = relative(workspace, scratch);
assert(fromCheckout.startsWith("..") || isAbsolute(fromCheckout), "Smoke app must run outside the checkout");
const appRoot = join(scratch, "app");
mkdirSync(appRoot);
let child, socket, fixture, fixtureSockets, logs = "", exited = false;
const requests = new Map();
let nextId = 0;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

async function connectDebugger(url) {
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Packaged renderer debugger did not connect")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Packaged renderer debugger failed")); }, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Packaged smoke timeout: ${method}`)); }, 10000);
    requests.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  let executable;
  if (process.platform === "win32") {
    const archive = join(release, `Nautilo-${version}-win-${process.arch}.zip`);
    assert(existsSync(archive), `Windows portable ZIP missing: ${archive}`);
    run("tar", ["-xf", basename(archive), "-C", appRoot], dirname(archive));
    executable = join(appRoot, "Nautilo.exe");
  } else if (process.platform === "darwin") {
    const archive = join(release, `Nautilo-${version}-mac-${process.arch}.zip`);
    assert(existsSync(archive), `macOS application ZIP missing: ${archive}`);
    run("ditto", ["-x", "-k", archive, appRoot]);
    executable = join(appRoot, "Nautilo.app", "Contents", "MacOS", "Nautilo");
  } else {
    cpSync(join(release, "linux-unpacked"), appRoot, { recursive: true, dereference: false });
    executable = join(appRoot, "Nautilo");
    // Ubuntu CI restricts unprivileged user namespaces. Restore the helper's
    // installation permissions on this isolated copy instead of disabling
    // Chromium's sandbox for the application or the startup probe.
    if (process.env.CI) {
      const helper = join(appRoot, "chrome-sandbox");
      run("sudo", ["chown", "root:root", helper]);
      run("sudo", ["chmod", "4755", helper]);
    }
  }
  assert(existsSync(executable), `Packaged executable missing: ${executable}`);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, NAUTILO_USER_DATA_DIR: join(scratch, "user-data") };
  for (const name of ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "AGENTHUB_CORE_PATH", "AGENTHUB_DEV_PLUGIN_DIR", "AGENTHUB_DATA_DIR", "AGENTHUB_SOCKET", "AGENTHUB_TOKEN_PATH", "NAUTILO_BROWSER_PORT"]) delete env[name];
  child = spawn(executable, [`--remote-debugging-port=${port}`, "--disable-gpu", "--no-first-run"], {
    cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32"
  });
  const capture = chunk => { logs = (logs + chunk.toString()).slice(-30000); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  child.once("error", error => { logs += error.message; exited = true; });
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + 60000;
  let target;
  while (Date.now() < deadline) {
    if (exited || /Cannot find module|App threw an error during load|Uncaught Exception|Core Daemon exited|Core Daemon did not become ready/.test(logs)) throw new Error(`Packaged application failed during startup\n${logs.slice(-6000)}`);
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => []);
    target = tabs.find(tab => tab.type === "page" && tab.url?.includes("/out/renderer/index.html"));
    if (target) break;
    await delay(250);
  }
  assert(target, `Packaged workbench did not load\n${logs.slice(-6000)}`);
  await connectDebugger(target.webSocketDebuggerUrl);
  let result;
  while (Date.now() < deadline) {
    const response = await request("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
      if (!window.agenthub?.getAppInfo || !document.querySelector('#root')?.children.length) return null;
      const app = await window.agenthub.getAppInfo();
      const projects = await window.agenthub.core.request({method:'project.list'});
      const text = document.body.innerText;
      if (!text.trim() || text.includes('界面渲染出错')) throw new Error('Packaged renderer failed');
      return {app, rustReady:Array.isArray(projects), rendered:true};
    })()` });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    result = response.result?.value;
    if (result) break;
    await delay(250);
  }
  assert(result?.rendered && result.rustReady, "Packaged renderer/preload/Rust IPC did not become ready");
  assert.equal(result.app.version, version);
  assert.equal(result.app.platform, process.platform);
  assert.equal(result.app.arch, process.arch);
  // Exercise the packaged main process's ws client, including frames large
  // enough to reach optional native acceleration. The fixture has no accounts
  // or cookies; the app still runs outside the checkout with a fresh profile.
  const { WebSocketServer } = createRequire(new URL("../apps/desktop/package.json", import.meta.url))("ws");
  const origin = "https://packaged-smoke.invalid";
  let transportRequests = 0;
  fixture = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{ id: "smoke", type: "page", title: "Smoke fixture", url: origin + "/", webSocketDebuggerUrl: `ws://127.0.0.1:${fixture.address().port}/devtools/page/smoke` }]));
  });
  fixtureSockets = new WebSocketServer({ server: fixture });
  fixtureSockets.on("connection", client => client.on("message", data => {
    const message = JSON.parse(String(data));
    assert.equal(message.method, "Network.getCookies");
    assert.deepEqual(message.params.urls, [origin]);
    assert(data.length > 48, "Probe must exercise large masked WebSocket frames");
    transportRequests++;
    client.send(JSON.stringify({ id: message.id, result: { cookies: [], padding: "x".repeat(256) } }));
  }));
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
  const profileInput = { endpoint: `http://127.0.0.1:${fixture.address().port}`, origins: [origin] };
  const transport = await request("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `window.agenthub.browser.profile('import', ${JSON.stringify(profileInput)})` });
  if (transport.exceptionDetails) throw new Error(JSON.stringify(transport.exceptionDetails));
  assert.equal(transport.result?.value?.ok, true, "Packaged WebSocket transport failed");
  assert.equal(transport.result.value.imported_cookies, 0);
  assert.equal(transportRequests, 1);
  console.log(JSON.stringify({ packagedSmoke: "passed", platform: process.platform, arch: process.arch, version, isolated: true, rustReady: true, rendered: true, webSocketReady: true }));
  await request("Runtime.evaluate", { expression: "window.agenthub.window.close()" }).catch(() => {});
} finally {
  if (fixtureSockets) {
    for (const client of fixtureSockets.clients) client.terminate();
    fixtureSockets.close();
  }
  if (fixture) await new Promise(resolve => fixture.close(resolve));
  socket?.close();
  for (const pending of requests.values()) clearTimeout(pending.timer);
  if (child?.pid && !exited) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    await delay(750);
  }
  const relativeScratch = relative(tmpdir(), resolve(scratch));
  if (relativeScratch && !relativeScratch.startsWith("..") && !isAbsolute(relativeScratch)) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
