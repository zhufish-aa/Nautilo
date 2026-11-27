import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { TaskBrowser } from "../../src/main/task-browser";

void app.whenReady().then(async () => {
  const browser = new TaskBrowser();
  const key = "browser-branch-fixture-key";
  const port = await browser.start(() => key);
  browser.attachWindow(new BrowserWindow({ show: false }));
  const file = join(app.getPath("userData"), "form.html");
  await writeFile(file, `<!doctype html><title>Dynamic form</title>
    <button id="reveal" onclick="setTimeout(() => document.querySelector('#form').hidden = false, 100)">Reveal</button>
    <form id="form" hidden onsubmit="event.preventDefault(); document.querySelector('#result').textContent = document.querySelector('#value').value">
      <input id="value"><button id="submit">Submit</button>
    </form><output id="result"></output>
    <button id="popup" onclick="setTimeout(() => window.open('?opened=1'), 120)">Open result</button>`);
  const id = "branch-test";
  const token = createHmac("sha256", key).update(`nautilo-browser-v1/${port}/${id}`).digest("base64url");
  let requestId = 0;
  const call = async (name: string, args: object) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/${id}`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call",
        params: { name, arguments: { ...args, contract_version: 2 } } }),
    });
    assert.equal(response.ok, true);
    const reply = await response.json();
    assert.ok(reply.result?.structuredContent, JSON.stringify(reply));
    return reply.result.structuredContent;
  };
  const { tab_id: tabId } = await call("browser_tabs", { action: "new", url: pathToFileURL(file).href });
  const run = (steps: object[]) => call("browser_run", { tabId, steps, snapshot: false });
  const outcome = { id: "outcome", action: "wait_any",
    cases: [{ name: "login", url_includes: "/login" }, { name: "form", selector: "#value" }] };
  const submit = { action: "click", selector: "#submit", observe_ms: 0 };
  const result = await run([
    { action: "click", selector: "#reveal", observe_ms: 0 },
    outcome,
    { action: "fill", selector: "#value", text: "wrong", when: { step: "outcome", case: "login" } },
    { action: "fill", selector: "#value", text: "correct", when: { step: "outcome", case: "form" } },
    submit,
    { action: "eval", script: "() => document.querySelector('#result').textContent" },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.steps[1].result.matched, "form");
  assert.equal(result.steps[2].status, "skipped");
  assert.equal(result.steps[2].dispatched, undefined);
  assert.equal(result.data.value, "correct");

  const invalid = await run([submit, { ...submit, when: { step: "outcome", case: "form" } }]);
  assert.equal(invalid.error.code, "INVALID_FIELD");
  assert.deepEqual(invalid.steps, []);

  const timeout = await run([{ ...outcome, timeout_ms: 200, cases: [
    { name: "missing", selector: "#missing" }, { name: "login", url_includes: "/login" },
  ] }, submit]);
  assert.equal(timeout.error.code, "ASSERT_FAILED");
  assert.deepEqual(timeout.remaining_steps, [2]);

  const priority = await run([{ ...outcome, cases: [
    { name: "text", selector: "#result", text_includes: "correct" },
    { name: "url", url_includes: "form.html" },
  ] }]);
  assert.equal(priority.steps[0].result.matched, "text");

  const popup = await run([{
    action: "click", selector: "#popup", observe_ms: 0, follow: "new_tab", timeout_ms: 3000,
    expect: { url: { includes: "?opened=1" } },
  }]);
  assert.equal(popup.ok, true, JSON.stringify(popup));
  assert.notEqual(popup.tab_id, tabId);
  assert.equal(popup.data.popups[0].tab_id, popup.tab_id);
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
