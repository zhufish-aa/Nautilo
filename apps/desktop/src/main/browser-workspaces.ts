import { readFile, writeFile, rename } from "node:fs/promises";
import { webUrl } from "./browser-actions";

export type SavedBrowserTab = {
  id: string;
  url: string;
  zoom: number;
  scrollX: number;
  scrollY: number;
};
export type SavedBrowserWorkspace = {
  id: string;
  viewed?: string;
  agent?: string;
  tabs: SavedBrowserTab[];
};

export async function loadBrowserWorkspaces(
  path: string,
): Promise<Map<string, SavedBrowserWorkspace>> {
  const result = new Map<string, SavedBrowserWorkspace>();
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.workspaces))
      throw Error("Unsupported browser workspace file");
    for (const workspace of data.workspaces) {
      if (
        typeof workspace.id !== "string" ||
        !/^\w[\w-]{0,159}$/.test(workspace.id) ||
        !Array.isArray(workspace.tabs)
      )
        continue;
      const tabs: SavedBrowserTab[] = [];
      for (const tab of workspace.tabs) {
        if (
          typeof tab.id !== "string" ||
          !/^[\w-]{1,160}$/.test(tab.id) ||
          tabs.some((existing) => existing.id === tab.id)
        )
          continue;
        try {
          const url = tab.url === "about:blank" ? tab.url : webUrl(tab.url);
          tabs.push({
            id: tab.id,
            url,
            zoom:
              Number.isFinite(tab.zoom) && tab.zoom >= 0.25 && tab.zoom <= 3
                ? tab.zoom
                : 1,
            scrollX: Number.isFinite(tab.scrollX)
              ? Math.max(0, tab.scrollX)
              : 0,
            scrollY: Number.isFinite(tab.scrollY)
              ? Math.max(0, tab.scrollY)
              : 0,
          });
        } catch {
          /* Invalid tab data cannot navigate the browser. */
        }
      }
      if (tabs.length)
        result.set(workspace.id, {
          id: workspace.id,
          tabs,
          viewed: tabs.some((t) => t.id === workspace.viewed)
            ? workspace.viewed
            : tabs[0].id,
          agent: tabs.some((t) => t.id === workspace.agent)
            ? workspace.agent
            : tabs[0].id,
        });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rename(path, path + ".invalid-" + Date.now()).catch(() => {});
      console.warn("Browser workspace data could not be restored.");
    }
  }
  return result;
}

export async function saveBrowserWorkspaces(
  path: string,
  workspaces: Map<string, SavedBrowserWorkspace>,
) {
  const temporary = path + ".tmp";
  await writeFile(
    temporary,
    JSON.stringify({ version: 1, workspaces: [...workspaces.values()] }),
    { mode: 0o600 },
  );
  await rename(temporary, path);
}
