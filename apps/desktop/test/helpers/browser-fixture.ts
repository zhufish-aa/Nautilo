import assert from "node:assert/strict";
import { app, BrowserWindow, nativeImage } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { registerPanelWindows } from "../../src/main/panel-windows";
import { TaskBrowser } from "../../src/main/task-browser";
import { browserCommand } from "../../src/main/browser-protocol";

const dir = __dirname;
const checkpoint = (phase: string) =>
  writeFileSync(join(dir, "phase.txt"), phase);
app.setPath("userData", dir);
app.setPath("sessionData", dir);
app.setPath("crashDumps", dir);
app.setAppLogsPath(dir);
void app
  .whenReady()
  .then(async () => {
    const key = "browser-fixture-key",
      browser = new TaskBrowser();
    const port = await browser.start(() => key);
    browser.register();
    const pageContents = (id: string) =>
      browser["groups"].get("A")!.tabs.get(id)!.view.webContents;
    const longJson = JSON.stringify({
      prefix: "JSON_START",
      payload: "0123456789".repeat(14000),
      tail: "JSON_TAIL_MARKER",
    });
    const reviewHtml = `<!doctype html><title>Browser review regression</title>
      <nav>${Array.from({ length: 160 }, (_, i) => '<a href="#nav' + i + '">Navigation ' + i + "</a>").join("")}</nav>
      <main><h1>Review content</h1><span id="login" style="cursor:pointer" onclick="result.textContent='Login opened'">立即登录</span><output id="result"></output>
      <form action="/search-results"><label>Query<input id="query" name="q"></label><button id="search">Search</button></form>
      <button id="detach" onclick="query.remove()">Detach field</button>
      <a id="next" href="/next-page">Next page</a><a id="ctrl-link" href="/opened-background" onclick="event.preventDefault();location.href='/forced-current'">Modified link</a>
      <article id="duplicate">First card</article><article id="duplicate">Second card</article>
      <input id="password-field" type="password" value="fixture-password">
      <section id="board"><h2>Leaderboard</h2><table>${Array.from({ length: 47 }, (_, i) => "<tr><td>Model " + (i + 1) + "</td><td>Score " + i + "</td></tr>").join("")}</table></section>
      <div style="height:120vh"></div><section id="comments"><h2>评论</h2><div id="loading">正在玩命加载…</div></section></main>
      <footer>FOOTER_NOISE ${"FAQ links ".repeat(200)}</footer>
      <script>new IntersectionObserver(([e])=>{if(e.isIntersecting)loading.textContent='Loaded comment one. Loaded reply two.'}).observe(comments)</script>`;
    const duplicatesHtml = `<!doctype html><title>Repeated reply controls</title><span style="display:none">登录</span>
      <div style="height:130vh">Video</div><section id="wait-zone" style="height:220px;overflow:auto">
      <span style="display:none">回复</span><div style="height:500px"></div><button>共 12 条回复</button>
      <div style="height:350px"></div><button>查看回复</button></section>`;
    const site = createServer((req, res) => {
      if (req.url === "/no-frames") {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            '<!doctype html><form action="/search-results"><label>Query<input name="q"></label><button>Search</button></form><div style="height:150vh"></div><h2 id="tail">Tail target</h2><script>window.requestAnimationFrame=()=>0</script>',
          );
        return;
      }
      if (req.url === "/delayed-shell") {
        res
          .writeHead(200, { "Content-Type": "text/html;charset=utf-8" })
          .end(
            '<!doctype html><body><script>setTimeout(()=>{document.body.innerHTML=\'<div style="height:150vh"></div><h2 id="late-comments">评论</h2>\'},250)</script>',
          );
        return;
      }
      if (req.url === "/slow-load") {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end('<!doctype html><img src="/slow-image"><p>Loading fixture</p>');
        return;
      }
      if (req.url === "/slow-image") {
        setTimeout(
          () =>
            res
              .writeHead(200, { "Content-Type": "image/svg+xml" })
              .end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
              ),
          400,
        );
        return;
      }
      if (req.url === "/fixture-login") {
        res
          .writeHead(200, {
            "Content-Type": "text/html",
            "Set-Cookie":
              "fixture-login-cookie=synthetic-login; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
          })
          .end("<p>Fixture login established</p>");
        return;
      }
      if (req.url === "/fixture-account") {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            req.headers.cookie?.includes("fixture-login-cookie=synthetic-login")
              ? "<p>SERVER_AUTHENTICATED</p>"
              : "<p>SERVER_SIGNED_OUT</p>",
          );
        return;
      }
      res
        .writeHead(200, {
          "Content-Type":
            req.url === "/long.json"
              ? "application/json"
              : "text/html;charset=utf-8",
        })
        .end(
          req.url === "/duplicates"
            ? duplicatesHtml
            : req.url === "/review"
              ? reviewHtml
              : req.url === "/long.json"
                ? longJson
                : req.url === "/gestures"
                  ? `<div style="position:fixed;inset:0" onpointerup="out.textContent=event.clientX" ondblclick="out.textContent='double'"><output id=out></output></div>`
                  : req.url?.startsWith("/comments")
                    ? `<title>Comments</title>
            <p>Sign in for more comments</p><div style="height:120vh"></div><div id="thread" style="min-height:90vh"></div>
            <script>new IntersectionObserver(([entry])=>{if(entry.isIntersecting && !thread.shadowRoot){
              const nested = document.createElement('section');
              thread.attachShadow({mode:'open'}).append(nested);
              nested.attachShadow({mode:'open'}).innerHTML='<p>First visible comment</p><p>Second visible comment</p><iframe src="/frame"></iframe>';
            }}).observe(thread)</script>`
                    : req.url === "/frame"
                      ? "<p>Embedded reply</p>"
                      : '<form onsubmit="event.preventDefault();out.textContent=q.value"><label>Query<input id="q"></label><button>Search</button><output id="out"></output></form><a target="_blank" href="/comments">Discuss</a><label>Color<select><option>Red</option><option>Blue</option></select></label>',
        );
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const addr = site.address();
    assert.ok(addr && typeof addr !== "string");
    const url = "http://127.0.0.1:" + addr.port;
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, preload: join(dir, "preload.cjs") },
    });
    browser.attachWindow(win);
    let detached: BrowserWindow;
    registerPanelWindows(
      () => win,
      (target) => {
        detached = new BrowserWindow({
          show: false,
          focusable: false,
          skipTaskbar: true,
          opacity: 0,
          webPreferences: { sandbox: true, preload: join(dir, "preload.cjs") },
        });
        if (target.kind === "browser")
          browser.attachPanelWindow(target.sessionId!, detached);
        return detached;
      },
      (child) => child.loadURL("data:text/html,Panel"),
    );

    await win.loadURL("data:text/html,<input id=draft>");
    const panel = (id: string, cmd: string, value?: unknown) =>
      win.webContents.executeJavaScript(
        "window.panel(" +
          [id, cmd, value ?? null].map((v) => JSON.stringify(v)).join(",") +
          ")",
      );
    let requestId = 0;
    function rpc(
      id: string,
      method: string,
      params: unknown,
      credentialId = id,
    ) {
      const token = createHmac("sha256", key)
        .update("nautilo-browser-v1/" + port + "/" + credentialId)
        .digest("base64url");
      return fetch("http://127.0.0.1:" + port + "/mcp/" + id, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++requestId,
          method,
          params,
        }),
      });
    }
    const call = async (id: string, args: unknown, name = "browser_run") =>
      (
        await (
          await rpc(id, "tools/call", {
            name,
            arguments: { controlTimeoutMs: 0, ...(args as object) },
          })
        ).json()
      ).result;
    const run = async (id: string, steps: unknown[], snapshot = false) => {
      const result = await call(id, { steps, snapshot });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    assert.equal((await rpc("A", "tools/list", {}, "B")).status, 401);
    assert.equal(
      (
        await (
          await rpc("A", "initialize", { protocolVersion: "2025-06-18" })
        ).json()
      ).result.protocolVersion,
      "2025-06-18",
    );
    assert.equal(
      (await (await rpc("A", "tools/list", {})).json()).result.tools.length,
      7,
    );
    await win.webContents.executeJavaScript(
      "draft.focus();draft.value='my draft'",
    );
    const navigate = { action: "open", url };
    const filter = (value: string) => [
      { action: "fill", role: "textbox", name: "Query", text: value },
      { action: "click", role: "button", name: "Search" },
      { action: "wait", text: value },
      { action: "read", text: value },
    ];
    checkpoint("initial snapshot");
    const snapshot = await run("A", [navigate], true);
    const ref = snapshot.reads[0].match(/(@[\w.-]+) textbox Query/)?.[1];
    assert.ok(ref);
    await run("A", [{ action: "fill", ref, text: "old doc" }]);
    await run("A", [navigate]);
    assert.ok(
      (await call("A", { steps: [{ action: "fill", ref, text: "stale" }] }))
        .isError,
    );
    const [a, b] = await Promise.all([
      run("A", filter("session-A")),
      run("B", [navigate, ...filter("session-B")]),
    ]);
    assert.match(a.reads[0], /session-A/);
    assert.match(b.reads[0], /session-B/);
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.activeElement.id+'/'+draft.value",
      ),
      "draft/my draft",
    );
    const img = (await call("A", {}, "browser_screenshot")).content[0];
    assert.equal(img.type, "image", img.text);
    assert.ok(img.data.length > 1000);
    const state = await panel("A", "state");
    assert.equal(state.tabs.length, 1);
    const first = state.tabId;
    const tabs = async (args: object) => {
      const result = await call("A", args, "browser_tabs");
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const read = async (args = {}) => {
      const result = await call(
        "A",
        { tabId: "viewed", ...args },
        "browser_read",
      );
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const at = async (tabId: string, steps: unknown[], snapshot = false) => {
      const result = await call("A", { tabId, steps, snapshot });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    checkpoint("review regressions");
    const reviewed = JSON.parse(
      (await call("A", { action: "new", url: url + "/review" }, "browser_tabs"))
        .content[0].text,
    ).tabId;
    const currentRead = JSON.parse(
      (await call("A", {}, "browser_read")).content[0].text,
    );
    assert.equal(currentRead.tabId, reviewed);
    assert.equal(
      (await read({ tabId: reviewed, scope: "main" })).text.includes(
        "Navigation 1",
      ),
      false,
    );
    const board = await read({
      tabId: reviewed,
      scope: "document",
      selector: "#board",
    });
    assert.match(board.text, /Model 47/);
    assert.doesNotMatch(board.text, /FOOTER_NOISE/);
    assert.equal(
      (
        await read({
          tabId: reviewed,
          selector: "#board",
          scope: "document",
          offset: 999999,
        })
      ).outOfRange,
      true,
    );
    const stateTool = async (args: object) =>
      JSON.parse(
        (await call("A", { tabId: reviewed, ...args }, "browser_state"))
          .content[0].text,
      );
    assert.ok(
      (await stateTool({})).regions.some(
        (r: { selector: string }) => r.selector === "#comments",
      ),
    );
    const reviewWc = pageContents(reviewed);
    checkpoint("blocked animation frames");
    const framesTab = (await tabs({ action: "new", url: url + "/review" }))
      .tabId;
    const framesSnapshot = await at(framesTab, [], true);
    const framesRef = framesSnapshot.reads[0].match(
      /(@[\w.-]+) textbox Query/,
    )?.[1];
    assert.ok(framesRef);
    const staleStarted = performance.now();
    const frameFailure = await call("A", {
      tabId: framesTab,
      steps: [
        { action: "open", url: url + "/no-frames" },
        { action: "click", ref: framesRef },
        { action: "open", url: url + "/must-not-run" },
      ],
    });
    assert.equal(frameFailure.structuredContent.error.code, "stale_ref");
    assert.ok(performance.now() - staleStarted < 2500);
    assert.deepEqual(frameFailure.structuredContent.executedSteps, [1]);
    assert.deepEqual(frameFailure.structuredContent.remainingSteps, [3]);
    await at(framesTab, [
      { action: "fill", role: "textbox", name: "Query", text: "bilibili" },
      { action: "press", key: "Enter" },
      { action: "wait", urlIncludes: "/search-results?q=bilibili" },
    ]);
    await at(framesTab, [
      { action: "open", url: url + "/no-frames" },
      { action: "scroll_into_view", selector: "#tail" },
    ]);
    const beforeReset = await at(framesTab, [], true);
    const resetRef = beforeReset.reads[0].match(
      /(@[\w.-]+) textbox Query/,
    )?.[1];
    assert.ok(resetRef);
    const framesWc = pageContents(framesTab);
    checkpoint("pending CDP recovery");
    await assert.rejects(
      browserCommand(
        framesWc,
        "Runtime.evaluate",
        {
          expression: "new Promise(()=>{})",
          awaitPromise: true,
        },
        200,
      ),
      (error: any) =>
        error.code === "browser_operation_timeout" &&
        error.details.cdpReset === true,
    );
    const resetStale = await call("A", {
      tabId: framesTab,
      steps: [{ action: "fill", ref: resetRef, text: "old connection" }],
    });
    assert.equal(resetStale.structuredContent.error.code, "stale_ref");
    await at(framesTab, [
      { action: "fill", role: "textbox", name: "Query", text: "recovered" },
      { action: "press", key: "Enter" },
      { action: "wait", urlIncludes: "/search-results?q=recovered" },
    ]);
    const resetShot = await call(
      "A",
      { tabId: framesTab },
      "browser_screenshot",
    );
    assert.ok(!resetShot.isError, resetShot.content[0].text);
    assert.equal(resetShot.content[0].type, "image");
    const replacementTab = (
      await tabs({ action: "new", url: url + "/no-frames" })
    ).tabId;
    await at(replacementTab, [
      { action: "fill", role: "textbox", name: "Query", text: "new tab works" },
    ]);
    assert.equal(
      (
        await read({
          tabId: replacementTab,
          selector: "input",
          scope: "document",
        })
      ).fields[0].value,
      "new tab works",
    );
    const replacementWc = pageContents(replacementTab);
    const replacementProtocol = replacementWc.debugger.sendCommand.bind(
      replacementWc.debugger,
    );
    let replaceTarget = true;
    replacementWc.debugger.sendCommand = async (method, params, sessionId) => {
      if (method === "DOM.scrollIntoViewIfNeeded" && replaceTarget) {
        replaceTarget = false;
        await replacementProtocol("Runtime.evaluate", {
          expression: "tail.replaceWith(tail.cloneNode(true))",
        });
        throw Error("Node is detached from document");
      }
      return replacementProtocol(method, params, sessionId);
    };
    try {
      const repositioned = await at(replacementTab, [
        { action: "scroll_to_text", text: "Tail target" },
      ]);
      assert.equal(repositioned.steps[0].result.targetRetries, 1);
    } finally {
      replacementWc.debugger.sendCommand = replacementProtocol;
    }
    await tabs({ action: "close", tabId: replacementTab });
    await tabs({ action: "close", tabId: framesTab });
    await tabs({ action: "select", tabId: reviewed });
    const regionList = (await stateTool({})).regions;
    assert.equal(
      new Set(regionList.map((region: { selector: string }) => region.selector))
        .size,
      regionList.length,
    );
    for (const region of regionList)
      if (region.unique)
        assert.equal(
          await reviewWc.executeJavaScript(
            "document.querySelectorAll(" +
              JSON.stringify(region.selector) +
              ").length",
          ),
          1,
        );
    await at(reviewed, [
      { action: "fill", selector: "#query", text: "readable value" },
    ]);
    assert.equal(
      (await read({ tabId: reviewed, selector: "#query" })).fields[0].value,
      "readable value",
    );
    const valueSnapshot = await at(reviewed, [], true);
    assert.ok(valueSnapshot.reads[0].includes('value="readable value"'));
    assert.ok(!JSON.stringify(valueSnapshot).includes("fixture-password"));
    const password = await read({
      tabId: reviewed,
      selector: "#password-field",
      scope: "document",
    });
    assert.equal(password.fields[0].redacted, true);
    assert.ok(!JSON.stringify(password).includes("fixture-password"));
    const modified = await at(reviewed, [
      { action: "click", selector: "#ctrl-link", modifiers: ["Control"] },
    ]);
    const openedTab = modified.steps[0].result.openedTabId;
    assert.ok(openedTab);
    assert.equal(reviewWc.getURL(), url + "/review");
    const modifiedTabs = await tabs({ action: "list" });
    assert.equal(modifiedTabs.currentTabId, reviewed);
    assert.equal(
      modifiedTabs.tabs.find((tab: { id: string }) => tab.id === openedTab).url,
      url + "/opened-background",
    );
    await panel("A", "close", { tabId: openedTab });
    const invalid = await call("A", {
      tabId: reviewed,
      steps: [
        { action: "click", selector: "#login" },
        { action: "unknown-action" },
      ],
    });
    assert.deepEqual(invalid.structuredContent.executedSteps, []);
    assert.equal(invalid.structuredContent.failedStep, 2);
    assert.deepEqual(invalid.structuredContent.remainingSteps, [1]);
    const protocol = reviewWc.debugger.sendCommand.bind(reviewWc.debugger);
    reviewWc.debugger.sendCommand = async (method, params, sessionId) => {
      if (
        method === "Input.dispatchMouseEvent" &&
        ["mousePressed", "mouseReleased"].includes(params?.type)
      )
        return {};
      return protocol(method, params, sessionId);
    };
    let dropped;
    try {
      dropped = await call("A", {
        tabId: reviewed,
        steps: [{ action: "click", selector: "#login" }],
      });
    } finally {
      reviewWc.debugger.sendCommand = protocol;
    }
    assert.equal(dropped.structuredContent.error.code, "input_not_delivered");
    assert.deepEqual(dropped.structuredContent.executedSteps, []);
    await at(reviewed, [{ action: "open", url: url + "/duplicates" }]);
    const hidden = await call("A", {
      tabId: reviewed,
      steps: [{ action: "click", text: "登录" }],
    });
    assert.equal(hidden.structuredContent.error.matches, 0);
    assert.equal(hidden.structuredContent.error.hiddenMatches, 1);
    const present = await at(reviewed, [
      { action: "wait", text: "回复", timeoutMs: 100 },
      { action: "wait", text: "回复", visible: false, timeoutMs: 100 },
      { action: "wait", selector: "#wait-zone", text: "回复", timeoutMs: 100 },
    ]);
    assert.equal(present.steps[0].result.visible, false);
    assert.equal(await reviewWc.executeJavaScript("scrollY"), 0);
    const offscreen = await call("A", {
      tabId: reviewed,
      steps: [
        {
          action: "wait",
          selector: "#wait-zone",
          text: "回复",
          visible: true,
          timeoutMs: 100,
        },
      ],
    });
    assert.equal(offscreen.structuredContent.error.code, "wait_timeout");
    const positioned = await at(reviewed, [
      {
        action: "wait",
        selector: "#wait-zone",
        text: "回复",
        visible: true,
        alsoTryScroll: true,
        timeoutMs: 1800,
      },
    ]);
    assert.ok(positioned.steps[0].result.scrollAttempts > 0);
    assert.ok(positioned.steps[0].result.scrollAttempts <= 2);
    assert.match(
      (await read({ tabId: reviewed, selector: "#wait-zone" })).text,
      /回复/,
    );
    checkpoint("delayed navigation targets");
    const late = await at(reviewed, [
      { action: "open", url: url + "/delayed-shell" },
      { action: "scroll_to_text", text: "评论", timeoutMs: 2500 },
    ]);
    assert.equal(late.steps[0].result.waitUntil, "domcontentloaded");
    assert.ok(late.steps[1].result.scrollY > 0);
    const loaded = await at(reviewed, [
      { action: "open", url: url + "/slow-load", waitUntil: "load" },
    ]);
    assert.equal(loaded.steps[0].result.readyState, "complete");
    const detachedSnapshot = await at(
      reviewed,
      [{ action: "open", url: url + "/review" }],
      true,
    );
    const detachedRef = detachedSnapshot.reads[0].match(
      /(@[\w.-]+) textbox Query/,
    )?.[1];
    assert.ok(detachedRef);
    const detachedResult = await call("A", {
      tabId: reviewed,
      steps: [
        { action: "click", selector: "#detach" },
        { action: "fill", ref: detachedRef, text: "detached" },
        { action: "open", url: url + "/must-not-run" },
      ],
    });
    assert.equal(detachedResult.structuredContent.error.code, "stale_ref");
    assert.deepEqual(detachedResult.structuredContent.executedSteps, [1]);
    assert.deepEqual(detachedResult.structuredContent.remainingSteps, [3]);
    assert.equal(detachedResult.structuredContent.error.ref, detachedRef);
    assert.ok(detachedResult.structuredContent.snapshot);
    assert.equal(reviewWc.getURL(), url + "/review");
    await at(reviewed, [{ action: "open", url: url + "/review" }]);
    await at(reviewed, [
      { action: "click", text: "立即登录" },
      { action: "wait", text: "Login opened" },
    ]);
    const loadingRead = await read({
      tabId: reviewed,
      scope: "document",
      selector: "#comments",
    });
    assert.ok(loadingRead.loadingHints.length > 0);
    const scroll = await call(
      "A",
      { tabId: reviewed, selector: "#comments" },
      "browser_scroll",
    );
    assert.ok(!scroll.isError, scroll.content[0].text);
    await at(reviewed, [
      { action: "wait", text: "Loaded comment one", selector: "#comments" },
      { action: "read", scope: "document", selector: "#comments" },
    ]);
    const timeout = await call("A", {
      tabId: reviewed,
      steps: [{ action: "wait", text: "Never present", timeoutMs: 100 }],
    });
    assert.equal(timeout.isError, true);
    assert.equal(timeout.structuredContent.error.code, "wait_timeout");
    assert.ok(timeout.structuredContent.error.recovery.includes("Scroll"));
    await at(reviewed, [
      { action: "fill", selector: "#query", text: "clicked" },
      { action: "click", selector: "#search" },
      { action: "wait", urlIncludes: "/search-results?q=clicked" },
    ]);
    await at(reviewed, [
      { action: "open", url: url + "/review" },
      { action: "fill", selector: "#query", text: "bilibili" },
      { action: "press", key: "Enter" },
      { action: "wait", urlIncludes: "/search-results?q=bilibili" },
    ]);
    await at(reviewed, [{ action: "open", url: url + "/review" }]);
    const beforeRef = await call("A", { tabId: reviewed, steps: [] });
    const oldRef = JSON.parse(beforeRef.content[0].text).reads[0].match(
      /(@[\w.-]+) textbox Query/,
    )?.[1];
    assert.ok(oldRef);
    const partial = await call("A", {
      tabId: reviewed,
      steps: [
        { action: "click", selector: "#next" },
        { action: "fill", ref: oldRef, text: "wrong" },
        { action: "open", url: url + "/must-not-run" },
      ],
    });
    assert.equal(partial.isError, true, partial.content[0].text);
    assert.deepEqual(partial.structuredContent.executedSteps, [1]);
    assert.equal(partial.structuredContent.failedStep, 2);
    assert.deepEqual(partial.structuredContent.remainingSteps, [3]);
    assert.equal(partial.structuredContent.error.code, "stale_ref");
    assert.match(partial.structuredContent.url, /next-page/);
    await reviewWc.session.cookies.set({
      url,
      name: "fixture-session",
      value: "fixture-secret",
    });
    const sessionState = await stateTool({
      sessionCookies: ["fixture-session"],
    });
    assert.equal(sessionState.session.cookies[0].present, true);
    assert.ok(!JSON.stringify(sessionState).includes("fixture-secret"));
    await at(reviewed, [{ action: "open", url: url + "/fixture-login" }]);
    const authenticatedTab = (
      await tabs({ action: "new", url: url + "/fixture-account" })
    ).tabId;
    assert.match(
      (await read({ tabId: authenticatedTab })).text,
      /SERVER_AUTHENTICATED/,
    );
    const authenticationState = await stateTool({
      sessionCookies: ["fixture-login-cookie"],
    });
    assert.equal(authenticationState.session.cookies[0].present, true);
    assert.ok(!JSON.stringify(authenticationState).includes("synthetic-login"));
    await tabs({ action: "close", tabId: authenticatedTab });
    await panel("A", "control", { tabId: reviewed, manual: true });
    let controlReady = false;
    const waiting = call(
      "A",
      { tabId: reviewed, timeoutMs: 2000 },
      "browser_wait_for_control",
    ).then((result) => {
      controlReady = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(controlReady, false);
    await panel("A", "control", { tabId: reviewed, manual: false });
    assert.equal(JSON.parse((await waiting).content[0].text).ready, true);
    await panel("A", "control", { tabId: reviewed, manual: true });
    const waitStep = call("A", {
      tabId: reviewed,
      steps: [{ action: "wait_for_control", timeoutMs: 2000 }],
      snapshot: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await panel("A", "control", { tabId: reviewed, manual: false });
    assert.ok(!(await waitStep).isError);
    await panel("A", "control", { tabId: reviewed, manual: true });
    const queued = call("A", {
      tabId: reviewed,
      controlTimeoutMs: 2500,
      steps: [
        { action: "wait_for_control", timeoutMs: 2500 },
        { action: "open", url: url + "/queued" },
      ],
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      (await panel("A", "state")).tabs.find(
        (tab: { id: string }) => tab.id === reviewed,
      ).queued > 0,
    );
    await panel("A", "control", { tabId: reviewed, manual: false });
    assert.ok(!(await queued).isError);
    assert.match((await read({ tabId: reviewed })).url, /queued/);
    await at(reviewed, [
      { action: "fill", role: "textbox", name: "Query", text: "keyboard test" },
      { action: "press", key: "a", modifiers: ["Control"] },
      { action: "press", key: "Backspace" },
    ]);
    assert.equal(
      await reviewWc.executeJavaScript("document.querySelector('input').value"),
      "",
    );
    await at(reviewed, [{ action: "zoom", factor: 1.5 }]);
    assert.equal((await stateTool({})).zoomFactor, 1.5);
    const originalCapture = reviewWc.capturePage.bind(reviewWc);
    reviewWc.capturePage = async () => {
      throw Error("Current display surface not available");
    };
    const recoveredShot = await call(
      "A",
      { tabId: reviewed },
      "browser_screenshot",
    );
    reviewWc.capturePage = originalCapture;
    assert.ok(!recoveredShot.isError, recoveredShot.content[0].text);
    const imageMetadata = JSON.parse(recoveredShot.content[1].text);
    const shotSize = nativeImage
      .createFromBuffer(Buffer.from(recoveredShot.content[0].data, "base64"))
      .getSize();
    assert.equal(shotSize.width, Math.round(imageMetadata.viewport.width));
    assert.equal(shotSize.height, Math.round(imageMetadata.viewport.height));
    assert.ok(imageMetadata.attempts >= 2);
    reviewWc.capturePage = async () => {
      throw Error("Current display surface not available");
    };
    const beforeFailedShot = reviewWc.getURL();
    reviewWc.debugger.sendCommand = async (method, params, sessionId) => {
      if (method === "Page.captureScreenshot") throw Error("Internal error");
      return protocol(method, params, sessionId);
    };
    let failedShot;
    try {
      failedShot = await call("A", { tabId: reviewed }, "browser_screenshot");
    } finally {
      reviewWc.capturePage = originalCapture;
      reviewWc.debugger.sendCommand = protocol;
    }
    assert.equal(
      failedShot.structuredContent.error.code,
      "screenshot_surface_unavailable",
    );
    assert.equal(failedShot.structuredContent.error.attempts, 3);
    assert.ok(
      failedShot.structuredContent.error.causes.includes("Internal error"),
    );
    assert.equal(reviewWc.getURL(), beforeFailedShot);
    const clipped = await call(
      "A",
      { tabId: reviewed, clip: { x: 0, y: 0, width: 60, height: 40 } },
      "browser_screenshot",
    );
    assert.deepEqual(
      nativeImage
        .createFromBuffer(Buffer.from(clipped.content[0].data, "base64"))
        .getSize(),
      { width: 60, height: 40 },
    );
    await panel("A", "close", { tabId: reviewed });

    checkpoint("human and popup tabs");
    const human = (await panel("A", "new")).tabId;
    assert.notEqual(human, first);
    await panel("A", "open", { tabId: human, url: url + "/comments" });
    await panel("A", "control", { tabId: human, manual: true });
    assert.match((await read()).text, /Sign in/);
    assert.doesNotMatch((await read()).text, /First visible/);
    checkpoint("human tab screenshot");
    const humanImage = (await call("A", { tabId: human }, "browser_screenshot"))
      .content[0];
    assert.equal(humanImage.type, "image", humanImage.text);
    assert.ok((await call("A", { tabId: human, steps: [navigate] })).isError);
    assert.ok(
      (await call("A", { action: "close", tabId: human }, "browser_tabs"))
        .isError,
    );
    checkpoint("opening popup from a link");
    await at(first, [
      { action: "hover", role: "link", name: "Discuss" },
      { action: "select", role: "combobox", name: "Color", text: "Blue" },
      { action: "click", role: "link", name: "Discuss" },
    ]);
    let opened = await tabs({ action: "list" });
    for (
      let i = 0;
      i < 40 &&
      !opened.tabs.some(
        (t: { id: string; url: string }) =>
          t.id !== human && t.url.endsWith("/comments"),
      );
      i++
    ) {
      await new Promise((r) => setTimeout(r, 30));
      opened = await tabs({ action: "list" });
    }
    const popup = opened.tabs.find(
      (t: { id: string; url: string }) =>
        t.id !== human && t.url.endsWith("/comments"),
    )?.id;
    assert.ok(popup, JSON.stringify(opened));
    assert.equal(opened.viewedTabId, human);
    assert.equal((await read({ tabId: first })).url, url + "/");
    assert.ok((await call("B", { tabId: popup }, "browser_read")).isError);
    checkpoint("reading popup comments");
    await at(popup, [
      { action: "scroll", deltaY: 1000 },
      { action: "wait", text: "First visible comment" },
    ]);
    const visible = await read({ tabId: popup });
    assert.match(visible.text, /Second visible comment/);
    for (
      let i = 0;
      i < 20 && !(await read({ tabId: popup })).text.includes("Embedded reply");
      i++
    )
      await new Promise((r) => setTimeout(r, 30));
    assert.match((await read({ tabId: popup })).text, /Embedded reply/);
    assert.doesNotMatch(visible.text, /Sign in/);
    await panel("A", "select", { tabId: popup });
    await panel("A", "control", { tabId: popup, manual: true });
    await panel("A", "layout", {
      tabId: popup,
      x: 3,
      y: 3,
      width: 900,
      height: 740,
    });
    assert.match((await read()).text, /First visible comment/);

    checkpoint("background tab during human control");
    const working = await tabs({ action: "new", url });
    assert.equal((await read()).tabId, popup);
    const secondSnapshot = await call("A", {
      tabId: working.tabId,
      steps: [{ action: "read" }],
    });
    assert.ok(!secondSnapshot.isError);
    assert.ok(
      (
        await call("A", {
          tabId: working.tabId,
          steps: [{ action: "fill", ref, text: "wrong tab" }],
        })
      ).isError,
    );
    checkpoint("history navigation");
    await at(working.tabId, [
      { action: "open", url: url + "/comments" },
      { action: "back" },
      { action: "forward" },
      { action: "reload" },
      { action: "press", key: "Home" },
    ]);
    checkpoint("pointer gestures");
    await at(working.tabId, [
      { action: "open", url: url + "/gestures" },
      { action: "drag", x: 30, y: 30, toX: 260, toY: 90 },
      { action: "wait", text: "260" },
      { action: "click", x: 45, y: 45, clickCount: 2 },
      { action: "wait", text: "double" },
    ]);

    const marker = await pageContents(working.tabId).executeJavaScript(
      "(()=>{const m=document.querySelector('[data-nautilo-pointer]');return m && [m.getAttribute('aria-hidden'),getComputedStyle(m).pointerEvents,m.style.transform]})()",
    );
    assert.deepEqual(marker, ["true", "none", "translate(45px, 45px)"]);
    checkpoint("complete JSON response");
    await at(working.tabId, [{ action: "open", url: url + "/long.json" }]);
    const shortened = await call("A", { tabId: working.tabId, steps: [] });
    assert.match(shortened.content[0].text, /browser_read/);
    await pageContents(working.tabId).executeJavaScript(
      "document.body.textContent='JSON viewer collapsed …'",
    );
    let jsonText = "",
      offset: number | undefined = 0,
      parts = 0;
    while (offset !== undefined) {
      const part = await read({
        tabId: working.tabId,
        scope: "document",
        offset,
      });
      assert.equal(part.source, "loaded-main-response");
      assert.ok(part.text.length <= 16000);
      jsonText += part.text;
      if (part.nextOffset !== undefined) assert.ok(part.nextOffset > offset);
      offset = part.nextOffset;
      assert.ok(++parts < 15);
    }
    assert.ok(parts > 8);
    assert.ok(
      jsonText.includes(longJson),
      "Reassemble the original JSON exactly, including its tail",
    );
    const match = await read({
      tabId: working.tabId,
      scope: "document",
      text: "JSON_TAIL_MARKER",
    });
    assert.match(match.text, /JSON_TAIL_MARKER/);
    const beyond = await read({ tabId: working.tabId, offset: 999999 });
    assert.equal(beyond.outOfRange, true);
    assert.equal(beyond.text, "");
    assert.equal(beyond.nextOffset, undefined);
    assert.equal(
      JSON.parse(
        (await read({ tabId: working.tabId, jsonPath: "$.tail" })).text,
      ),
      "JSON_TAIL_MARKER",
    );
    await tabs({ action: "close", tabId: working.tabId });
    for (const tabId of [popup, human]) await panel("A", "close", { tabId });
    assert.equal(win.contentView.children.length, 0);
    await tabs({ action: "select", tabId: first });
    assert.equal((await panel("A", "state")).tabId, first);
    checkpoint("in-flight user handoff");
    const pending = call("A", {
      steps: [
        { action: "wait", text: "never", timeoutMs: 5000 },
        { action: "open", url: url + "/unexpected" },
      ],
    });
    for (let i = 0; i < 100 && !(await panel("A", "state")).busy; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      (await panel("A", "state")).busy,
      "The mutating batch should acquire its tab before handoff",
    );
    await panel("A", "control", true);
    assert.ok((await pending).isError);
    assert.ok(!(await call("A", { steps: [] })).isError);
    assert.ok((await call("A", { steps: [navigate] })).isError);
    await panel("A", "layout", { x: 10, y: 20, width: 300, height: 200 });
    assert.equal(win.contentView.children.length, 1);
    await panel("A", "control", false);
    await panel("A", "hide");
    assert.equal(win.contentView.children.length, 0);
    assert.ok(!(await panel("A", "state")).url.includes("unexpected"));

    checkpoint("moving native views");
    win.setFocusable(false);
    win.setOpacity(0);
    win.setSkipTaskbar(true);
    await panel("A", "layout", {
      tabId: first,
      x: 5,
      y: 5,
      width: 600,
      height: 400,
    });
    await win.webContents.executeJavaScript(
      "window.panels.onDock(target=>window.docked=target)",
    );
    const openWindow = (kind: string, id: string, focusOnly = false) =>
      win.webContents.executeJavaScript(
        "window.panels.open(" +
          JSON.stringify({ kind, sessionId: id }) +
          "," +
          focusOnly +
          ")",
      );
    assert.equal(await openWindow("browser", "A", true), false);
    await openWindow("browser", "A");

    assert.equal(win.contentView.children.length, 0);
    const childPanel = (id: string, cmd: string, value?: unknown) =>
      detached.webContents.executeJavaScript(
        "window.panel(" +
          [id, cmd, value ?? null].map((x) => JSON.stringify(x)).join(",") +
          ")",
      );
    assert.equal((await childPanel("A", "state")).tabId, first);
    await assert.rejects(childPanel("B", "state"), /Workbench required/);
    await childPanel("A", "layout", {
      tabId: first,
      x: 0,
      y: 0,
      width: 700,
      height: 420,
    });
    await panel("A", "hide", { tabId: first });
    await panel("A", "layout", {
      tabId: first,
      x: 5,
      y: 5,
      width: 600,
      height: 400,
    });
    assert.equal(detached!.contentView.children.length, 1);
    assert.equal(win.contentView.children.length, 0);
    const bState = await panel("B", "state");
    await panel("B", "layout", {
      tabId: bState.tabId,
      x: 5,
      y: 5,
      width: 550,
      height: 400,
    });
    assert.equal(win.contentView.children.length, 1);
    assert.equal(detached!.contentView.children.length, 1);
    const dock = async () => {
      const closed = new Promise<void>((resolve) =>
        detached.once("closed", () => resolve()),
      );
      void detached.webContents
        .executeJavaScript("window.panels.dock()")
        .catch(() => {});
      await closed;
    };
    await dock();
    assert.equal(
      (await win.webContents.executeJavaScript("window.docked")).kind,
      "browser",
    );
    assert.equal((await panel("A", "state")).tabId, first);
    assert.match((await read({ tabId: first })).text, /session-A/);

    await openWindow("source-control", "A");
    assert.equal(await openWindow("source-control", "A", true), true);
    await dock();
    assert.equal(
      (await win.webContents.executeJavaScript("window.docked")).kind,
      "source-control",
    );
    await panel("B", "hide");
    checkpoint("batch performance");
    const single: number[] = [],
      batch: number[] = [],
      runs = 15;
    const stepTimings = new Map<string, number[]>();
    for (let i = 0; i < runs; i++) {
      const compare = async (group: boolean) => {
        const value = "receipt-" + i + "-" + (group ? "batch" : "single"),
          steps = filter(value);
        const start = performance.now();
        let result;
        if (group) result = await run("A", steps);
        else
          for (const step of steps) {
            const started = performance.now();
            result = await run("A", [step]);
            const timings = stepTimings.get(step.action) ?? [];
            timings.push(performance.now() - started);
            stepTimings.set(step.action, timings);
          }
        assert.ok(result.reads[0].includes(value));
        return performance.now() - start;
      };
      if (i % 2) {
        batch.push(await compare(true));
        single.push(await compare(false));
      } else {
        single.push(await compare(false));
        batch.push(await compare(true));
      }
    }
    const median = (v: number[]) =>
      Number(v.sort((a, b) => a - b)[Math.floor(v.length / 2)].toFixed(1));
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        runs: runs * 2,
        succeeded: single.length + batch.length,
        oneCallMs: median(batch),
        fourCallsMs: median(single),
        stepMs: Object.fromEntries(
          [...stepTimings].map(([action, timings]) => [
            action,
            median(timings),
          ]),
        ),
      }),
    );
    await browser.close();
    site.close();
    app.exit(0);
  })
  .catch((error) => {
    writeFileSync(join(dir, "error.txt"), error.stack || String(error));
    app.exit(1);
  });
