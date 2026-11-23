import { BrowserWindow, app, ipcMain, type Rectangle, type WebContents } from "electron";
import { Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { importClipboardAttachment } from "./attachment-file-service";
import { BrowserDiagnostics } from "./browser-diagnostics";
import { cancelBrowserPicker, pickBrowserRegion } from "./browser-picker";
import { isBrowserAgentInput } from "./browser-protocol";
import { browserDeadline } from "./browser-errors";
import type { BrowserSpace } from "../shared/browser-spaces";
import type { BrowserDraft, BrowserOmniboxData, BrowserShellChange, BrowserShellCommand, BrowserViewport } from "../shared/browser-shell";

const localPorts = [3000,3001,4173,5173,5174,8000,8080,8081,8888,9000];
const isPage = (url:string) => !!url && url !== "about:blank";

type ShellTab = {id:string; wc:WebContents; busy:boolean};
interface ShellContext {
  trusted(win:BrowserWindow):boolean;
  workbench():BrowserWindow|undefined;
  overview():BrowserWindow|undefined;
  canUse(win:BrowserWindow,spaceId:string):boolean;
  visible(spaceId:string,tabId:string,win:BrowserWindow):boolean;
  tabs(spaceId:string):ShellTab[];
  target(spaceId:string,tabId?:string):ShellTab;
  boundSession(spaceId:string):string|undefined;
  spaces():Promise<{spaces:BrowserSpace[]}>;
  catalog():BrowserOmniboxData["tabs"];
  close(id:string):void;
}

export class BrowserShell {
  readonly diagnostics = new BrowserDiagnostics();
  private readonly history = new Map<string,{url:string;title:string}>();
  private readonly busyPickers = new WeakSet<WebContents>();
  private readonly metrics = new WeakMap<WebContents,BrowserViewport>();
  private readonly devTools = new WeakMap<WebContents,BrowserWindow>();
  private readonly changed = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private ports: number[] = [];
  private probe?: Promise<number[]>;

  constructor(private readonly context:ShellContext) {}

  observe(spaceId:string, page:WebContents, host:() => BrowserWindow|undefined) {
    this.diagnostics.observe(page,() => this.notify(spaceId));
    const remember = () => {
      const url = page.getURL();
      if (!isPage(url)) return;
      this.history.delete(url);
      this.history.set(url,{url,title:page.getTitle() || url});
      if (this.history.size > 100) this.history.delete(this.history.keys().next().value!);
    };
    page.on("did-navigate",remember);
    page.on("did-navigate-in-page",(_event,_url,mainFrame)=>{if (mainFrame) remember();});
    page.on("page-title-updated", (_event,title) => {
      const url = page.getURL();
      if (this.history.has(url)) this.history.set(url,{url,title});
    });
    page.on("before-input-event",(event,input) => {
      if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt || input.key.toLowerCase() !== "l" || isBrowserAgentInput(page)) return;
      const win = host();
      if (!win || win.isDestroyed()) return;
      event.preventDefault();
      win.webContents.focus();
      win.webContents.send("browser:shell-changed",{spaceId,focusAddress:true} satisfies BrowserShellChange);
    });
  }

  notify(spaceId:string) {
    this.changed.add(spaceId);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      for (const win of [this.context.workbench(),this.context.overview()]) {
        if (!win || win.isDestroyed()) continue;
        for (const id of this.changed) win.webContents.send("browser:shell-changed",{spaceId:id} satisfies BrowserShellChange);
      }
      this.changed.clear();
    }, 80);
  }

  hidden(page:WebContents) {
    if (this.busyPickers.has(page)) void cancelBrowserPicker(page).catch(() => {});
    if (this.metrics.has(page)) void this.viewport(page,null).catch(() => {});
  }

  cancelPicker(page:WebContents) {
    if (this.busyPickers.has(page)) void cancelBrowserPicker(page).catch(() => {});
  }

  private async scanPorts() {
    this.probe ??= Promise.all(localPorts.map(port => new Promise<number | undefined>(resolve => {
      const socket = new Socket();
      const finish = (listening:boolean) => {socket.destroy();resolve(listening ? port : undefined);};
      socket.setTimeout(150,() => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.connect(port,"127.0.0.1");
    }))).then(ports => ports.filter((port):port is number => port !== undefined)).finally(() => {this.probe = undefined;});
    this.ports = await this.probe;
    return this.ports;
  }

  private sendDraft(draft:BrowserDraft) {
    const win = this.context.workbench();
    if (!win || win.isDestroyed()) throw Error("请先打开 Nautilo 工作台");
    win.webContents.send("browser:draft",draft);
  }

  private async capture(page:WebContents, rect?:Rectangle) {
    const capture = () => browserDeadline(page.capturePage(rect,{stayAwake:true}),2500,"capture browser viewport");
    page.invalidate();
    let image = await capture();
    if (image.isEmpty()) {
      await wait(80);
      page.invalidate();
      image = await capture();
    }
    if (image.isEmpty()) throw Error("网页还没有可截取的画面");
    void page.executeJavaScriptInIsolatedWorld(1004,[{code:`(() => {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const flash=document.createElement("div");
      flash.setAttribute("data-nautilo-pointer","capture");
      flash.style.cssText="all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;background:rgba(255,255,255,.17)!important";
      document.documentElement.append(flash);
      const animation=flash.animate([{opacity:1},{opacity:0}],{duration:150});
      void animation.finished.finally(()=>flash.remove());
    })()`}]).catch(()=>{});
    return importClipboardAttachment(app.getPath("userData"),{name:"browser-"+Date.now()+".png",mimeType:"image/png",data:image.toPNG()});
  }

  private async viewport(page:WebContents, device:BrowserViewport|null) {
    if (!device && !this.metrics.has(page)) return;
    const api = page.debugger;
    if (!api.isAttached()) api.attach("1.3");
    if (device) {
      if (![device.width,device.height].every(value => Number.isInteger(value) && value >= 200 && value <= 1600) ||
          !Number.isFinite(device.scale) || device.scale <= 0 || device.scale > 1) throw Error("Invalid viewport dimensions");
      const last = this.metrics.get(page);
      if (last?.width === device.width && last.height === device.height && last.scale === device.scale) return;
      this.metrics.set(page,device);
      try {
        await api.sendCommand("Emulation.setDeviceMetricsOverride",{
          width:device.width,height:device.height,deviceScaleFactor:1,mobile:false,scale:device.scale,
          screenOrientation:{type:device.width > device.height ? "landscapePrimary" : "portraitPrimary",angle:device.width > device.height ? 90 : 0},
        });
      } catch (error) {
        if (this.metrics.get(page) === device) this.metrics.delete(page);
        throw error;
      }
    } else {
      this.metrics.delete(page);
      await api.sendCommand("Emulation.clearDeviceMetricsOverride");
    }
  }

  private toggleDevTools(page:WebContents) {
    const open = this.devTools.get(page);
    if (open) {open.destroy();return;}

    // The browsing profile blocks internal protocols, including devtools://.
    // Give Chromium's DevTools frontend its own window and session.
    const tools = new BrowserWindow({width:1040,height:730,show:false,title:"Nautilo DevTools",
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    this.devTools.set(page,tools);
    const show = () => {tools.show();tools.focus();};
    const destroy = () => {if (!tools.isDestroyed()) tools.destroy();};
    page.once("devtools-opened",show);
    page.once("devtools-closed",destroy);
    page.once("destroyed",destroy);
    tools.once("closed", () => {
      this.devTools.delete(page);
      page.removeListener("devtools-opened",show);
      page.removeListener("devtools-closed",destroy);
      page.removeListener("destroyed",destroy);
      if (!page.isDestroyed() && page.devToolsWebContents) page.closeDevTools();
    });
    try {
      page.setDevToolsWebContents(tools.webContents);
      page.openDevTools({mode:"detach"});
    } catch(error) {
      destroy();
      throw error;
    }
  }

  register() {
    ipcMain.handle("browser:shell", async (event, command:BrowserShellCommand, input) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame || !this.context.trusted(win))
        throw Error("Browser workbench required");
      if (command === "omnibox") return {
        ports:input.probe ? await this.scanPorts() : this.ports,
        tabs:this.context.catalog(),
        history:[...this.history.values()].reverse(),
      } satisfies BrowserOmniboxData;
      if (command === "close") {
        const ids = new Set<string>(input.ids);
        const {spaces} = await this.context.spaces();
        const result = spaces.filter(space => ids.has(space.id)
          && (!input.blankOnly || !space.loaded && space.status !== "running" && space.status !== "agent"))
          .map(space => space.id);
        for (const id of result) this.context.close(id);
        return result;
      }
      const {spaceId,tabId} = input;
      const sessionId = this.context.boundSession(spaceId);
      if (command === "locate") {
        const workbench = this.context.workbench();
        if (!workbench || !sessionId) throw Error("此浏览窗口没有关联会话");
        if (workbench.isMinimized()) workbench.restore();
        workbench.show();
        workbench.focus();
        workbench.webContents.send("browser:draft",{sessionId} satisfies BrowserDraft);
        return;
      }
      if (!this.context.canUse(win,spaceId)) throw Error("Select this browser space first");
      if (command === "pin") {
        if (win !== this.context.overview()) throw Error("Separate browser window required");
        const pinned = input.pinned === true;
        win.setAlwaysOnTop(pinned,"floating");
        if (win.isAlwaysOnTop() !== pinned) {
          // Windows can retain a failed z-order request until the level is reset.
          win.setAlwaysOnTop(!pinned,"floating");
          await wait(60);
          if (win.isDestroyed()) return false;
          win.setAlwaysOnTop(pinned,"floating");
        }
        return win.isAlwaysOnTop();
      }
      if (command === "state") {
        const tabs = this.context.tabs(spaceId);
        const current = tabs.find(tab => tab.id === tabId);
        return {tabs:Object.fromEntries(tabs.map(tab => [tab.id,this.diagnostics.signals(tab.wc)])),
          issues:current ? this.diagnostics.issues(current.wc) : [], pinned:win.isAlwaysOnTop()};
      }
      const {wc,busy} = this.context.target(spaceId,tabId);
      if (command === "clear") return this.diagnostics.markRead(wc,input.remove === true);
      if (command === "cancel") return cancelBrowserPicker(wc);
      if (command === "viewport") return this.viewport(wc,input.device);
      if (command === "reload") {
        if (input.mode === "stop") wc.stop();
        else wc.reloadIgnoringCache();
        return;
      }
      if (command === "devtools") return this.toggleDevTools(wc);
      if (command === "draft") {
        const ids = new Set<string>(input.issueIds);
        const issues = this.diagnostics.issues(wc).filter(issue => ids.has(issue.id));
        if (!issues.length) return false;
        const rows = issues.map(issue => issue.kind === "console"
          ? `- [${issue.warning ? "Warning" : "Error"}] ${issue.message}${issue.source ? "\n  " + issue.source : ""}${issue.stack ? "\n  " + issue.stack.replaceAll("\n","\n  ") : ""}`
          : `- ${issue.method} ${issue.status ?? "ERR"} ${issue.source}${issue.duration === undefined ? "" : " · " + Math.round(issue.duration) + " ms"}${issue.message === issue.source ? "" : " · " + issue.message}`);
        this.sendDraft({sessionId,text:`### 浏览器诊断\n\n页面：${wc.getURL()}\n\n${rows.join("\n")}\n\n请分析这些错误并修复相关问题。`});
        return true;
      }
      if (!this.context.visible(spaceId,tabId,win)) throw Error("请先显示要截取的网页");
      if (command === "capture") {
        this.sendDraft({sessionId,attachment:await this.capture(wc)});
        return true;
      }
      if (command !== "pick") throw Error("Unknown browser shell command");
      if (busy || this.busyPickers.has(wc)) throw Error("请先暂停 AI 操作，再选择网页区域");
      if (input.mode !== "element" && input.mode !== "region") throw Error("Invalid picker mode");
      this.busyPickers.add(wc);
      try {
        wc.focus();
        const selected = await pickBrowserRegion(wc,input.mode);
        if (!selected || !this.context.visible(spaceId,tabId,win)) return false;
        const scale = wc.getZoomFactor() * (this.metrics.get(wc)?.scale ?? 1);
        const rect = Object.fromEntries(Object.entries(selected.rect).map(([key,value])=>[key,Math.round(value*scale)])) as unknown as Rectangle;
        if (rect.width < 1 || rect.height < 1) return false;
        const text = selected.selector ? `### 网页元素\n\n页面：${wc.getURL()}\n选择器：${selected.selector}\n尺寸：${selected.dimensions}\n\n\`\`\`html\n${selected.html?.replaceAll("\`","&#96;")}\n\`\`\`` : undefined;
        this.sendDraft({sessionId,text,attachment:await this.capture(wc,rect)});
        return true;
      } finally { this.busyPickers.delete(wc); }
    });
  }
}
