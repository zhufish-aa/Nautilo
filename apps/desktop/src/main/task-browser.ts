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
import { listenBrowserMcp, browserCapabilities } from "./browser-mcp";
import { captureBrowserPage } from "./browser-capture";
import { BrowserToolError, browserDeadline, browserError } from "./browser-errors";
import { browserRegions } from "./browser-dom";
import { browserCommand, isBrowserAgentInput } from "./browser-protocol";
import { forgetBrowserPresence, showBrowserPresence } from "./browser-presence";
import {forgetBrowserPointer,setBrowserPointerActive} from "./browser-pointer";
import { browserTimeout, evaluateBrowser, expectBrowser, type BrowserExpect } from "./browser-expect";
import { recoverBrowserRenderer } from "./browser-health";
import { BrowserSpacePreviews } from "./browser-space-previews";
import { browserFavicon } from "./browser-favicon";
import { dockingBrowserWindows } from "./panel-windows";
import { BrowserPageEvents } from "./browser-page-events";
import { BrowserFiles } from "./browser-files";
import { browserLogin } from "./browser-login";
import {fetchBrowser,pasteBrowser} from "./browser-page-tools";
import type { BrowserSpace, BrowserSpacesInput, BrowserSpacesState } from "../shared/browser-spaces";
import type {BrowserRunUpdate} from "@agenthub/event-protocol";
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
  events: BrowserPageEvents;
  manual: boolean;
  revision: number;
  busy: boolean;
  writer: Promise<void>;
  queued: number;
  restoring?: Promise<void>;
  initializing?:Promise<void>;
  saved?: SavedBrowserTab;
  restoreError?: string;
  controlKey: string;
  owner: "agent" | "user" | "ready" | "stopped";
  openedBy: "agent" | "user" | "unknown";
  label: string;
  activity?: string;
  browserTask?: {runId?:string};
  windowCloseOwner?: "agent" | "ready" | "user";
  userEdited: boolean;
  popups: TaskPage[];
  openedAt: number;
  favicon?: string;
  control?: {kind: string; at: string};
};
type TabGroup = {
  id: string;
  tabs: Map<string, TaskPage>;
  nextLabel: number;
  name?: string;
  source: "session" | "window";
  suspended?: boolean;
  parentId?: string;
  profileId?:string;
  isolated?:boolean;
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
    ownership: page.manual ? page.owner : page.busy || page.activity || page.browserTask ? "agent" : "ready",
    opened_by: page.openedBy,
    label: page.label,
    activity: page.activity,
    favicon: page.favicon,
  };
}

export class TaskBrowser {
  private groups = new Map<string, TabGroup>();
  private visible = new Map<
    BrowserWindow,
    { group: TabGroup; page: TaskPage }
  >();
  private panelWindows = new Map<string, BrowserWindow>();
  private overviewWindows = new Set<BrowserWindow>();
  private browserHost?: BrowserWindow;
  private hostSpace?: string;
  private previews?: BrowserSpacePreviews;
  private sessionCatalog?: () => Promise<{id:string;title:string;status?:string}[]>;
  private sessionMetadata = new Map<string, {title:string;status?:string}>();
  private metadataAt = 0;
  private cycleWindows?: () => void;
  private allWindowsStopped = false;
  private browserRequests = new Set<AbortController>();
  private inputSurface?:TaskPage;
  private files?: BrowserFiles;
  private profileFiles=new Map<Session,BrowserFiles>();
  private openWindow?: (id: string) => Promise<unknown>;
  private runTracking=false;
  private runStates=new Map<string,{sequence:number;active:Map<string,number>}>();

  trackRuns(enabled:boolean) {
    this.runTracking=enabled;
    if(!enabled) {
      this.runStates.clear();
      for(const group of this.groups.values())for(const page of group.tabs.values())this.endBrowserTask(page);
    }
  }
  observeRun(update?:BrowserRunUpdate) {
    if(!update){this.trackRuns(false);return;}
    this.runTracking=true;
    const state=this.runStates.get(update.sessionId) ?? {sequence:-1,active:new Map<string,number>()};
    if(update.sequence <= state.sequence)return;
    state.sequence=update.sequence;
    const active=update.state === "running" || update.state === "waiting";
    if(active)state.active.set(update.runId,update.sequence);else state.active.delete(update.runId);
    this.runStates.set(update.sessionId,state);
    for(const group of this.groups.values())if((group.parentId ?? group.id) === update.sessionId) {
      for(const page of group.tabs.values()) {
        if(!page.browserTask)continue;
        if(active && !page.browserTask.runId)page.browserTask.runId=update.runId;
        else if(!active && (!page.browserTask.runId || page.browserTask.runId === update.runId))this.endBrowserTask(page);
      }
    }
  }
  private noteBrowserTask(group:TabGroup,page:TaskPage) {
    if(!this.runTracking || page.manual || group.suspended)return;
    const active=this.runStates.get(group.parentId ?? group.id)?.active;
    if(active && !active.size)return;
    const runId=active && [...active].sort((a,b)=>b[1]-a[1])[0]?.[0];
    page.browserTask={runId};
    this.present(page);
  }
  private endBrowserTask(page:TaskPage) {
    page.browserTask=undefined;
    if(!page.manual && !page.busy)page.owner="ready";
    this.present(page);
  }

  setSessionCatalog(load: () => Promise<{id:string;title:string;status?:string}[]>) { this.sessionCatalog = load; }
  setWindowCycle(cycle: () => void) { this.cycleWindows = cycle; }
  setWindowOpener(open: (id: string) => Promise<unknown>) { this.openWindow = open; }

  attachOverviewWindow(win: BrowserWindow) {
    this.overviewWindows.add(win);
    win.once("closed", () => this.overviewWindows.delete(win));
  }

  /** One native shell; spaces own tabs, never separate operating-system windows. */
  attachBrowserHost(win:BrowserWindow) {
    this.browserHost=win;
    this.attachOverviewWindow(win);
    win.on("close",()=>this.hide(this.visible.get(win)?.group,undefined,win));
    win.once("closed",()=>{
      this.visible.delete(win);
      for(const [id,owner] of this.panelWindows)if(owner === win)this.panelWindows.delete(id);
      if(this.browserHost === win){this.browserHost=undefined;this.hostSpace=undefined;}
      if(!this.shuttingDown && !dockingBrowserWindows.has(win) && !this.hasBrowserWindow())this.stopAllWindows();
    });
  }

  selectBrowserSpace(win:BrowserWindow,id?:string,userInitiated=false) {
    if(win !== this.browserHost || win.isDestroyed())return;
    if(userInitiated)this.resumeClosedWindows();
    if(this.hostSpace !== id)this.hide(this.visible.get(win)?.group,undefined,win);
    this.hostSpace=id;
    if(id){this.panelWindows.set(id,win);this.group(id);}
    win.setTitle("Nautilo · " + (id ? this.spaceName(id) || "浏览器" : "浏览窗口"));
  }

