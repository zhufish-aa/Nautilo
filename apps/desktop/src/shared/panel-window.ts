export interface PanelTarget {
  kind: "browser" | "source-control";
  sessionId?: string;
  projectId?: string;
}
