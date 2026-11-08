export type HarnessPluginAction = "install" | "remove" | "enable" | "disable";

export type HarnessPluginOperation =
  | { action: "list" }
  | { action: HarnessPluginAction; id: string }
  | { action: "install"; spec: string };

export interface HarnessPluginItem {
  id: string;
  name: string;
  version?: string | null;
  description?: string | null;
  source?: string | null;
  installed: boolean;
  enabled?: boolean;
  actions: HarnessPluginAction[];
}

export interface HarnessPluginInventory {
  items: HarnessPluginItem[];
  installBySpec?: boolean;
}

export interface HarnessPluginChange {
  application: "applied" | "restart-required" | "overridden";
}
