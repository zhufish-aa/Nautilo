import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  type Rectangle,
  type BrowserWindowConstructorOptions,
  type Session,
  app,
} from "electron";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { BrowserActions, webUrl } from "./browser-actions";
import { listenBrowserMcp } from "./browser-mcp";
import { captureBrowserPage } from "./browser-capture";
import { BrowserToolError, browserDeadline } from "./browser-errors";
import { browserRegions } from "./browser-dom";
import {
  loadBrowserWorkspaces,
  saveBrowserWorkspaces,
  type SavedBrowserWorkspace,
  type SavedBrowserTab,
} from "./browser-workspaces";

type TaskPage = {
  id: string;
  view: WebContentsView;
  actions: BrowserActions;
  manual: boolean;
  revision: number;
  busy: boolean;
  writer: Promise<void>;
  queued: number;
  restoring?: Promise<void>;
  saved?: SavedBrowserTab;
  restoreError?: string;
};
type TabGroup = {
  id: string;
  tabs: Map<string, TaskPage>;
  viewed?: string;
  agent?: string;
};

function describe(page: TaskPage) {
  const wc = page.view.webContents;
  return {
    id: page.id,
    title: wc.getTitle(),
    url: wc.getURL() || page.saved?.url || "about:blank",
    manual: page.manual,
    busy: page.busy,
    queued: page.queued,
    zoomFactor: wc.getZoomFactor(),
    restoring: !!page.restoring,
    restoreError: page.restoreError,
  };
}

export class TaskBrowser {
  private groups = new Map<string, TabGroup>();
  private visible = new Map<
    BrowserWindow,
    { group: TabGroup; page: TaskPage }
  >();
  private panelWindows = new Map<string, BrowserWindow>();
  private window?: BrowserWindow;
  private parking?: BrowserWindow;
  private parkingWindow(): BrowserWindow {
    let window = this.parking;
    // Hidden views can report a zero-size viewport. Keep background pages
    // laid out in a real window without activating anyone's desktop.
    if (!window || window.isDestroyed()) {
      // Windows discards the compositor surface of a fully hidden native window.
      // An invisible, click-through, non-activating window keeps it paintable.
      window = new BrowserWindow({
        show: false,
        width: 1100,
        height: 760,
        frame: false,
        opacity: 0,
        skipTaskbar: true,
        focusable: false,
        webPreferences: { sandbox: true, backgroundThrottling: false },
      });
      this.parking = window;
      window.once("closed", () => {
        if (this.parking === window) this.parking = undefined;
      });
      window.setIgnoreMouseEvents(true);
      if (window.getOpacity() === 0) window.showInactive();
    }
    return window;
  }
  private host?: Awaited<ReturnType<typeof listenBrowserMcp>>;
  private partition = "persist:nautilo-browser";
  private savedWorkspaces = new Map<string, SavedBrowserWorkspace>();
  private workspacePath?: string;
  private workspaceTimer?: ReturnType<typeof setTimeout>;
  private workspaceWrite: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  private scheduleWorkspaces() {
    if (this.shuttingDown) return;
    clearTimeout(this.workspaceTimer);
    this.workspaceTimer = setTimeout(() => {
      void this.flushWorkspaces().catch(() =>
        console.warn("Browser workspaces could not be saved."),
      );
    }, 250);
    this.workspaceTimer.unref();
  }

