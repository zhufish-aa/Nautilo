import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Box, Folder, Users, ListChecks, Clock } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getBridge } from "../../lib/bridge";
import { useProjectsStore } from "../../stores/projects";
import { useAgentsStore } from "../../stores/agents";
import { useTeamsStore } from "../../stores/teams";
import { useSessionsStore } from "../../stores/sessions";
import { SessionModelControl, type ComposerConfiguration } from "./SessionModelControl";
import { useProvidersStore } from "../../stores/providers";
import { permissionModesFor } from "../../lib/provider-catalog";
import { Composer } from "./Composer";
import { AddProjectDialog } from "../projects/AddProjectDialog";

/** No draft session is persisted until Send. Empty states link to real configuration. */
export function NewConversation({ mode = "code", onCreated }: { mode?: "code" | "work"; onCreated: (id: string) => void }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const location = useLocation();
  const [query] = useSearchParams();
  const projects = useProjectsStore((state) => state.projects);
  const instances = useAgentsStore((state) => state.instances);
  const teams = useTeamsStore((state) => state.teams);
  const requestedProject = query.get("project") ?? "";
  const [projectId, setProjectId] = useState(requestedProject);
  useEffect(() => setProjectId(requestedProject), [requestedProject]);
  const [instanceId, setInstanceId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [configuration, setConfiguration] = useState<ComposerConfiguration>({});
  const sessions = useSessionsStore((state) => state.sessions);
  const [addProject, setAddProject] = useState(false);
  useProvidersStore((state) => state.catalog);
  const available = instances.filter((instance) => instance.enabled);
  const project = projects.find((item) => item.id === (projectId || query.get("project"))) ?? projects[0];
  const instance = available.find((item) => item.id === instanceId) ?? available[0];
  const supportsPlan = instance ? permissionModesFor(instance.providerId).some((item) => item.value === "plan") : false;
  const canStart = Boolean(project && instance && getBridge());
  const create = (text: string): string | undefined => {
    if (!project || !instance || !getBridge()) return undefined;
    const session = useSessionsStore.getState().createSession({
      projectId: project.id,
      target: { type: "agent", instanceId: instance.id, teamId: teamId || undefined },
      title: text.trim().slice(0, 48) || (zh ? "新对话" : "New conversation"),
      mode,
      ...configuration
    });
    onCreated(session.id);
    return session.id;
  };
  return (
    <section className="new-conversation flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 pb-16 pt-12" aria-label={zh ? "新对话" : "New conversation"}>
      <div className="w-full max-w-3xl">
        <h1 className="mb-9 text-center text-[clamp(24px,3vw,32px)] font-medium tracking-tight">{zh ? "我们要做什么？" : "What shall we work on?"}</h1>
        <Composer draftId="new:conversation" running={false} disabled={!canStart} onCreateSession={create} starterControls={
          <>
            <label data-tour="session-agent" className="starter-picker" title={zh ? "模型与 Agent" : "Agent"}>
              <Box className="h-4 w-4" aria-hidden />
              <select aria-label={zh ? "选择 Agent" : "Choose an agent"} value={instance?.id ?? ""} onChange={(event) => { setInstanceId(event.target.value); setConfiguration({}); }}>

          {!available.length && <option value="">{zh ? "选择 Agent" : "Choose agent"}</option>}
                {available.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
              </select>
            </label>
            {instance && <SessionModelControl draft={{ instanceId: instance.id, configuration, onChange: (patch) => setConfiguration((current) => ({ ...current, ...patch })), onInstanceChange: (id) => { setInstanceId(id); setConfiguration({}); } }} />}
            {instance && <button type="button" disabled={!supportsPlan} aria-pressed={(configuration.permissionMode ?? instance.permissionMode) === "plan"} title={supportsPlan ? (zh ? "计划模式" : "Plan mode") : (zh ? "当前 Agent 未提供原生计划模式" : "This agent does not expose a native plan mode")} onClick={() => setConfiguration((current) => ({ ...current, permissionMode: (current.permissionMode ?? instance.permissionMode) === "plan" ? "default" : "plan" }))} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-ink-2 hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-100 disabled:text-ink-3 disabled:hover:bg-transparent"><ListChecks className="h-4 w-4" aria-hidden />Plan</button>}

          </>
        } />
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.length > 0 ? <label data-tour="session-project" className="starter-picker flex min-h-11 rounded-xl border border-line px-4 text-ink-2">
            <Folder className="h-4 w-4" aria-hidden />
            <select aria-label={zh ? "选择项目" : "Choose project"} value={project?.id ?? ""} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label> : <button className="text-sm text-ink-2 hover:text-ink" onClick={() => setAddProject(true)}>{zh ? "添加项目" : "Add project"}</button>}
          <label className="starter-picker flex min-h-11 rounded-xl border border-line px-4 text-ink-2"><Users className="h-4 w-4" aria-hidden /><select aria-label={zh ? "协作团队" : "Collaboration team"} value={teamId} onChange={(event) => setTeamId(event.target.value)}><option value="">{zh ? "主助手" : "Main assistant"}</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
          {!available.length && <button className="text-sm text-ink-2 hover:text-ink" onClick={() => navigate("/settings?section=agents", { state: { returnTo: location.pathname + location.search } })}>{zh ? "配置 Agent" : "Set up an agent"}</button>}
          {!getBridge() && <p role="status" className="text-sm text-ink-3">{zh ? "请在桌面应用中连接 Agent" : "Connect an agent in the desktop app"}</p>}
        </div>
        {sessions.some((session) => session.status !== "archived") && <section className="mt-9" aria-label={zh ? "最近任务" : "Recent tasks"}>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-2"><Clock className="h-4 w-4" aria-hidden />{zh ? "最近任务" : "Recent tasks"}</h2>
          {sessions.filter((session) => session.status !== "archived").slice(0, 3).map((session) => <button key={session.id} type="button" onClick={() => onCreated(session.id)} className="flex w-full items-center gap-3 border-t border-line px-3 py-3 text-left text-sm hover:bg-card-hover"><span className="min-w-0 flex-1 truncate">{session.title}</span><span className="max-w-32 truncate text-xs text-ink-3">{projects.find((item) => item.id === session.projectId)?.name}</span></button>)}
        </section>}
      </div>
      <AddProjectDialog open={addProject} onOpenChange={setAddProject} />
    </section>
  );
}