  private hasBrowserWindow() {
    return [this.browserHost,...this.overviewWindows,...this.panelWindows.values()].some(win=>win && !win.isDestroyed());
  }

  private resumeClosedWindows() {
    this.allWindowsStopped=false;
    for(const saved of this.savedWorkspaces.values())saved.suspended=false;
    for(const group of this.groups.values()) {
      if(!group.suspended)continue;
      group.suspended=false;
      for(const page of group.tabs.values()) {
        if(page.owner !== "stopped" || page.control?.kind !== "windows_closed")continue;
        page.revision++;
        page.owner=page.windowCloseOwner === "user" ? "user" : "ready";
        page.manual=page.owner === "user";
        page.control=undefined;
        page.windowCloseOwner=undefined;
        this.present(page);
      }
    }
    this.scheduleWorkspaces();
  }

  private stoppedError(group:TabGroup,page?:TaskPage) {
    const windowOpen=this.hasBrowserWindow();
    return new BrowserToolError(group.suspended ? "BROWSER_CLOSED" : "CONTROL_TAKEN",group.suspended
      ? windowOpen ? "Browser operations are paused after closing the browser window; a browser window is now open."
        : "All browser windows are closed; browser operations are stopped."
      : "Browser operations were stopped by the user.",
      {space_id:group.id,tab_id:page?.id,browser_window_open:windowOpen,control:page?.control,reason:group.suspended?"windows_closed":"user_stopped"},
      group.suspended ? "A new browser tool call automatically reopens the browser. Resume only unfinished steps."
        : "Wait for the user to return control from the browser toolbar.");
  }

  private checkBrowserRequest(signal:AbortSignal) {
    if(!signal.aborted)return;
    if(signal.reason instanceof BrowserToolError)throw signal.reason;
    throw new BrowserToolError("cancelled","The browser request was cancelled.");
  }

  private async prepareAgentWindow(group:TabGroup,signal:AbortSignal) {
    this.checkBrowserRequest(signal);
    if(this.shuttingDown)throw new BrowserToolError("cancelled","The browser is shutting down.");
    if(group.suspended || this.allWindowsStopped)this.resumeClosedWindows();
    const embedded=[...this.visible.keys()].some(win=>!win.isDestroyed());
    if(!this.hasBrowserWindow() && !embedded)await this.openWindow?.(group.id);
    else if(this.browserHost?.isMinimized())this.browserHost.restore();
    this.checkBrowserRequest(signal);
  }

  private stopAllWindows() {
    this.allWindowsStopped=true;
    for(const request of this.browserRequests)request.abort(new BrowserToolError("BROWSER_CLOSED",
      "The browser window was closed during this request; the current operation stopped.",
      {reason:"windows_closed",control:{kind:"windows_closed",at:new Date().toISOString()}},
      "A new browser tool call automatically reopens the browser. Resume only unfinished steps."));
    for(const files of this.profileFiles.values())files.stopAgentDownloads();
    for(const group of this.groups.values()) {
      group.suspended=true;
      for(const page of group.tabs.values()) {
        if(page.manual)continue;
        page.windowCloseOwner=page.owner === "agent" ? "agent" : "ready";
        page.control={kind:"windows_closed",at:new Date().toISOString()};
        this.changeControl(group,page,"stopped");
      }
    }
    this.scheduleWorkspaces();
  }

  private spaceName(id: string) {
    return this.groups.get(id)?.name || this.savedWorkspaces.get(id)?.name || this.sessionMetadata.get(id)?.title;
  }