  private async flushWorkspaces() {
    clearTimeout(this.workspaceTimer);
    if (!this.workspacePath) return;
    const path = this.workspacePath;
    this.workspaceWrite = this.workspaceWrite
      .catch(() => {})
      .then(async () => {
        for (const group of this.groups.values()) {
          const tabs = await Promise.all(
            [...group.tabs.values()].map(async (page) => {
              const wc = page.view.webContents;
              if (wc.isDestroyed()) return undefined;
              let scroll = {
                scrollX: page.saved?.scrollX ?? 0,
                scrollY: page.saved?.scrollY ?? 0,
              };
              if (wc.getURL() && !page.restoring && !wc.isLoadingMainFrame())
                scroll = await browserDeadline(
                  page.actions.viewport(),
                  500,
                  "save browser position",
                ).catch(() => scroll);
              return {
                id: page.id,
                url: wc.getURL() || page.saved?.url || "about:blank",
                zoom: wc.getZoomFactor(),
                scrollX: scroll.scrollX,
                scrollY: scroll.scrollY,
              };
            }),
          );
          if (this.groups.get(group.id) === group)
            this.savedWorkspaces.set(group.id, {
              id: group.id,
              viewed: group.viewed,
              agent: group.agent,
              tabs: tabs.filter((tab): tab is SavedBrowserTab => !!tab),
            });
        }
        await saveBrowserWorkspaces(path, this.savedWorkspaces);
      });
    await this.workspaceWrite;
  }
  private profile?: Session;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushPromise: Promise<void> = Promise.resolve();
  private onCookiesChanged = () => {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flushStorage().catch(() =>
        console.warn("Browser cookie storage could not be flushed."),
      );
    }, 200);
    this.flushTimer.unref();
  };

  async flushStorage() {
    clearTimeout(this.flushTimer);
    const profile = this.profile;
    if (!profile) return;
    this.flushPromise = this.flushPromise
      .catch(() => {})
      .then(async () => {
        profile.flushStorageData();
        await profile.cookies.flushStore();
      });
    await this.flushPromise;
  }

  async start(key: () => string): Promise<number> {
    this.workspacePath = join(
      app.getPath("userData"),
      "browser-workspaces.json",
    );
    this.savedWorkspaces = await loadBrowserWorkspaces(this.workspacePath);
    const profile = session.fromPartition(this.partition);
    this.profile = profile;
    profile.cookies.on("changed", this.onCookiesChanged);
    profile.setPermissionRequestHandler((_wc, _permission, done) =>
      done(false),
    );
    profile.setPermissionCheckHandler(() => false);
    profile.on("will-download", (event) => event.preventDefault());
    profile.webRequest.onBeforeRequest((req, callback) => {
      const allowed = /^(https?|wss?|blob|data|about):/i.test(req.url);
      const document = req.resourceType === "mainFrame";
      callback({
        cancel:
          !allowed ||
          (document &&
            !/^https?:\/\//i.test(req.url) &&
            req.url !== "about:blank"),
      });
    });
    this.host = await listenBrowserMcp(key, async (id, name, args, signal) => {
      const group = this.group(id);
      if (name === "browser_tabs") {
        const result = await this.manageAgentTabs(group, args);
        return { type: "text", text: JSON.stringify(result) };
      }
      const observation =
        name === "browser_read" ||
        name === "browser_screenshot" ||
        name === "browser_state" ||
        name === "browser_wait_for_control";
      if (name === "browser_scroll")
        args = {
          ...args,
          steps: [{ ...args, action: "scroll" }],
          snapshot: false,
        };
      const readOnly =
        observation ||
        (Array.isArray(args.steps) &&
          args.steps.every(
            (step: { action?: string } | null) =>
              step &&
              (step.action === "read" ||
                step.action === "wait_for_control" ||
                (step.action === "wait" &&
                  !(step as { alsoTryScroll?: boolean }).alsoTryScroll)),
          ));
      const page = this.lookup(
        group,
        args.tabId === "viewed" ? group.viewed : (args.tabId ?? group.agent),
      );
      if (page.restoring && !(args.steps?.[0]?.action === "open"))
        await page.restoring;
      if (name === "browser_wait_for_control") {
        await this.waitForControl(
          group,
          page,
          args.timeoutMs ?? 15000,
          signal,
          true,
        );
        return {
          type: "text",
          text: JSON.stringify({
            ok: true,
            ready: true,
            tabId: page.id,
            ...describe(page),
          }),
        };
      }
      if (name === "browser_state")
        return {
          type: "text",
          text: JSON.stringify(await this.state(group, page, args)),
        };
      const unlock = readOnly
        ? undefined
        : await this.acquireWriter(
            group,
            page,
            args.controlTimeoutMs ??
              (args.steps?.[0]?.action === "wait_for_control"
                ? args.steps[0].timeoutMs
                : undefined) ??
              15000,
            signal,
          );
      const revision = page.revision;
      const check = () => {
        if (signal.aborted)
          throw new BrowserToolError(
            "cancelled",
            "The browser request was cancelled.",
            { tabId: page.id },
          );
        if (!group.tabs.has(page.id) || page.view.webContents.isDestroyed())
          throw new BrowserToolError(
            "tab_closed",
            "The requested tab was closed.",
            { tabId: page.id },
          );
        if (!readOnly && (page.manual || this.hasUserFocus(page)))
          throw new BrowserToolError(
            "control_taken",
            "The user took control of this tab.",
            { tabId: page.id },
            "Wait for control, inspect the page, and resume only the unfinished steps.",
          );
        if (!readOnly && page.revision !== revision)
          throw new BrowserToolError(
            "page_changed",
            "The user changed this tab while the batch was running.",
            { tabId: page.id },
            "Read the current page before continuing.",
          );
      };
      try {
        check();
        if (name === "browser_screenshot") {
          if (!this.isVisible(page) && this.parking)
            this.parking.contentView.addChildView(page.view);
          const { data, metadata } = await captureBrowserPage(
            page.view.webContents,
            args,
            check,
          );
          check();
          return {
            content: [
              { type: "image", mimeType: "image/jpeg", data },
              {
                type: "text",
                text: JSON.stringify({ tabId: page.id, ...metadata }),
              },
            ],
          };
        }
        const result =
          name === "browser_read"
            ? await page.actions.read(args)
            : await page.actions.run(
                args,
                check,
                (timeout) =>
                  this.waitForControl(group, page, timeout, signal, readOnly),
                async (url, background) => {
                  check();
                  const tab = this.createTab(group);
                  if (!background) {
                    this.selectAgentTab(group, tab);
                    this.showTab(group, tab);
                  }
                  tab.busy = true;
                  try {
                    await browserDeadline(
                      tab.view.webContents.loadURL(url),
                      20000,
                      "open modified-click link",
                    );
                  } catch (error) {
                    throw new BrowserToolError(
                      "link_navigation_failed",
                      "The link tab opened but did not finish loading.",
                      { openedTabId: tab.id, url },
                      "Inspect the opened tab before retrying.",
                    );
                  } finally {
                    tab.busy = false;
                  }
                  return { tabId: tab.id, url };
                },
              );
        if (name === "browser_read") check();
        const output = { ...result, tabId: page.id, currentTabId: group.agent };
        if ("ok" in result && !result.ok)
          return {
            isError: true,
            structuredContent: output,
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        return {
          type: "text",
          text: JSON.stringify({
            ...output,
          }),
        };
      } finally {
        unlock?.();
      }
    });
    const address = this.host.address();
    if (!address || typeof address === "string") throw Error("No browser port");
    return address.port;
  }

  attachWindow(win: BrowserWindow) {
    this.window = win;
    win.once("closed", () => {
      if (this.window !== win) return;
      this.visible.clear();
      for (const id of this.groups.keys()) this.disposeGroup(id);
      if (this.parking && !this.parking.isDestroyed()) this.parking.destroy();
      this.parking = undefined;
      this.window = undefined;
    });
    let allowingClose = false,
      pendingClose = false;
    win.on("close", (event) => {
      if (allowingClose || this.shuttingDown) {
        allowingClose = false;
        return;
      }
      event.preventDefault();
      if (pendingClose) return;
      pendingClose = true;
      void this.flushWorkspaces()
        .catch(() =>
          console.warn("Browser workspaces could not be saved before closing."),
        )
        .finally(() => {
          pendingClose = false;
          if (!win.isDestroyed()) {
            allowingClose = true;
            win.close();
          }
        });
    });
  }

  attachPanelWindow(id: string, win: BrowserWindow) {
    this.hide(this.groups.get(id));
    this.panelWindows.set(id, win);
    win.on("close", () => this.hide(this.groups.get(id), undefined, win));
    win.once("closed", () => {
      this.visible.delete(win);
      if (this.panelWindows.get(id) === win) this.panelWindows.delete(id);
    });
  }

  private group(id: string): TabGroup {
    if (!/^[\w-]{1,160}$/.test(id)) throw Error("Invalid conversation");
    if (!this.window || this.window.isDestroyed())
      throw Error("Browser workbench is closed");
    let group = this.groups.get(id);
    if (!group) {
      group = { id, tabs: new Map() };
      this.groups.set(id, group);
      const saved = this.savedWorkspaces.get(id);
      if (saved) {
        for (const tab of saved.tabs) {
          const page = this.createTab(group, false, undefined, tab);
          page.restoring = this.restoreTab(page, tab).finally(() => {
            page.restoring = undefined;
          });
        }
        group.viewed = saved.viewed;
        group.agent = saved.agent;
      }
    }
    if (!group.tabs.size) this.createTab(group);
    return group;
  }

  private lookup(group: TabGroup, id: unknown): TaskPage {
    const page = typeof id === "string" ? group.tabs.get(id) : undefined;
    if (!page)
      throw new BrowserToolError(
        "unknown_tab",
        "Unknown tab in this conversation.",
        { requestedTabId: id },
        "Use browser_tabs to choose an available tab in this conversation.",
      );
    return page;
  }

  private createTab(
    group: TabGroup,
    manual = false,
    options?: BrowserWindowConstructorOptions,
    saved?: SavedBrowserTab,
  ): TaskPage {
    const view = new WebContentsView({
      ...options,
      webPreferences: {
        ...options?.webPreferences,
        partition: this.partition,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        webviewTag: false,
        preload: undefined,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.park(view);
    const wc = view.webContents;
    const id = saved?.id ?? randomUUID();
    const page = {
      id,
      view,
      actions: new BrowserActions(wc, id),
      manual,
      revision: 0,
      busy: false,
      writer: Promise.resolve(),
      queued: 0,
      saved,
    };
    group.tabs.set(page.id, page);
    group.viewed ??= page.id;
    group.agent ??= page.id;
    wc.once("destroyed", () => this.removeTab(group, page));
    wc.on("did-navigate", () => this.scheduleWorkspaces());
    wc.on("did-navigate-in-page", () => this.scheduleWorkspaces());
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (url !== "about:blank" && !/^https?:\/\//i.test(url))
        return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: (options) => {
          const child = this.createTab(group, page.manual, options);
          if (disposition !== "background-tab") {
            if (group.viewed === page.id) this.showTab(group, child);
            if (group.agent === page.id && !page.manual) group.agent = child.id;
          }
          return child.view.webContents;
        },
      };
    });
    this.scheduleWorkspaces();
    return page;
  }

  private async restoreTab(page: TaskPage, saved: SavedBrowserTab) {
    const wc = page.view.webContents;
    wc.setZoomFactor(saved.zoom);
    try {
      if (saved.url !== "about:blank")
        await browserDeadline(
          wc.loadURL(saved.url),
          20000,
          "restore browser tab",
        );
      else await wc.loadURL("about:blank");
      if (
        !wc.isDestroyed() &&
        page.revision === 0 &&
        wc.getURL() === saved.url
      ) {
        wc.setZoomFactor(saved.zoom);
        await browserDeadline(
          wc.executeJavaScriptInIsolatedWorld(1001, [
            { code: "scrollTo(" + saved.scrollX + "," + saved.scrollY + ")" },
          ]),
          2000,
          "restore browser position",
        );
      }
    } catch (error) {
      if (!wc.isDestroyed())
        page.restoreError =
          error instanceof Error ? error.message : String(error);
    }
  }

  private park(view: WebContentsView) {
    const previous = view.getBounds();
    this.parkingWindow().contentView.addChildView(view);
    view.setBounds({
      x: 0,
      y: 0,
      width: previous.width || 1100,
      height: previous.height || 760,
    });
  }

  private showTab(group: TabGroup, page: TaskPage) {
    if (group.viewed === page.id) return;
    this.hide(group);
    group.viewed = page.id;
    this.scheduleWorkspaces();
  }

  private selectAgentTab(group: TabGroup, page: TaskPage) {
    const previous = group.tabs.get(group.viewed ?? "");
    if (
      !previous ||
      (previous.id === group.agent &&
        !previous.manual &&
        !this.isVisible(previous))
    )
      this.showTab(group, page);
    group.agent = page.id;
    this.scheduleWorkspaces();
  }

  private tabList(group: TabGroup) {
    return {
      viewedTabId: group.viewed,
      agentTabId: group.agent,
      currentTabId: group.agent,
      workspaceId: group.id,
      tabs: [...group.tabs.values()].map((page) => ({
        ...describe(page),
        current: page.id === group.agent,
        viewed: page.id === group.viewed,
      })),
    };
  }

  private async manageAgentTabs(
    group: TabGroup,
    args: { action?: string; tabId?: string; url?: string },
  ) {
    if (args.action === "list") return this.tabList(group);
    if (args.action === "new") {
      const url = args.url === undefined ? undefined : webUrl(args.url);
      const page = this.createTab(group);
      this.selectAgentTab(group, page);
      if (url) {
        page.busy = true;
        try {
          await page.view.webContents.loadURL(url);
        } finally {
          page.busy = false;
        }
      }
      return { ...this.tabList(group), tabId: page.id };
    }
    const page = this.lookup(
      group,
      args.tabId === "viewed" ? group.viewed : args.tabId,
    );
    if (args.action === "select") this.selectAgentTab(group, page);
    else if (args.action === "close") {
      if (page.manual || page.busy || this.hasUserFocus(page))
        throw Error("Tab is in use.");
      this.closeTab(group, page);
    } else throw Error("Unknown tab action.");
    return this.tabList(group);
  }

  private removeTab(group: TabGroup, page: TaskPage) {
    if (!group.tabs.has(page.id)) return;
    const pages = [...group.tabs.values()];
    const index = pages.indexOf(page);
    const neighbor = pages[index + 1] ?? pages[index - 1];
    page.revision++;
    if (this.isVisible(page)) this.hide(group);
    group.tabs.delete(page.id);
    if (group.viewed === page.id) group.viewed = neighbor?.id;
    if (group.agent === page.id)
      group.agent =
        [...group.tabs.values()].find((p) => !p.manual)?.id ?? neighbor?.id;
    this.scheduleWorkspaces();
  }

  private closeTab(group: TabGroup, page: TaskPage) {
    const wc = page.view.webContents;
    this.removeTab(group, page);
    if (!wc.isDestroyed()) {
      if (this.parking && !this.parking.isDestroyed())
        this.parking.contentView.removeChildView(page.view);
      if (!wc.isDestroyed()) wc.close();
    }
  }

  private isVisible(page: TaskPage) {
    return [...this.visible.values()].some((value) => value.page === page);
  }

  private hasUserFocus(page: TaskPage) {
    return this.isVisible(page) && page.view.webContents.isFocused();
  }

  private async waitForControl(
    group: TabGroup,
    page: TaskPage,
    timeout: number,
    signal: AbortSignal,
    includeBusy = false,
  ) {
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60000)
      throw new BrowserToolError(
        "invalid_timeout",
        "Control timeout must be between 0 and 60000 milliseconds.",
        {},
        undefined,
        false,
      );
    const deadline = Date.now() + timeout;
    while (true) {
      if (signal.aborted)
        throw new BrowserToolError(
          "cancelled",
          "The queued browser request was cancelled.",
          { tabId: page.id },
        );
      if (!group.tabs.has(page.id) || page.view.webContents.isDestroyed())
        throw new BrowserToolError("tab_closed", "The queued tab was closed.", {
          tabId: page.id,
        });
      if (
        !page.manual &&
        !this.hasUserFocus(page) &&
        (!includeBusy || !page.busy)
      )
        return;
      if (Date.now() >= deadline)
        throw new BrowserToolError(
          "control_timeout",
          "The tab is still in use after waiting for control.",
          {
            tabId: page.id,
            manual: page.manual,
            busy: page.busy,
            waitedMs: timeout,
          },
          "Wait for the user to release this tab, or operate another explicit tabId.",
        );
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  private async acquireWriter(
    group: TabGroup,
    page: TaskPage,
    timeout: number,
    signal: AbortSignal,
  ) {
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60000)
      throw new BrowserToolError(
        "invalid_timeout",
        "Control timeout must be between 0 and 60000 milliseconds.",
        {},
        undefined,
        false,
      );
    const previous = page.writer;
    let release!: () => void,
      turn = false;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    page.writer = previous.then(() => slot);
    void previous.then(() => {
      turn = true;
    });
    page.queued++;
    const deadline = Date.now() + timeout;
    try {
      while (!turn) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
        );
        if (signal.aborted)
          throw new BrowserToolError(
            "cancelled",
            "The queued browser request was cancelled.",
            { tabId: page.id },
          );
        if (!group.tabs.has(page.id))
          throw new BrowserToolError(
            "tab_closed",
            "The queued tab was closed.",
            { tabId: page.id },
          );
        if (!turn && Date.now() >= deadline)
          throw new BrowserToolError(
            "control_timeout",
            "Another batch is still using this tab.",
            { tabId: page.id },
            "Wait for control, then resume with the same explicit tabId.",
          );
      }
      await this.waitForControl(
        group,
        page,
        Math.max(0, deadline - Date.now()),
        signal,
        true,
      );
      page.queued--;
      page.busy = true;
      return () => {
        page.busy = false;
        release();
      };
    } catch (error) {
      page.queued--;
      release();
      throw error;
    }
  }

  private async state(
    group: TabGroup,
    page: TaskPage,
    args: { sessionCookies?: string[]; authenticatedSelector?: string },
  ) {
    const wc = page.view.webContents,
      url = wc.getURL();
    const cookies = /^https?:/.test(url)
      ? await wc.session.cookies.get({ url })
      : [];
    const requested = args.sessionCookies ?? [];
    if (
      !Array.isArray(requested) ||
      requested.length > 20 ||
      requested.some((name) => typeof name !== "string")
    )
      throw new BrowserToolError(
        "invalid_cookie_names",
        "Provide up to twenty cookie names.",
        {},
        undefined,
        false,
      );
    const indicator = args.authenticatedSelector
      ? await page.actions.read({
          selector: args.authenticatedSelector,
          scope: "document",
          limit: 256,
        })
      : undefined;
    return {
      tabId: page.id,
      currentTabId: group.agent,
      ...describe(page),
      loading: wc.isLoading(),
      control:
        page.manual || this.hasUserFocus(page)
          ? "user"
          : page.busy
            ? "ai"
            : "available",
      viewport: await page.actions.viewport(),
      zoomFactor: wc.getZoomFactor(),
      regions: await browserRegions(wc),
      history: {
        back: wc.navigationHistory.canGoBack(),
        forward: wc.navigationHistory.canGoForward(),
      },
      session: {
        persistent: true,
        profileId: createHash("sha256")
          .update(wc.session.storagePath ?? this.partition)
          .digest("hex")
          .slice(0, 16),
        cookieCount: cookies.length,
        cookies: requested.map((name) => ({
          name,
          present: cookies.some((cookie) => cookie.name === name),
          expires: cookies.find((cookie) => cookie.name === name)
            ?.expirationDate,
        })),
        indicator: indicator
          ? {
              selector: args.authenticatedSelector,
              present: indicator.matchedRegions > 0,
            }
          : undefined,
        serverAuthentication: "unverified",
      },
    };
  }

  private hide(group?: TabGroup, tabId?: string, sender?: BrowserWindow) {
    for (const [win, shown] of this.visible) {
      if (
        shown.group !== group ||
        (sender && sender !== win) ||
        (tabId && tabId !== shown.page.id)
      )
        continue;
      this.visible.delete(win);
      if (!win.isDestroyed() && !shown.page.view.webContents.isDestroyed()) {
        win.contentView.removeChildView(shown.page.view);
        this.park(shown.page.view);
        shown.page.actions.surfaceChanged();
      }
    }
  }

  release(id: string) {
    this.savedWorkspaces.delete(id);
    this.disposeGroup(id);
    this.scheduleWorkspaces();
  }

  private disposeGroup(id: string) {
    const group = this.groups.get(id);
    if (!group) return;
    this.groups.delete(id);
    for (const page of group.tabs.values()) this.closeTab(group, page);
  }

  register() {
    ipcMain.handle(
      "browser:panel",
      async (event, id: string, command: string, value?) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (
          !win ||
          win.webContents !== event.sender ||
          (win !== this.window && win !== this.panelWindows.get(id)) ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw Error("Workbench required");
        const tabId = value?.tabId;
        if (command === "hide")
          return this.hide(this.groups.get(id), tabId, win);
        if (
          command === "layout" &&
          this.panelWindows.has(id) &&
          win !== this.panelWindows.get(id)
        )
          return;
        if (command === "release") return this.release(id);
        const group = this.group(id);
        if (command === "new") this.showTab(group, this.createTab(group));
        else if (command === "select")
          this.showTab(group, this.lookup(group, tabId));
        else if (command === "close") {
          this.closeTab(group, this.lookup(group, tabId));
          if (!group.tabs.size) this.createTab(group);
        } else {
          if (command === "layout" && tabId && tabId !== group.viewed) return;
          const page = this.lookup(group, tabId ?? group.viewed),
            wc = page.view.webContents;
          if (command === "control") {
            const manual = value?.manual ?? value;
            if (typeof manual !== "boolean")
              throw Error("Invalid control mode");
            page.revision++;
            page.manual = manual;
            if (page.busy) wc.stop();
            if (!manual) group.agent = page.id;
          } else if (command === "open") {
            const url = webUrl(value?.url ?? value);
            page.revision++;
            await wc.loadURL(url);
          } else if (command === "zoom") {
            const factor = value?.factor;
            if (
              typeof factor !== "number" ||
              !Number.isFinite(factor) ||
              factor < 0.25 ||
              factor > 3
            )
              throw Error("Invalid zoom factor");
            page.revision++;
            wc.setZoomFactor(factor);
            page.actions.surfaceChanged();
          } else if (
            command === "back" ||
            command === "forward" ||
            command === "reload"
          ) {
            page.revision++;
            const history = wc.navigationHistory;
            if (command === "back" && history.canGoBack()) history.goBack();
            if (command === "forward" && history.canGoForward())
              history.goForward();
            if (command === "reload" && wc.getURL()) wc.reload();
          } else if (command === "layout") {
            const r = value as Rectangle;
            if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite))
              throw Error("Invalid browser bounds");
            if (this.visible.get(win)?.page !== page) {
              this.hide(this.visible.get(win)?.group, undefined, win);
              this.hide(group);
              this.parkingWindow().contentView.removeChildView(page.view);
              win.contentView.addChildView(page.view);
              page.actions.surfaceChanged();
              this.visible.set(win, { group, page });
            }
            const [ww, wh] = win.getContentSize();
            const x = Math.max(0, Math.round(r.x)),
              y = Math.max(0, Math.round(r.y));
            page.view.setBounds({
              x,
              y,
              width: Math.max(0, Math.min(ww - x, Math.round(r.width))),
              height: Math.max(0, Math.min(wh - y, Math.round(r.height))),
            });
            return;
          } else if (command !== "state")
            throw Error("Invalid browser command");
        }
        const current = this.lookup(group, group.viewed);
        return {
          ...describe(current),
          canGoBack: current.view.webContents.navigationHistory.canGoBack(),
          canGoForward:
            current.view.webContents.navigationHistory.canGoForward(),
          tabId: current.id,
          ...this.tabList(group),
        };
      },
    );
  }

  async close() {
    this.shuttingDown = true;
    await this.flushWorkspaces().catch(() =>
      console.warn("Browser workspaces could not be saved at shutdown."),
    );
    for (const id of this.groups.keys()) this.disposeGroup(id);
    if (this.parking && !this.parking.isDestroyed()) this.parking.destroy();
    this.parking = undefined;
    this.host?.closeAllConnections();
    this.host?.close();
    this.profile?.cookies.removeListener("changed", this.onCookiesChanged);
    await this.flushStorage();
  }
}
