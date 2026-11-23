import type { Session, WebContents } from "electron";
import type { BrowserIssue, BrowserTabSignals } from "../shared/browser-shell";

interface PageLog {
  rows: BrowserIssue[];
  requests: Map<number, number>;
  stacks: ConsoleStack[];
  read: number;
  count: number;
  completed: number;
  loading: boolean;
  progress: number;
  notify(): void;
}

type ConsoleStack = { message: string; source: string; stack: string };
type StackTrace = {
  description?: string;
  callFrames: { functionName: string; url: string; lineNumber: number; columnNumber: number }[];
  parent?: StackTrace;
};
type RuntimeEvent = {
  type?: string;
  args?: { value?: unknown; description?: string; unserializableValue?: string }[];
  stackTrace?: StackTrace;
  exceptionDetails?: { text: string; exception?: { description?: string }; stackTrace?: StackTrace };
};
const consoleMessage = (message:string) => message.split("\n",1)[0].replace(/^Uncaught(?: \(in promise\))?\s*/i,"").trim();

export class BrowserDiagnostics {
  private readonly pages = new Map<number, PageLog>();
  private readonly profiles = new WeakSet<Session>();

  observe(page: WebContents, changed: () => void) {
    const log: PageLog = {rows:[],requests:new Map(),stacks:[],read:0,count:0,completed:0,loading:false,progress:0,notify:changed};
    const id = page.id;
    this.pages.set(id, log);
    page.on("console-message", (_event, level, message, line, source) => {
      const url = page.getURL();
      if (level < 2 || !url || url === "about:blank" || source?.startsWith("node:electron")) return;
      const location = source ? `${source}:${line}`.slice(0,1500) : undefined;
      const pending = log.stacks.findIndex(item => item.source === location && item.message === consoleMessage(message));
      const stack = pending >= 0 ? log.stacks.splice(pending,1)[0].stack : undefined;
      this.append(log,{kind:"console", time:Date.now(), message:message.slice(0,3000), source:location, stack, warning:level === 2});
    });
    page.on("did-start-navigation", (_details, _url, sameDocument, mainFrame) => {
      if (!mainFrame || sameDocument) return;
      log.rows.length = 0;
      log.stacks.length = 0;
      log.read = log.count;
      log.requests.clear();
      log.completed = 0;
      log.progress = .06;
      log.loading = true;
      log.notify();
    });
    page.on("did-start-loading", () => {
      log.loading = true;
      log.progress = Math.max(.06, log.progress);
      log.notify();
    });
    page.on("dom-ready", () => {
      if (!log.loading) return;
      log.progress = Math.max(.58, log.progress);
      log.notify();
    });
    page.on("did-stop-loading", () => {
      log.loading = false;
      log.progress = 1;
      log.notify();
    });
    page.once("destroyed", () => this.pages.delete(id));
    this.observeStacks(page,log);
    this.observeProfile(page.session);
  }

  private observeStacks(page:WebContents, log:PageLog) {
    const api = page.debugger;
    let enabled = false;
    const enable = () => {
      // Observe Runtime messages on the page's existing debugger. Never detach it.
      if (enabled || !api.isAttached()) return;
      enabled = true;
      void api.sendCommand("Runtime.enable").catch(() => {enabled=false;});
    };
    api.on("detach", () => {enabled=false;});
    api.on("message", (_event, method, event:RuntimeEvent) => {
      const exception = method === "Runtime.exceptionThrown" ? event.exceptionDetails : undefined;
      const consoleCall = method === "Runtime.consoleAPICalled" && ["error","warning","assert"].includes(event.type ?? "");
      if (!exception && !consoleCall) return;
      const trace = exception?.stackTrace ?? event.stackTrace;
      const origin = trace?.callFrames[0];
      if (!origin?.url) return;
      const frames: string[] = [];
      for (let parent = trace; parent && frames.length < 96; parent = parent.parent) {
        if (parent.description) frames.push("── " + parent.description);
        for (const frame of parent.callFrames)
          frames.push(`at ${frame.functionName || "(anonymous)"} (${frame.url}:${frame.lineNumber+1}:${frame.columnNumber+1})`);
      }
      const message = consoleMessage(exception?.exception?.description ?? exception?.text
        ?? (event.args ?? []).map(arg => arg.unserializableValue ?? arg.value ?? arg.description?.split("\n",1)[0] ?? "undefined").join(" "));
      const source = `${origin.url}:${origin.lineNumber+1}`.slice(0,1500);
      const stack = frames.join("\n").slice(0,12000);
      const issue = [...log.rows].reverse().find(item => item.kind === "console" && !item.stack && item.source === source
        && consoleMessage(item.message) === message);
      if (issue) {
        issue.stack = stack;
        log.notify();
      } else {
        log.stacks.push({message,source,stack});
        if (log.stacks.length > 50) log.stacks.shift();
      }
    });
    page.on("did-start-navigation", (_event,_url,sameDocument,mainFrame) => {
      if (mainFrame && !sameDocument) enable();
    });
    // The first desktop navigation can start before dom-ready. The page
    // initializer attaches the debugger as soon as the blank document exists.
    page.on("did-finish-load",enable);
  }

  private append(log:PageLog, issue:Omit<BrowserIssue,"id">) {
    log.rows.push({...issue,id:String(++log.count)});
    if (log.rows.length > 50) log.rows.shift();
    log.notify();
  }

  private observeProfile(profile: Session) {
    if (this.profiles.has(profile)) return;
    this.profiles.add(profile);
    const request = (details: Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails) => {
      const log = this.pages.get(details.webContentsId ?? -1);
      if (!log) return;
      const start = log.requests.get(details.id);
      if (log.requests.delete(details.id) && log.loading) {
        log.completed++;
        log.progress = Math.max(log.progress, Math.min(.94, .12 + .78 * log.completed / (log.completed + log.requests.size + 1)));
        log.notify();
      }
      const status = "statusCode" in details ? details.statusCode : undefined;
      if (status !== undefined ? status >= 400 : details.error && details.error !== "net::ERR_ABORTED") {
        this.append(log,{kind:"network", time:details.timestamp, message:status === undefined ? details.error : details.url.slice(0,2000), source:details.url.slice(0,2000),
          method:details.method, status, duration:start === undefined ? undefined : Math.max(0, details.timestamp - start)});
      }
    };
    profile.webRequest.onSendHeaders(details => {
      const log = this.pages.get(details.webContentsId ?? -1);
      if (!log) return;
      if (log.requests.size >= 1024) log.requests.delete(log.requests.keys().next().value!);
      log.requests.set(details.id, details.timestamp);
    });
    profile.webRequest.onCompleted(request);
    profile.webRequest.onErrorOccurred(request);
  }

  signals(page: WebContents): BrowserTabSignals {
    const log = this.pages.get(page.id);
    return {loading:log?.loading ?? false, progress:log?.progress ?? 0, errors:log?.rows.length ?? 0,
      unread:log?.rows.filter(issue => Number(issue.id) > log.read).length ?? 0};
  }

  issues(page: WebContents) {
    return this.pages.get(page.id)?.rows ?? [];
  }

  markRead(page: WebContents, remove: boolean) {
    const log = this.pages.get(page.id);
    if (!log) return;
    if (remove) log.rows.length = 0;
    log.read = log.count;
    log.notify();
  }
}
