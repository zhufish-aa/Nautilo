import type { DesktopAttachment } from "../main/attachment-file-service";

export interface BrowserIssue {
  id: string;
  kind: "console" | "network";
  time: number;
  message: string;
  source?: string;
  stack?: string;
  method?: string;
  status?: number;
  duration?: number;
  warning?: boolean;
}

export interface BrowserTabSignals {
  loading: boolean;
  progress: number;
  errors: number;
  unread: number;
}

export interface BrowserViewport {
  width: number;
  height: number;
  scale: number;
}

export interface BrowserShellState {
  tabs: Record<string, BrowserTabSignals>;
  issues: BrowserIssue[];
  pinned: boolean;
}

export interface BrowserElementContext {
  id: string;
  url: string;
  title?: string;
  tag: string;
  label: string;
  selector: string;
  dimensions: string;
  textPreview?: string;
  html: string;
  styles?: string;
  componentName?: string;
  screenshotPath?: string;
}

export interface BrowserDraft {
  sessionId?: string;
  text?: string;
  attachment?: DesktopAttachment;
  element?: BrowserElementContext;
}

export interface BrowserOmniboxData {
  ports: number[];
  tabs: {spaceId: string; tabId: string; title: string; url: string}[];
  history: {title: string; url: string}[];
}

export interface BrowserShellRequests {
  state: {input:{spaceId:string; tabId?:string}; result:BrowserShellState};
  omnibox: {input:{probe:boolean}; result:BrowserOmniboxData};
  pin: {input:{spaceId:string; pinned:boolean}; result:boolean};
  close: {input:{ids:string[]; blankOnly?:boolean}; result:string[]};
  locate: {input:{spaceId:string}; result:void};
  capture: {input:{spaceId:string; tabId:string}; result:boolean};
  pick: {input:{spaceId:string; tabId:string; mode:"element"|"region"}; result:boolean};
  cancel: {input:{spaceId:string; tabId:string}; result:void};
  clear: {input:{spaceId:string; tabId:string; remove:boolean}; result:void};
  draft: {input:{spaceId:string; tabId:string; issueIds:string[]}; result:boolean};
  viewport: {input:{spaceId:string; tabId:string; device:BrowserViewport|null}; result:void};
  reload: {input:{spaceId:string; tabId:string; mode:"stop"|"hard"}; result:void};
  devtools: {input:{spaceId:string; tabId:string}; result:void};
}

export type BrowserShellCommand = keyof BrowserShellRequests;
export type BrowserShellBridge = <Command extends BrowserShellCommand>(
  command: Command, input: BrowserShellRequests[Command]["input"]
) => Promise<BrowserShellRequests[Command]["result"]>;
export type BrowserShellChange = {spaceId:string; focusAddress?:boolean};
