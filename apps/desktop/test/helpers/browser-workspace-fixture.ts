import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskBrowser } from "../../src/main/task-browser";

const profile = process.env.NAUTILO_WORKSPACE_PROFILE!;
for (const name of ["userData", "sessionData", "crashDumps"] as const)
  app.setPath(name, profile);
app.setAppLogsPath(profile);
process.once("uncaughtException", (error) => {
  writeFileSync(
    join(profile, "workspace-error.txt"),
    error.stack ?? String(error),
  );
  app.exit(1);
});
void app
  .whenReady()
  .then(async () => {
    const browser = new TaskBrowser(),
      key = "workspace-fixture";
    const port = await browser.start(() => key);
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true },
    });
    browser.attachWindow(window);
    await window.loadURL("data:text/html,Workspace fixture");
    let id = 0;
    const call = async (
      name: string,
      args: object = {},
      workspace = "saved-chat",
    ) => {
      const token = createHmac("sha256", key)
        .update("nautilo-browser-v1/" + port + "/" + workspace)
        .digest("base64url");
      const response = await fetch(
        "http://127.0.0.1:" + port + "/mcp/" + workspace,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: { controlTimeoutMs: 0, ...args } },
          }),
        },
      );
      return (await response.json()).result;
    };
    const success = async (
      name: string,
      args: object = {},
      workspace = "saved-chat",
    ) => {
      const result = await call(name, args, workspace);
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const metadata = join(profile, "expected-workspaces.json"),
      base = process.env.NAUTILO_WORKSPACE_SITE!;
    const phase = process.env.NAUTILO_WORKSPACE_PHASE;
    if (phase === "write") {
      const first = await success("browser_run", {
        steps: [{ action: "open", url: base + "/a" }],
      });
      const oldRef = first.reads[0].match(/(@[\w.-]+) textbox Query/)?.[1];
      assert.ok(oldRef);
      const second = await success("browser_tabs", {
        action: "new",
        url: base + "/b",
      });
      await success("browser_run", {
        tabId: second.tabId,
        steps: [
          { action: "zoom", factor: 1.25 },
          { action: "scroll_into_view", selector: "#tail" },
        ],
        snapshot: false,
      });
      await success(
        "browser_run",
        { steps: [{ action: "open", url: base + "/other" }] },
        "other-chat",
      );
      writeFileSync(
        metadata,
        JSON.stringify({ first: first.tabId, second: second.tabId, oldRef }),
      );
    } else if (phase === "verify") {
      const expected = JSON.parse(readFileSync(metadata, "utf8"));
      const list = await success("browser_tabs", { action: "list" });
      assert.equal(list.workspaceId, "saved-chat");
      assert.deepEqual(
        list.tabs.map((tab: { id: string }) => tab.id),
        [expected.first, expected.second],
      );
      assert.equal(list.currentTabId, expected.second);
      const state = await success("browser_state", { tabId: expected.second });
      assert.equal(state.url, base + "/b");
      assert.ok(state.viewport.scrollY > 500);
      assert.equal(state.zoomFactor, 1.25);
      const fresh = await success("browser_run", {
        tabId: expected.first,
        steps: [],
      });
      const newRef = fresh.reads[0].match(/(@[\w.-]+) textbox Query/)?.[1];
      assert.ok(newRef);
      assert.notEqual(newRef, expected.oldRef);
      const stale = await call("browser_run", {
        tabId: expected.first,
        steps: [{ action: "fill", ref: expected.oldRef, text: "stale" }],
      });
      assert.equal(stale.structuredContent.error.code, "stale_ref");
    } else if (phase === "delete") browser.release("saved-chat");
    else if (phase === "verify-delete") {
      const list = await success("browser_tabs", { action: "list" });
      assert.equal(list.tabs.length, 1);
      assert.equal(list.tabs[0].url, "about:blank");
      const other = await success("browser_read", {}, "other-chat");
      assert.equal(other.url, base + "/other");
      // Quit can destroy the hidden parking window before the workbench.
      // Keep pages alive on the workbench to exercise cleanup in that order.
      for (const group of browser["groups"].values())
        for (const page of group.tabs.values())
          window.contentView.addChildView(page.view);
      browser["parking"]!.destroy();
      await new Promise<void>((resolve) => {
        window.once("closed", resolve);
        window.close();
      });
    } else throw Error("Unknown workspace fixture phase");
    await browser.close();
    app.exit(0);
  })
  .catch((error) => {
    writeFileSync(
      join(profile, "workspace-error.txt"),
      error.stack ?? String(error),
    );
    app.exit(1);
  });

process.on("uncaughtException",error=>{require("node:fs").writeFileSync(require("node:path").join(__dirname,"workspace-error.txt"),error.stack??String(error));app.exit(1);});
