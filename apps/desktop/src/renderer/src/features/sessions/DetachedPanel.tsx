import { getBridge } from "../../lib/bridge";
import { BrowserDrawer } from "./BrowserDrawer";
import { SourceControlDrawer } from "./SourceControlDrawer";
import type { PanelTarget } from "../../../../shared/panel-window";

export default function DetachedPanel({ target }: { target: PanelTarget }) {
  const close = () => {
    void getBridge()?.window.close();
  };
  return (
    <main className="detached-workspace-panel">
      {target.kind === "browser" && target.sessionId ? (
        <BrowserDrawer sessionId={target.sessionId} onClose={close} />
      ) : (
        <SourceControlDrawer
          open
          sessionId={target.sessionId}
          projectId={target.projectId}
          onClose={close}
        />
      )}
    </main>
  );
}
