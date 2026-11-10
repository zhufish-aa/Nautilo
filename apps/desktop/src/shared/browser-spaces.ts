export interface BrowserSpace {
  id: string;
  name: string;
  source: "session" | "window";
  tabCount: number;
  selectedTabId?: string;
  title: string;
  url: string;
  open: boolean;
  active: boolean;
  status: "running" | "agent" | "user" | "stopped" | "ready";
  preview?: string;
}

export interface BrowserSpacesState {
  spaces: BrowserSpace[];
  createdId?: string;
}

export interface BrowserSpacesInput {
  id?: string;
  name?: string;
  previews?: boolean;
  ids?: string[];
}
