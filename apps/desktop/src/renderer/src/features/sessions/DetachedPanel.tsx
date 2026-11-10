import { getBridge } from "../../lib/bridge";
import { BrowserHost } from "./BrowserHost";
import { SourceControlDrawer } from "./SourceControlDrawer";
import type { PanelTarget } from "../../../../shared/panel-window";

export default function DetachedPanel({ target }: { target: PanelTarget }) {
  const close = () => {
    void getBridge()?.window.close();
  };
  return (
    <main className="detached-workspace-panel">
      {target.kind === "browser-spaces" || target.kind === "browser" ? (
        <BrowserHost initialTarget={target}/>
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