  private async spaces(input: BrowserSpacesInput = {}): Promise<BrowserSpacesState> {
    if (input.ids && (!Array.isArray(input.ids) || input.ids.length > 12 || input.ids.some(id => typeof id !== "string" || !/^[\w-]{1,160}$/.test(id))))
      throw Error("Request previews for at most twelve valid window IDs");
    if (this.sessionCatalog && Date.now() - this.metadataAt > 5000) {
      this.metadataAt = Date.now();
      try {
        const metadata = await browserDeadline(this.sessionCatalog(), 1500, "browser task names");
        this.sessionMetadata = new Map(metadata.map(item => [item.id, {title:item.title,status:item.status}]));
      } catch { /* A reconnecting daemon must not block independent browser windows. */ }
    }
    const ids = [...new Set([...this.savedWorkspaces.keys(), ...this.groups.keys()])];
    const cards = await Promise.all(ids.map(async id => {
      const group = this.groups.get(id), saved = this.savedWorkspaces.get(id);
      const page = group?.tabs.get(group.viewed ?? "");
      const tab = page ? describe(page) : saved?.tabs.find(tab => tab.id === saved.viewed) ?? saved?.tabs[0];
      if (!tab) return undefined;
      const win = this.panelWindows.get(id);
      const active = !!win && !win.isDestroyed() && win.isFocused() && (win !== this.browserHost || this.hostSpace === id);
      const status: BrowserSpace["status"] = page?.manual ? (page.owner === "stopped" ? "stopped" : "user")
        : group && [...group.tabs.values()].some(tab => tab.busy || tab.queued || tab.activity || tab.browserTask)
          ? "running" : "ready";
      const name = this.spaceName(id) || tab.title || (group?.source === "window" || saved?.source === "window" ? "新窗口" : "浏览窗口");
      if (win && !win.isDestroyed() && (win !== this.browserHost || this.hostSpace === id)) win.setTitle("Nautilo · " + name);
      return { id, name, source: group?.source ?? saved?.source ?? "session", tabCount: group?.tabs.size ?? saved?.tabs.length ?? 0,
        selectedTabId: tab.id, title: tab.title ?? "", url: tab.url, open: !!win && !win.isDestroyed(), active, status,
        preview: input.previews && (!input.ids || input.ids.includes(id)) ? await this.previews?.image(id) : undefined } satisfies BrowserSpace;
    }));
    const spaces = cards.filter((card): card is NonNullable<typeof card> => !!card);
    if (input.previews) {
      const candidates = spaces.filter(card => !input.ids || input.ids.includes(card.id)).slice(0, 12);
      for (let index = 0; index < candidates.length; index += 3) {
        await Promise.all(candidates.slice(index, index + 3).map(async card => {
          const group = this.groups.get(card.id), page = group?.tabs.get(group.viewed ?? "");
          if (page && page.view.webContents.getURL() && page.view.webContents.getURL() !== "about:blank")
            card.preview = await this.previews?.capture(card.id, page.view.webContents, page.id + "/" + page.view.webContents.getURL()) ?? card.preview;
        }));
      }
    }
    return { spaces };
  }
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
                title: wc.getTitle() || page.saved?.title,
                favicon: page.favicon,
              };
            }),
          );
          if (this.groups.get(group.id) === group)
            this.savedWorkspaces.set(group.id, {
              id: group.id,
              name: group.name,
              source: group.source,
              parentId: group.parentId,
              suspended: group.suspended,
              profileId:group.profileId,isolated:group.isolated,
              viewed: group.viewed,
              agent: group.agent,
              tabs: tabs.filter((tab): tab is NonNullable<typeof tab> => !!tab),
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
    if (!this.profile) return;
    this.flushPromise = this.flushPromise
      .catch(() => {})
      .then(async () => {
        for(const profile of this.profileFiles.keys()){profile.flushStorageData();await profile.cookies.flushStore();}
      });
    await this.flushPromise;
  }

  private configureProfile(profile:Session) {
    const current=this.profileFiles.get(profile);if(current)return current;
    profile.cookies.on("changed", this.onCookiesChanged);
    profile.setPermissionRequestHandler((_wc, _permission, done) =>
      done(false),
    );
    profile.setPermissionCheckHandler(() => false);
    const files = new BrowserFiles(profile,join(app.getPath("userData"),"browser-downloads"),
      wc=>[...this.groups.values()].flatMap(group=>[...group.tabs.values()]).find(page=>page.view.webContents === wc)?.id,
      tabId=>[...this.groups.values()].flatMap(group=>[...group.tabs.values()]).find(page=>page.id === tabId)?.events,
      tabId=>[...this.groups.values()].flatMap(group=>[...group.tabs.values()]).some(page=>page.id === tabId && page.busy && !page.manual));
    profile.webRequest.onBeforeRequest((req, callback) => {
      const allowed = /^(https?|wss?|blob|data|file|about|nautilo-page-dialog):/i.test(req.url);
      const document = req.resourceType === "mainFrame";
      callback({
        cancel:
          !allowed ||
          (document &&
            !/^(https?:\/\/|file:\/\/|blob:|data:)/i.test(req.url) &&
            req.url !== "about:blank"),
      });
    });
    this.profileFiles.set(profile,files);
    return files;
  }

  async start(key: () => string): Promise<number> {
    this.workspacePath = join(
      app.getPath("userData"),
      "browser-workspaces.json",
    );
    this.savedWorkspaces = await loadBrowserWorkspaces(this.workspacePath);
    this.previews = new BrowserSpacePreviews(join(app.getPath("userData"), "browser-previews"));
    const profile = session.fromPartition(this.partition);
    this.profile = profile;
    this.files=this.configureProfile(profile);
    this.host = await listenBrowserMcp(key, async (id, name, args, requestSignal) => {
      const request=new AbortController(),signal=AbortSignal.any([requestSignal,request.signal]);
      this.browserRequests.add(request);
      try {
      this.checkBrowserRequest(signal);
      args = { ...args, tabId: args.tabId ?? args.tab_id };
      const group = this.agentGroup(id,args.spaceId ?? args.space_id);
      if (name === "browser_session") {
        return { type: "text", text: JSON.stringify(await this.manageSession(group, args, signal)) };
      }
      if(!((name === "browser_tabs" && args.action === "close") || (name === "browser_files" && args.action === "cancel")))await this.prepareAgentWindow(group,signal);
      if (name === "browser_tabs") {
        const result = await this.manageAgentTabs(group, args);
        return { type: "text", text: JSON.stringify(result) };
      }
      if (["browser_files","browser_dialog","browser_cdp","browser_fetch","browser_paste","browser_events"].includes(name)) {
        const page=this.lookup(group,args.tabId === "viewed" ? group.viewed : args.tabId ?? group.agent);
        await page.initializing;
        if(page.restoring)await page.restoring;
        const readOnly=name === "browser_events" || ((name === "browser_files" || name === "browser_dialog") && args.action === "list") ||
          (name === "browser_cdp" && /^(?:DOM|Accessibility|DOMSnapshot|Page|Network|Runtime)\.(?:get|describe|query|capture|collect)/.test(args.method));
        const interrupt = name === "browser_dialog" || (name === "browser_files" && ["upload","cancel"].includes(args.action)) || (name === "browser_cdp" && args.method === "Page.handleJavaScriptDialog");
        const unlock=readOnly || interrupt ? undefined : await this.acquireWriter(group,page,args.controlTimeoutMs ?? 15000,signal);
        const check=()=>{this.checkBrowserRequest(signal);if(!readOnly && (page.manual || group.suspended))throw new BrowserToolError("CONTROL_TAKEN","Browser operations were paused.",{control:page.control});};
        try {
          check();
          this.noteBrowserTask(group,page);
          let result;
          if(name === "browser_events") {
            if(args.action === "watch" || args.action === "unwatch") {
              if(!Array.isArray(args.methods) || !args.methods.length || args.methods.length>10)throw new BrowserToolError("INVALID_REQUEST","Watch 1–10 page protocol event methods.");
              for(const method of args.methods)if(args.action === "watch")await page.events.watch(method);else page.events.unwatch(method);
            } else if(args.action !== "list")throw new BrowserToolError("INVALID_REQUEST","Use events list, watch or unwatch.");
            const events=page.events.list(args.since??0).slice(0,Math.max(1,Math.min(120,args.limit??120)));
            result={ok:true,events,cursor:events.at(-1)?.id??args.since??0,latest_cursor:page.events.cursor};
          } else result=name === "browser_files" ? await this.configureProfile(page.view.webContents.session).command(page.view.webContents,page.id,page.events,args,check)
            : name === "browser_dialog" ? await page.events.dialogCommand(args)
            : name === "browser_fetch" ? await fetchBrowser(page.view.webContents,args,check)
            : name === "browser_paste" ? await pasteBrowser(page.view.webContents,args,check) : await this.cdp(page,args,check);
          return {type:"text",text:JSON.stringify({...(result && typeof result === "object" ? result : {value:result}),tab_id:page.id,space_id:group.id})};
        } catch(error) {throw await this.rendererFailure(page,error,check);} finally {unlock?.();}
      }
      if (["browser_eval", "browser_assert", "browser_wait"].includes(name) ||
        (name === "browser_run" && Array.isArray(args.steps) && args.steps.some((step: any) => step &&
          (step.target || step.expect || step.id || step.follow || step.optional || ["eval", "assert", "goto", "dblclick", "screenshot"].includes(step.action))))) {
        const { images = [], ...output } = await this.runObserved(group, name, args, signal);
        return { ...(output.ok ? {} : { isError: true }), structuredContent: output,
          content: [...images, { type: "text", text: JSON.stringify(output) }] };
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
      await page.initializing;
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
      this.noteBrowserTask(group,page);
      const revision = page.revision;
      const check = () => {
        this.checkBrowserRequest(signal);
        if((group.suspended || page.owner === "stopped") && !observation)throw this.stoppedError(group,page);
        if (!group.tabs.has(page.id) || page.view.webContents.isDestroyed())
          throw new BrowserToolError(
            "tab_closed",
            "The requested tab was closed.",
            { tabId: page.id },
          );
        if (!readOnly && page.manual)
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
        const popupStart = page.popups.length;
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
                    await tab.initializing;
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
        const popups = this.popups(page, popupStart);
        const recentPopups = page.popups.filter(child => child.openedAt > Date.now() - 30000 && !child.view.webContents.isDestroyed()).map(child => ({tab_id:child.id,label:child.label,url:child.view.webContents.getURL()}));
        if (!result.ok && result.error?.code === "wait_timeout" && (popups.length || recentPopups.length)) {
          result.error = { ...result.error, code: "NAVIGATED_TO_NEW_TAB", popups: popups.length ? popups : recentPopups,
            message: "The preceding action opened a new tab; this wait stayed on the original tab.",
            recovery: "The click already succeeded. Continue on the returned tab_id, or use follow:new_tab with expect. Do not repeat the click." } as typeof result.error;
        }
        if (!result.ok && result.error?.code === "browser_operation_timeout") {
          const health = await recoverBrowserRenderer(page.view.webContents, () => page.openedBy === "agent" && !page.manual && !page.userEdited && !page.events.dialog && !page.events.chooser, check);
          result.error = { ...result.error, renderer_alive: health ? health.recovered : true, ...health };
        }
        const output = { ...result, verified: false, popups, tabId: page.id, currentTabId: group.agent,
          tab_id: page.id, current_tab_id: group.agent, view_id: page.actions.viewId,
            ...("steps" in result ? {steps:result.steps.map((step: Record<string, unknown>,index: number)=>({...step,id:"s"+(index+1)})),
            executed_steps: result.executedSteps, ...(!result.ok ? {failed_step:result.failedStep,remaining_steps:result.remainingSteps} : {})} : {}) };
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
      } catch(error) {throw await this.rendererFailure(page,error,check);} finally {
        unlock?.();
      }
      } finally {this.browserRequests.delete(request);}
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
    win.setTitle("Nautilo · " + (this.spaceName(id) || "浏览器"));
    void this.spaces().catch(() => {});
    win.on("close", () => this.hide(this.groups.get(id), undefined, win));
    win.once("closed", () => {
      this.visible.delete(win);
      if (this.panelWindows.get(id) === win) this.panelWindows.delete(id);
      if (!this.shuttingDown && !dockingBrowserWindows.has(win) && !this.hasBrowserWindow()) {
        this.stopAllWindows();
      }
    });
  }

  private present(page: TaskPage) {
    if (!this.isVisible(page) || page.view.webContents.isDestroyed()) return;
    setBrowserPointerActive(page.view.webContents,!page.manual && !!(page.busy || page.activity || page.browserTask));
    showBrowserPresence(page.view.webContents, {
      mode: page.manual ? page.owner : page.busy || page.activity || page.browserTask ? "agent" : "ready", title: page.view.webContents.getTitle() || page.label,
      action: page.activity, controlKey: page.controlKey,
    });
  }

  private changeControl(group: TabGroup, page: TaskPage, owner: TaskPage["owner"]) {
    const manual = owner === "user" || owner === "stopped";
    if (page.manual !== manual || page.owner !== owner) page.revision++;
    page.manual = manual;
    page.owner = owner;
    if(manual)page.browserTask=undefined;
    if(owner === "stopped")page.events.cancelDialogs();
    if (owner === "agent") {
      group.suspended = false;this.allWindowsStopped=false;
      page.control=undefined;
      if(this.runStates.get(group.parentId ?? group.id)?.active.size)this.noteBrowserTask(group,page);
    }
    if (manual && page.busy && page.view.webContents.isLoading()) page.view.webContents.stop();
    if (owner === "stopped" && page.busy)
      void browserCommand(page.view.webContents, "Runtime.terminateExecution", {}, 1000).catch(() => {});
    if (!manual) group.agent = page.id;
    page.activity = undefined;
    this.present(page);
  }

  private popups(page: TaskPage, offset = 0) {
    return page.popups.slice(offset).filter(child => !child.view.webContents.isDestroyed()).map(child => ({
      tab_id: child.id, tabId: child.id, label: child.label, url: child.view.webContents.getURL(),
    }));
  }

  private agentGroup(id:string,spaceId?:unknown) {
    if(spaceId === undefined || spaceId === id)return this.group(id);
    if(typeof spaceId !== "string" || (this.groups.get(spaceId)?.parentId ?? this.savedWorkspaces.get(spaceId)?.parentId) !== id)
      throw new BrowserToolError("SESSION_CONFLICT","This browser space does not belong to the authenticated conversation.",{},undefined,false);
    return this.group(spaceId);
  }

  private async cdp(page:TaskPage,args:any,check:()=>void) {
    const method=args.method;
    if(typeof method !== "string" || !/^(Page|Runtime|DOM|DOMSnapshot|Accessibility|Input|Network|Emulation|Log)\.[A-Za-z0-9]+$/.test(method) || /(?:getAllCookies|clearBrowserCookies|clearBrowserCache|setCookie|deleteCookies|setCookies|close$)/.test(method))
      throw new BrowserToolError("INVALID_CDP_METHOD","Use a page-scoped CDP command. Browser/Target/profile-wide commands must not bypass workspace ownership.",{method},undefined,false);
    check();
    if(method === "Page.handleJavaScriptDialog" && page.events.dialog?.data.source === "nautilo-dialog")
      return {ok:true,result:await page.events.handleDialog(args.params?.accept === true,args.params?.promptText),verified:false};
    const value=await browserCommand(page.view.webContents,method,args.params ?? {},browserTimeout(args.timeoutMs,5000));
    check();
    if(Buffer.byteLength(JSON.stringify(value))>100*1024)throw new BrowserToolError("RESULT_TOO_LARGE","CDP result exceeds 100 KB. Select a smaller response or use browser_read.");
    return {ok:true,result:value,verified:false};
  }

  private async rendererFailure(page:TaskPage,error:unknown,check:()=>void) {
    const failure=browserError(error);
    if(failure.code !== "browser_operation_timeout")return error;
    if(page.events.dialog)return new BrowserToolError("DIALOG_PENDING","A web dialog is waiting for a response.",{dialog:page.events.dialog.data},"Respond through browser_dialog or the visible dialog. The page was not reloaded.");
    const health=await recoverBrowserRenderer(page.view.webContents,()=>page.openedBy === "agent" && !page.manual && !page.userEdited && !page.events.dialog && !page.events.chooser,check);
    return new BrowserToolError(health?.code ?? failure.code,failure.message,{...failure,renderer_alive:health ? health.recovered : true,...health},health?.recovery ?? failure.recovery);
  }

  private async manageSession(group: TabGroup, args: any, signal:AbortSignal) {
    if(args.action === "inspect_login" || args.action === "import_login")return browserLogin(this.lookup(group,group.agent).view.webContents.session,args.action === "inspect_login"?"inspect":"import",args);
    if(args.profile_id !== undefined && (typeof args.profile_id !== "string" || !/^[\w-]{1,80}$/.test(args.profile_id)))throw new BrowserToolError("INVALID_PROFILE","profile_id contains 1–80 letters, numbers, underscores or hyphens.");
    if((args.profile_id !== undefined || args.isolated) && (args.action !== "open" || !args.name))throw new BrowserToolError("INVALID_PROFILE","Open a named space for a separate profile/context; existing tabs are not switched to another account.");
    if (args.action === "open" && args.name) {
      if(typeof args.name !== "string" || !args.name.trim() || args.name.length>120)throw new BrowserToolError("INVALID_REQUEST","Browser space names contain 1–120 characters.",{},undefined,false);
      const root=group.parentId ?? group.id, name=args.name.trim();
      const existing=[...this.savedWorkspaces.values(),...this.groups.values()].find(item=>item.name?.toLocaleLowerCase() === name.toLocaleLowerCase());
      if(existing && existing.id !== root && existing.parentId !== root)throw new BrowserToolError("SESSION_CONFLICT","This browser space name belongs to another conversation or the user.",{name},"Choose a different name; another workspace is not claimed implicitly.",false);
      if(existing && ((args.profile_id !== undefined && existing.profileId !== args.profile_id) || (args.isolated !== undefined && !!existing.isolated !== !!args.isolated)))throw new BrowserToolError("SESSION_CONFLICT","This space already uses a different profile/context. Choose a new name.");
      const spaceId=existing?.id ?? "agent-space-"+randomUUID();
      group=this.group(spaceId,{profileId:args.profile_id ?? (args.isolated?spaceId:undefined),isolated:!!args.isolated});
      group.parentId=root;group.name=name;
      this.scheduleWorkspaces();
    }
    if(!["finish","handoff","inspect_login"].includes(args.action))await this.prepareAgentWindow(group,signal);
    if (["list","open","login"].includes(args.action)) {
      if(args.url) {
        const page=this.lookup(group,args.tabId ?? group.agent);
        await page.initializing;
        if(group.suspended || page.manual)throw new BrowserToolError("CONTROL_TAKEN","The user must return control before navigating this tab.");
        const outcome=await page.actions.run({steps:[{action:"open",url:args.url,timeoutMs:30000}],snapshot:false},()=>{this.checkBrowserRequest(signal);if(group.suspended || page.manual)throw new BrowserToolError("CONTROL_TAKEN","Browser navigation was paused.");});
        if(!outcome.ok)return outcome;
      }
      if(args.action === "login") {
        for(const page of group.tabs.values())this.changeControl(group,page,"user");
        await this.openWindow?.(group.id);
      } else if(args.show)await this.openWindow?.(group.id);
      const root=group.parentId ?? group.id;
      const spaces=[...new Map([...this.savedWorkspaces.values(),...this.groups.values()].filter(item=>item.id === root || item.parentId === root).map(item=>[item.id,{space_id:item.id,name:item.name,source:item.source}])).values()];
      return {ok:true,space_id:group.id,spaces,capabilities:browserCapabilities,profile:{id:group.profileId??"default",isolated:!!group.isolated,persistent:!group.isolated,login_method:"user_handoff",shared_with:group.profileId?"spaces with the same profile_id and isolation mode":"default Nautilo browser spaces",external_browser_login_imported:false},...(args.action === "login"?{handed_off:true,ownership:"user"}:{}),...this.tabList(group)};
    }
    if (args.action === "handoff") {
      for (const page of group.tabs.values()) this.changeControl(group, page, "user");
      return { ok: true, ownership: "user", ...this.tabList(group) };
    }
    if (args.action === "claim") {
      const page = this.lookup(group, args.tabId ?? group.agent);
      if (page.manual) throw new BrowserToolError("CONTROL_TAKEN", "The user must return control before the agent can claim this tab.", {}, "Use browser_wait_for_control; do not override the user's handoff.");
      page.owner = "agent";
      this.noteBrowserTask(group,page);
      this.present(page);
      return { ok: true, ownership: "agent", ...this.tabList(group) };
    }
    if (args.action !== "finish") throw new BrowserToolError("INVALID_REQUEST", "Unknown browser session action.", {}, undefined, false);
    const keep = args.keep ?? [];
    if (!Array.isArray(keep) || keep.some(value => typeof value !== "string" || ![...group.tabs.values()].some(page => page.id === value || page.label === value)))
      throw new BrowserToolError("TAB_OWNERSHIP", "keep must contain tab IDs or labels from this conversation.", {}, undefined, false);
    const closed: string[] = [];
    for (const page of [...group.tabs.values()]) {
      this.endBrowserTask(page);
      if (keep.includes(page.id) || keep.includes(page.label) || page.openedBy !== "agent" || page.manual || page.userEdited) {
        page.owner = page.manual ? "user" : "ready";
        this.present(page);
        continue;
      }
      if (page.busy) throw new BrowserToolError("SESSION_CONFLICT", "A browser action is still running. Finish it before closing the session.", { tab_id: page.id });
      closed.push(page.id);
    }
    for (const id of closed) this.closeTab(group, this.lookup(group, id));
    return { ok: true, status: "completed", closed, ...this.tabList(group) };
  }

  /** New schema features share the existing driver, queue and per-conversation ownership. */
  private async runObserved(group: TabGroup, name: string, args: any, signal: AbortSignal): Promise<Record<string, any>> {
    const steps: any[] = name === "browser_run" ? args.steps : [{ ...args, action: name === "browser_eval" ? "eval" : "assert",
      expect: name === "browser_eval" && args.expect ? { eval: { script: args.script, arg: args.arg, expect: args.expect } } : args.expect }];
    if (!Array.isArray(steps) || !steps.length || steps.length > 30) throw new BrowserToolError("INVALID_REQUEST", "Provide between one and thirty steps.", {}, undefined, false);
    const ids = steps.map((step, index) => step?.id ?? "s" + (index + 1));
    if (ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(id)) || new Set(ids).size !== ids.length)
      throw new BrowserToolError("INVALID_REQUEST", "Step IDs must be unique and contain at most forty letters, digits, dots, underscores or hyphens.", {}, undefined, false);
    let page = this.lookup(group, args.tabId === "viewed" ? group.viewed : args.tabId ?? group.agent);
    const reports: Record<string, any>[] = [], allPopups: Record<string, string>[] = [], images: Record<string, string>[] = [];
    let unlock: (() => void) | undefined, locked: TaskPage | undefined, revision = 0;
    let verified = false, value: unknown, snapshot: string | undefined;
    const check = (write = false) => {
      this.checkBrowserRequest(signal);
      if (!group.tabs.has(page.id) || page.view.webContents.isDestroyed()) throw new BrowserToolError("TAB_CLOSED", "The target tab was closed.", { tab_id: page.id });
      if (write && page.manual) throw new BrowserToolError("CONTROL_TAKEN", "The user took control of this tab.", { tab_id: page.id, control: page.control ?? {kind:"user_input",at:new Date().toISOString()} }, "Wait for the user to return control, inspect the page, then resume unfinished steps.");
      if (group.suspended || page.owner === "stopped") throw this.stoppedError(group,page);
      if (write && locked === page && page.revision !== revision) throw new BrowserToolError("page_changed", "The tab changed while the action was running.", { tab_id: page.id });
    };
    try {
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        const report: Record<string, any> = { step: index + 1, id: ids[index], status: "running", action: step?.action };
        reports.push(report);
        let removeNetwork = () => {};
        try {
          if (!step || typeof step.action !== "string") throw new BrowserToolError("INVALID_REQUEST", "Every step needs an action.", {}, undefined, false);
          const action = step.action === "goto" ? "open" : step.action === "dblclick" ? "click" : step.action;
          const write = !["read", "assert", "wait", "screenshot", "wait_for_control"].includes(action) || !!step.expect?.eval ||
            (action === "wait_for_control" && steps.slice(index+1).some(item=>!["read","assert","wait","screenshot","wait_for_control"].includes(item.action)));
          if (write && locked !== page) {
            unlock?.(); unlock = undefined; locked = undefined;
            unlock = await this.acquireWriter(group, page, args.controlTimeoutMs ?? 15000, signal);
            locked = page; revision = page.revision;
          }
          check(write);
          await page.initializing;
          if (page.restoring) await page.restoring;
          this.noteBrowserTask(group,page);
          page.activity = step.label ?? ({ open: "正在打开网页", click: "正在点击", fill: "正在输入", press: "正在输入", scroll: "正在浏览", read: "正在读取网页", eval: "正在执行脚本", assert: "正在验证", wait: "正在等待页面" } as Record<string, string>)[action];
          this.present(page);
          const wc = page.view.webContents, from = wc.getURL(), popupStart = page.popups.length;
          const eventStart=page.events.cursor;
          if(step.expect?.event || step.expect?.load_state || step.expect?.network_idle_ms) {
            if(step.expect?.event?.method)await page.events.watch(step.expect.event.method);
            await page.events.start();
          }
          const networks: { url: string; method?: string; status: number }[] = [], methods = new Map<string, string>();
          if (step.expect?.network) {
            const listener = (_event: unknown, method: string, params: any) => {
              if (method === "Network.requestWillBeSent") { if (methods.size >= 100) methods.delete(methods.keys().next().value!); methods.set(params.requestId, params.request.method); }
              if (method === "Network.responseReceived") { networks.push({ url: params.response.url, status: params.response.status, method: methods.get(params.requestId) }); if (networks.length > 100) networks.shift(); }
            };
            wc.debugger.on("message", listener);
            removeNetwork = () => wc.debugger.removeListener("message", listener);
            await browserCommand(wc, "Network.enable");
          }
          const timeout = browserTimeout(step.timeout_ms ?? step.timeoutMs, ["open", "reload", "back", "forward"].includes(action) ? 30000 : action === "read" ? 10000 : action === "eval" ? 5000 : 15000);
          if (action === "eval") {
            if (step.expect) {
              const expectation = step.expect.eval ? step.expect : {eval:{script:step.script,arg:step.arg,expect:step.expect}};
              const outcome = await expectBrowser(wc, expectation, { from, popups: () => this.popups(page, popupStart) }, () => check(true), timeout);
              value = outcome.actual.eval; verified = true;
              report.verification = outcome;
            } else value = await evaluateBrowser(wc, step.script, step.arg, () => check(true), timeout);
            report.result = value;
          } else if (action === "screenshot") {
            const capture = await captureBrowserPage(wc, step, () => check());
            images.push({ type: "image", mimeType: "image/jpeg", data: capture.data });
            report.result = capture.metadata;
          } else if (action !== "assert" && !(action === "wait" && step.expect)) {
            const result = await page.actions.run({ steps: [{ ...step, action, clickCount: step.action === "dblclick" ? 2 : step.clickCount,
              timeoutMs: timeout }], snapshot: false }, () => check(write), timeout => this.waitForControl(group, page, timeout, signal, !write));
            report.dispatched = { action, target: step.target, url: step.url };
            const detail = result.steps[0]?.result;
            if((result.steps[0] as {ref_rebound?:boolean}|undefined)?.ref_rebound)report.ref_rebound=true;
            report.result = action === "read" ? { ...(detail && typeof detail === "object" ? detail : {}), text: result.reads.join("\n") } : detail ?? result.content;
            if (!result.ok) {
              snapshot = result.snapshot;
              const error = result.error ?? browserError(new Error("The browser step failed."));
              throw new BrowserToolError(error.code, error.message, error, error.recovery);
            }
          }
          const origin = page;
          if (["click", "press"].includes(action)) await new Promise(resolve => setTimeout(resolve, 200));
          check(write);
          const expectsNewTab = step.follow === "new_tab" || step.expect?.popup === true;
          if (expectsNewTab && !this.popups(origin, popupStart).length) {
            const deadline = Date.now() + Math.min(timeout, 10000);
            while (!this.popups(origin, popupStart).length && Date.now() < deadline) { check(write); await new Promise(resolve => setTimeout(resolve, 50)); }
          }
          const popups = this.popups(origin, popupStart);
          allPopups.push(...popups);
          report.observed = { popups, ...(from !== wc.getURL() ? { navigation: { from, to: wc.getURL() } } : {}) };
          if (expectsNewTab && !popups.length) throw new BrowserToolError("POPUP_TIMEOUT", "The action was dispatched but no new tab appeared.", { dispatched: true }, "Inspect the current page; do not repeat the action blindly.");
          if (popups.length && step.follow !== "same_tab" && (expectsNewTab || step.follow === "auto" || step.expect?.url || step.expect?.navigation)) {
            page = this.lookup(group, popups.at(-1)!.tab_id);
            this.selectAgentTab(group, page);
            // A popup belongs to the same action. Follow it without stealing user control.
            if (locked !== page) { unlock?.(); unlock = undefined; locked = undefined; }
          }
          if (step.expect && action !== "eval") {
            const outcome = await expectBrowser(page.view.webContents, step.expect as BrowserExpect, { from, popups: () => this.popups(origin, popupStart), network: () => networks,
              events:()=>origin.events.list(step.expect.event?.since ?? eventStart),networkState:()=>origin.events.network }, () => check(write), timeout);
            report.verification = outcome; verified = true;
          } else if (action === "assert") throw new BrowserToolError("INVALID_EXPECT", "An assert step requires expect.", {}, undefined, false);
          check(write);
          report.status = "completed";
          report.url_after = page.view.webContents.getURL();
          report.document_changed = from !== report.url_after;
        } catch (error) {
          const closed=signal.aborted && signal.reason instanceof BrowserToolError && signal.reason.code === "BROWSER_CLOSED";
          let failure = closed ? browserError(signal.reason) : locked?.manual
            ? browserError(new BrowserToolError("CONTROL_TAKEN", "The user paused browser operations.",
              { tab_id: locked.id,control:locked.control }, "Wait for control before continuing unfinished steps."))
            : browserError(error);
          if (failure.code === "browser_operation_timeout") {
            const health = await recoverBrowserRenderer(page.view.webContents,
              () => page.openedBy === "agent" && !page.manual && !page.userEdited && !page.events.dialog && !page.events.chooser, () => check());
            failure = { ...failure, renderer_alive: health ? health.recovered : true, ...health };
          }
          report.status = step?.optional && !["BROWSER_CLOSED", "CONTROL_TAKEN", "control_taken", "cancelled", "TAB_CLOSED"].includes(failure.code) ? "skipped" : "failed";
          report.error = failure;
          if (report.status === "failed") {
            const executed = reports.filter(item => item.status === "completed").map(item => item.step);
            return { ok: false, status: ["BROWSER_CLOSED", "CONTROL_TAKEN", "control_taken", "cancelled", "page_changed"].includes(failure.code) ? "paused" : "failed", verified: false,
              failed_step: index + 1, failedStep: index + 1, executed_steps: executed, executedSteps: executed,
              remaining_steps: steps.slice(index + 1).map((_item, offset) => index + offset + 2), remainingSteps: steps.slice(index + 1).map((_item, offset) => index + offset + 2),
              steps: reports, error: failure, control:failure.control, snapshot, popups: allPopups, tab_id: page.id, tabId: page.id, current_tab_id: group.agent, view_id: page.actions.viewId,
              recovery: "Completed and dispatched actions remain applied. Inspect the failed step before retrying it; resume only unfinished steps." };
          }
        } finally { removeNetwork(); }
      }
      return { ok: true, status: "completed", verified, steps: reports, popups: allPopups, tab_id: page.id, tabId: page.id,
        current_tab_id: group.agent, currentTabId: group.agent, url: page.view.webContents.getURL(), title: page.view.webContents.getTitle(), value, images,
        view_id: page.actions.viewId,
        ...(args.snapshot !== false && name === "browser_run" ? await (async () => {
          const snapshot = await page.actions.run({steps:[], snapshot:true}, () => check());
          return {content:snapshot.content,reads:snapshot.reads};
        })() : {}) };
    } finally {
      unlock?.();
      page.activity = undefined;
      this.present(page);
    }
  }

  private group(id: string, profile?:{profileId?:string;isolated?:boolean}): TabGroup {
    if (!/^[\w-]{1,160}$/.test(id)) throw Error("Invalid conversation");
    if (!this.window || this.window.isDestroyed())
      throw Error("Browser workbench is closed");
    let group = this.groups.get(id);
    if (!group) {
      const saved = this.savedWorkspaces.get(id);
      group = { id, tabs: new Map(), nextLabel: 0, name: saved?.name, source: saved?.source ?? "session",parentId:saved?.parentId,profileId:saved?.profileId??profile?.profileId,isolated:saved?.isolated??profile?.isolated,suspended:saved?.suspended || this.allWindowsStopped };
      this.groups.set(id, group);
      if (saved) {
        for (const tab of saved.tabs) {
          const page = this.createTab(group, group.source === "window", undefined, tab);
          page.restoring = this.restoreTab(page, tab).finally(() => {
            page.restoring = undefined;
          });
        }
        group.viewed = saved.viewed;
        group.agent = saved.agent;
      }
    }
    if (!group.tabs.size) this.createTab(group, group.source === "window");
    return group;
  }

  private lookup(group: TabGroup, id: unknown): TaskPage {
    const page = typeof id === "string" ? group.tabs.get(id) ?? [...group.tabs.values()].find(page=>page.label === id) : undefined;
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
        partition: group.profileId ? (group.isolated?"":"persist:")+"nautilo-profile-"+group.profileId : this.partition,
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
    this.configureProfile(wc.session);
    const id = saved?.id ?? randomUUID();
    const page: TaskPage = {
      id,
      view,
      actions: new BrowserActions(wc, id,()=>{
        if(this.isVisible(page) || this.inputSurface === page)return false;
        this.parkingWindow().contentView.addChildView(page.view);
        this.inputSurface=page;
        return true;
      }),
      events: new BrowserPageEvents(wc),
      manual: manual || !!group.suspended,
      revision: 0,
      busy: false,
      writer: Promise.resolve(),
      queued: 0,
      saved,
      controlKey: randomUUID(),
      owner: group.suspended ? "stopped" : manual ? "user" : "ready",
      windowCloseOwner:group.suspended ? manual ? "user" : "ready" : undefined,
      control:group.suspended ? {kind:"windows_closed",at:new Date().toISOString()} : undefined,
      openedBy: saved ? "unknown" : manual ? "user" : "agent",
      label: "p" + ++group.nextLabel,
      userEdited: false,
      popups: [],
      openedAt: Date.now(),
      favicon: saved?.favicon,
    };
    group.tabs.set(page.id, page);
    // A new WebContents has no execution context until its first document.
    // Popup navigation is owned by Chromium; never replace it with about:blank.
    page.initializing=(async()=>{
      if(!wc.getURL()) {
        if(options)await browserDeadline(new Promise<void>(resolve=>wc.once("dom-ready",()=>resolve())),15000,"popup document","popup");
        else await wc.loadURL("about:blank");
      }
      await page.events.installDialogs();
    })();
    void page.initializing.catch(()=>{});
    group.viewed ??= page.id;
    group.agent ??= page.id;
    wc.once("destroyed", () => this.removeTab(group, page));
    wc.on("did-navigate", () => this.scheduleWorkspaces());
    wc.on("did-navigate-in-page", () => this.scheduleWorkspaces());
    wc.on("page-favicon-updated", (_event, urls) => {
      const current = wc.getURL();
      if (urls[0]) void browserFavicon(wc, urls[0]).then(icon => {
        if (!wc.isDestroyed() && wc.getURL() === current && icon) { page.favicon = icon; this.scheduleWorkspaces(); }
      });
    });
    wc.on("dom-ready", () => {
      forgetBrowserPresence(wc);
      forgetBrowserPointer(wc);
      this.present(page);
    });
    wc.on("input-event", (_event, input) => {
      if (!isBrowserAgentInput(wc) && ["mouseDown", "mouseWheel", "touchStart"].includes(input.type)) {
        if (input.type !== "mouseWheel") page.userEdited = true;
      }
    });
    wc.on("before-input-event", (event, input) => {
      if (isBrowserAgentInput(wc) || input.type !== "keyDown") return;
      if (input.alt && !input.control && !input.meta && input.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!input.isAutoRepeat) this.cycleWindows?.();
      } else if (!["Alt", "Control", "Shift", "Meta"].includes(input.key)) {
        page.userEdited = true;
      }
    });
    wc.on("will-navigate", (event, url) => {
      if (url.startsWith("nautilo-control://")) {
        event.preventDefault();
        const control = new URL(url);
        if (control.hostname === page.controlKey) {
          if (control.pathname === "/takeover") {page.control={kind:"takeover_button",at:new Date().toISOString()};this.changeControl(group, page, "user");}
          if (control.pathname === "/resume") this.changeControl(group, page, "agent");
          if (control.pathname === "/stop") {
            page.control={kind:"stop_button",at:new Date().toISOString()};
            this.changeControl(group, page, "stopped");
          }
        }
      }
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (url !== "about:blank" && !/^(https?:\/\/|file:\/\/|blob:)/i.test(url))
        return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: (options) => {
          const child = this.createTab(group, page.manual, options);
          child.openedBy = page.manual ? "user" : "agent";
          child.owner = page.owner;
          child.browserTask=page.browserTask ? {...page.browserTask} : undefined;
          page.popups.push(child);
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
    await page.initializing;
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
      session_id: group.id,
      workspaceName: this.spaceName(group.id),
      workspaceSource: group.source,
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
    if (group.suspended) throw this.stoppedError(group);
    if (args.action === "new") {
      const url = args.url === undefined ? undefined : webUrl(args.url);
      const page = this.createTab(group);
      this.selectAgentTab(group, page);
      await page.initializing;
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
      if (page.openedBy !== "agent" || page.userEdited)
        throw new BrowserToolError("TAB_OWNERSHIP", "This tab was created, restored or edited by the user.",
          { tab_id: page.id }, "Leave this tab open. The user can close it from the browser toolbar.", false);
      if (page.manual || page.busy)
        throw Error("Tab is in use.");
      this.closeTab(group, page);
    } else throw Error("Unknown tab action.");
    return this.tabList(group);
  }

  private removeTab(group: TabGroup, page: TaskPage) {
    if(this.inputSurface === page)this.inputSurface=undefined;
    if (!group.tabs.has(page.id)) return;
    const pages = [...group.tabs.values()];
    const index = pages.indexOf(page);
    const neighbor = pages[index + 1] ?? pages[index - 1];
    page.revision++;
    if (this.isVisible(page)) this.hide(group);
    group.tabs.delete(page.id);
    for (const parent of group.tabs.values()) parent.popups = parent.popups.filter(child => child !== page);
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
      this.checkBrowserRequest(signal);
      if (group.suspended || page.owner === "stopped")
        throw this.stoppedError(group,page);
      if (!group.tabs.has(page.id) || page.view.webContents.isDestroyed())
        throw new BrowserToolError("tab_closed", "The queued tab was closed.", {
          tabId: page.id,
        });
      if (
        !page.manual &&
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
        this.checkBrowserRequest(signal);
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
      page.owner = "agent";
      this.noteBrowserTask(group,page);
      this.present(page);
      return () => {
        page.busy = false;
        page.activity = undefined;
        if(!page.manual)page.owner=page.browserTask ? "agent" : "ready";
        this.present(page);
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
      capabilities:browserCapabilities,
      ...describe(page),
      loading: wc.isLoading(),
      control:
        page.manual
          ? "user"
          : page.busy || page.browserTask
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
    for(const child of new Set([...this.savedWorkspaces.values(),...this.groups.values()].filter(group=>group.parentId === id).map(group=>group.id)))this.release(child);
    this.savedWorkspaces.delete(id);
    this.previews?.forget(id);
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
    ipcMain.handle("browser:profile",async (event,command:string,input:any={})=>{
      const win=BrowserWindow.fromWebContents(event.sender);
      if(!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || (win !== this.window && !this.overviewWindows.has(win)))throw Error("Browser overview required");
      if(command === "login") {
        const url=webUrl(input.url),group=this.group("browser-window-"+randomUUID());
        group.source="window";
        const page=this.lookup(group,group.viewed);page.openedBy="user";
        this.changeControl(group,page,"user");
        await this.openWindow?.(group.id);
        await page.initializing;
        await browserDeadline(page.view.webContents.loadURL(url),30000,"open login page","navigation");
        return {ok:true,space_id:group.id,handed_off:true};
      }
      return browserLogin(this.profile!,command,input);
    });
    ipcMain.handle("browser:spaces", async (event, command: string, input: BrowserSpacesInput = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame || (win !== this.window && !this.overviewWindows.has(win)))
        throw Error("Browser overview required");
      if (command === "list") return this.spaces(input);
      const name = typeof input.name === "string" ? input.name.trim() : undefined;
      if (input.name !== undefined && (typeof input.name !== "string" || !name || name.length > 120)) throw Error("Window name must contain 1–120 characters");
      if (command === "create") {
        const id = "browser-window-" + randomUUID();
        const group = this.group(id);
        group.source = "window";
        group.name = name;
        const first = this.lookup(group, group.viewed);
        first.openedBy = "user";
        this.changeControl(group, first, "user");
        this.scheduleWorkspaces();
        return { ...await this.spaces(), createdId: id };
      }
      if (command === "rename") {
        if (!input.id || (!this.groups.has(input.id) && !this.savedWorkspaces.has(input.id)) || !name) throw Error("Unknown browser window");
        const group = this.groups.get(input.id), saved = this.savedWorkspaces.get(input.id);
        if (group) group.name = name;
        if (saved) saved.name = name;
        this.scheduleWorkspaces();
        return this.spaces();
      }
      throw Error("Unknown browser window command");
    });
    ipcMain.handle(
      "browser:panel",
      async (event, id: string, command: string, value?) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (
          !win ||
          win.webContents !== event.sender ||
          (win !== this.window && win !== this.browserHost && win !== this.panelWindows.get(id)) ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw Error("Workbench required");
        const tabId = value?.tabId;
        if (command === "hide")
          return this.hide(this.groups.get(id), tabId, win);
        if(win === this.browserHost && this.hostSpace !== id && command !== "state") {
          if(command === "layout")return;
          throw Error("Select this browser space before changing its tabs");
        }
        if (
          command === "layout" &&
          this.panelWindows.has(id) &&
          win !== this.panelWindows.get(id)
        )
          return;
        if (command === "release") return this.release(id);
        const group = this.group(id);
        if(command === "preview") {
          const page=this.lookup(group,group.viewed);
          const image=await this.previews?.capture(id,page.view.webContents,page.id+"/"+page.view.webContents.getURL());
          return {...describe(page),image};
        }
        if (command === "overview") {
          this.hide(group, undefined, win);
          const thumbnails: Record<string, string> = {};
          // Capture only when the overview is requested, never in the normal state poll.
          const candidates = [...group.tabs.values()].filter(page => page.view.webContents.getURL() && page.view.webContents.getURL() !== "about:blank");
          for (let start = 0; start < candidates.length; start += 3) {
            await Promise.all(candidates.slice(start, start + 3).map(async page => {
              try {
                const image = await browserDeadline(page.view.webContents.capturePage(), 1000, "tab thumbnail");
                if (!image.isEmpty()) thumbnails[page.id] = "data:image/jpeg;base64," + image.resize({ width: 640 }).toJPEG(65).toString("base64");
              } catch { /* An unavailable page retains a URL tile; don't reload it for a preview. */ }
            }));
          }
          const current = this.lookup(group, group.viewed);
          return { ...describe(current), tabId: current.id, ...this.tabList(group), thumbnails };
        }
        if (command === "new") this.showTab(group, this.createTab(group, true));
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
            if(manual)page.control={kind:"takeover_button",at:new Date().toISOString()};
            this.changeControl(group, page, manual ? "user" : "agent");
          } else if (command === "home") {
            this.changeControl(group, page, "user");
            await wc.loadURL("about:blank");
          } else if (command === "open") {
            const url = webUrl(value?.url ?? value);
            this.changeControl(group, page, "user");
            await page.initializing;
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
            this.present(page);
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
    for(const profile of this.profileFiles.keys())profile.cookies.removeListener("changed",this.onCookiesChanged);
    await this.flushStorage();
  }
}
