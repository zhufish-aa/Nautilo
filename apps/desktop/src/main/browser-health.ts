import type { WebContents } from "electron";
import { browserCommand } from "./browser-protocol";
import { browserDeadline } from "./browser-errors";

/** Never retry the failed action. Recovery reloads only an unedited agent tab. */
export async function recoverBrowserRenderer(page: WebContents, allowReload: () => boolean, check: () => void) {
  const probe = async () => {
    try {
      check();
      await browserCommand(page, "Runtime.evaluate", { expression: "1", returnByValue: true, timeout: 3000 }, 3000);
      return true;
    } catch { return false; }
  };
  if (await probe()) return undefined;
  await new Promise(resolve => setTimeout(resolve, 500));
  if (await probe()) return undefined;
  let recovered = false;
  const reloadAllowed = allowReload();
  if (reloadAllowed) {
    check();
    try {
      // A synchronous page script can prevent reload from being serviced.
      // Only an unedited agent tab may have its stuck execution interrupted.
      await browserCommand(page,"Runtime.terminateExecution",{},1000).catch(()=>{});
      await browserCommand(page, "Page.stopLoading", {}, 1000).catch(() => {});
      check();
      if (!allowReload()) return { code: "RENDERER_UNRESPONSIVE", recovered: false, reload_allowed: false };
      let onReady!: () => void;
      const ready = new Promise<void>(resolve => { onReady = resolve; page.once("dom-ready", onReady); });
      try {
        page.reload();
        await browserDeadline(ready, 10000, "renderer recovery").catch(() => {});
      } finally { page.removeListener("dom-ready", onReady); }
      recovered = await probe();
    } catch { /* Preserve the failed receipt and never replay its action. */ }
  }
  return { code: "RENDERER_UNRESPONSIVE", recovered, reload_allowed: reloadAllowed,
    recovery: recovered ? "The renderer was reloaded once. Inspect the page; the failed action was not replayed." : "The renderer did not respond to two probes. No action was replayed. Preserve any user input before reloading manually." };
}
