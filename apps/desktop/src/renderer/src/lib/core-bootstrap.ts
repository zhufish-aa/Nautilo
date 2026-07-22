import { getBridge } from "./bridge";
import { hydrateWorkbenchSessions, resumeWorkbenchRuns } from "./orchestration-runtime";
import { useAgentsStore } from "../stores/agents";
import { useProjectsStore } from "../stores/projects";
import { useTeamsStore } from "../stores/teams";

let initialization: Promise<void> | undefined;

/** Core Daemon is the desktop renderer's only business-data source. */
export function initializeCoreState(): Promise<void> {
  if (!getBridge()) return Promise.resolve();
  initialization ??= (async () => {
    await Promise.all([
      useProjectsStore.getState().hydrate(),
      useAgentsStore.getState().hydrate(),
      useTeamsStore.getState().hydrate()
    ]);
    await hydrateWorkbenchSessions();
    await resumeWorkbenchRuns();
  })();
  return initialization;
}
