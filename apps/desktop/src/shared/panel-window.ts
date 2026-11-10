export interface PanelTarget {
  kind: "browser" | "browser-spaces" | "source-control";
  sessionId?: string;
  projectId?: string;
}
