import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Box, Folder, Settings2, Users, UserRound } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getBridge } from "../../lib/bridge";
import { useProjectsStore } from "../../stores/projects";
import { useAgentsStore } from "../../stores/agents";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { connectionSupportsAgent } from "../../lib/session-connections";
import { connectionModelCatalog, hasConfiguredConnectionModels, resolveDraftConnectionConfiguration } from "../../lib/connection-models";
import { useTeamsStore } from "../../stores/teams";
import { useSessionsStore } from "../../stores/sessions";
import { SessionModelControl, type ComposerConfiguration } from "./SessionModelControl";
import { useProvidersStore } from "../../stores/providers";
import { permissionModesFor } from "../../lib/provider-catalog";
import { SelectField } from "../../components/ui/Select";
import { PermissionModeSelect } from "./PermissionModeSelect";
import { Composer } from "./Composer";
import { HarnessModeControl } from "./HarnessModeControl";
import { AddProjectDialog } from "../projects/AddProjectDialog";
import { useSurfaceEntrance } from "../../lib/ui-motion";

/** A draft becomes a real conversation only when the first message is sent. */
export function NewConversation({ mode = "code", onCreated, active = true }: {
  mode?: "code" | "work";
  onCreated: (id: string) => void;
  active?: boolean;
}): JSX.Element {
  const entranceRef = useSurfaceEntrance<HTMLDivElement>("new-conversation", active);
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const location = useLocation();
  const [query] = useSearchParams();
  const projects = useProjectsStore((state) => state.projects);
  const instances = useAgentsStore((state) => state.instances);
  const connections = useConnectionsStore((state) => state.connections);
  const connectionCatalogs = useConnectionsStore((state) => state.modelCatalogs);
  const hydrateConnections = useConnectionsStore((state) => state.hydrate);
  useEffect(() => { void hydrateConnections(); }, [hydrateConnections]);
  const teams = useTeamsStore((state) => state.teams);
  const requestedProject = query.get("project") ?? "";
  const [projectId, setProjectId] = useState(requestedProject);
  const [instanceId, setInstanceId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [configuration, setConfiguration] = useState<ComposerConfiguration>({});
  const [addProject, setAddProject] = useState(false);
  useEffect(() => setProjectId(requestedProject), [requestedProject]);
  useProvidersStore((state) => state.catalog);

  const available = instances.filter((instance) => instance.enabled && instance.configurationKind === "harness");
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const instance = available.find((item) => item.id === instanceId) ?? available[0];
  const permissionModes = instance ? permissionModesFor(instance.providerId) : [];
  const compatibleConnections = instance ? connections.filter((connection) => connectionSupportsAgent(connection, instance)) : [];
  const connection = compatibleConnections.find((item) => item.id === configuration.connectionId);
  const discoveredCatalog = connection ? connectionCatalogs[connectionModelKey(connection.id, connection.revision)] : undefined;
  const accountCatalog = connection ? connectionModelCatalog(connection, discoveredCatalog) : undefined;
  const effectiveConfiguration = connection ? resolveDraftConnectionConfiguration(configuration, connection, discoveredCatalog) : configuration;
  const selectedModel = accountCatalog?.models.find(item => item.id === effectiveConfiguration.model)?.id;
  const team = teams.find((item) => item.id === teamId);
  const enabledMembers = team?.members.filter((member) => member.enabled) ?? [];
  const teamReady = !team || (enabledMembers.length > 0 && enabledMembers.every((member) => {
    const harness = available.find((item) => item.id === member.agentInstanceId);
    const source = connections.find((item) => item.id === member.connectionId);
    return harness && source && connectionSupportsAgent(source, harness);
  }));
  useEffect(() => {
    if (!configuration.connectionId && compatibleConnections.length === 1) {
      const only = compatibleConnections[0]!;
      setConfiguration((current) => ({ ...current, connectionId: only.id, connectionRevision: only.revision }));
    }
  }, [instance?.id, configuration.connectionId, compatibleConnections.length, compatibleConnections[0]?.id]);
  const blockingReason = !getBridge() ? (zh ? "请在桌面应用中连接 Agent。" : "Connect an agent in the desktop app.")
    : !project ? (zh ? "选择一个项目后即可发送。" : "Choose a project to send your message.")
    : !instance ? (zh ? "请先在设置中安装并启用一个 Harness。" : "Install and enable a harness in settings first.")
    : !connection ? configuration.connectionId
      ? (zh ? "所选供应商与当前 Harness 不兼容或已停用，请重新选择。" : "The selected provider is incompatible with this harness or disabled. Choose another connection.")
      : (zh ? "请选择供应商或登录账号，然后选择模型。" : "Choose a provider or login account, then select a model.")
    : connection.kind === "api" && connection.hasCredential === false ? (zh ? "这个供应商尚未保存 API Key，请在供应商设置中补充。" : "This provider has no saved API key. Add it in provider settings.")
    : !teamReady ? (zh ? "团队成员尚未配置兼容的 Harness 与供应商。" : "Configure a compatible harness and connection for each team member.")
    : !selectedModel && hasConfiguredConnectionModels(connection) ? (zh ? "请在供应商设置中保存并启用一个模型。" : "Save and enable a model in provider settings.")
    : undefined;
  const canStart = !blockingReason;
  const openAgentSettings = (): void => {
    navigate("/settings?section=agents", { state: { returnTo: location.pathname + location.search } });
  };
  const create = (text: string): string | undefined => {
    if (!canStart || !project || !instance || !connection || !getBridge()) return undefined;
    const session = useSessionsStore.getState().createSession({
      projectId: project.id,
      target: { type: "agent", instanceId: instance.id, teamId: teamId || undefined },
      title: text.trim().slice(0, 48) || (zh ? "新对话" : "New conversation"),
      mode,
      ...effectiveConfiguration,
      model: selectedModel,
      connectionId: connection.id,
      connectionRevision: connection.revision
    });
    onCreated(session.id);
    return session.id;
  };

  return (
    <section className="new-conversation" aria-label={zh ? "新对话" : "New conversation"}>
      <header className="new-conversation-header">
        <h1>{zh ? "新建任务" : "New task"}</h1>
        {project && <span className="workspace-project-name"><Folder size={14} />{project.name}</span>}
        <button type="button" onClick={openAgentSettings} aria-label={zh ? "助理设置" : "Assistant settings"} title={zh ? "助理设置" : "Assistant settings"}><Settings2 size={16} /></button>
      </header>
      <div ref={entranceRef} className="new-conversation-body">
        <div className="new-conversation-start">
        <div className="new-conversation-welcome">
          <h2>{zh ? "今天有什么可以帮你？" : "How can I help today?"}</h2>
          <p>{zh ? "写代码、整理文档，或一起解决一个问题。" : "Write code, organize documents, or work through a problem together."}</p>
        </div>
      <div className="new-conversation-dock">
        <div className="starter-context">
          {projects.length ? <label className="starter-context-picker" data-tour="session-project">
            <Folder size={14} aria-hidden />
            <SelectField aria-label={zh ? "选择项目" : "Choose project"} value={project?.id} onValueChange={setProjectId} options={projects.map((item) => ({ value: item.id, label: item.name }))} className="context-select" />
          </label> : <button type="button" onClick={() => setAddProject(true)}><Folder size={14} />{zh ? "选择项目" : "Choose project"}</button>}
          <label className="starter-context-picker"><Box size={14} /><SelectField className="context-select" aria-label="Harness" value={instance?.id} placeholder="Harness" options={available.map((item) => ({ value: item.id, label: item.displayName }))} onValueChange={(id) => { setInstanceId(id); setConfiguration({}); }} /></label>
          {instance && <HarnessModeControl instanceId={instance.id} value={configuration.agentMode} onChange={agentMode => setConfiguration(current => ({ ...current, agentMode }))} />}
          <label className="starter-context-picker"><UserRound size={14} /><SelectField className="context-select" aria-label={zh ? "供应商或账号" : "Provider or account"} value={configuration.connectionId} placeholder={zh ? "选择供应商 / 账号" : "Choose provider / account"} options={compatibleConnections.map((item) => ({ value: item.id, label: item.name }))} onValueChange={(id) => { const selected = compatibleConnections.find((item) => item.id === id); setConfiguration((current) => ({ agentMode: current.agentMode, permissionMode: current.permissionMode, connectionId: id, connectionRevision: selected?.revision })); }} /></label>
          <label className="starter-context-picker">
            <Users size={14} aria-hidden />
            <SelectField aria-label={zh ? "协作团队" : "Collaboration team"} value={teamId || "__solo"} onValueChange={(value) => setTeamId(value === "__solo" ? "" : value)} options={[{ value: "__solo", label: zh ? "独立工作" : "Solo" }, ...teams.map((team) => ({ value: team.id, label: team.name }))]} className="context-select" />
          </label>
        </div>
        {!teamReady && <p className="mb-3 text-xs text-warn">{zh ? "这个团队的成员需要迁移到 Harness 与独立连接。" : "Team members need a harness and an independent connection."}<button className="ml-2 underline" onClick={() => navigate(`/settings?section=teams&team=${encodeURIComponent(teamId)}`)}>{zh ? "配置团队" : "Configure team"}</button></p>}
        {instance && !compatibleConnections.length && <p className="mb-3 text-xs text-ink-3">{zh ? "当前 Harness 没有可用的兼容连接。" : "No compatible connection is available for this harness."}<button className="ml-2 underline" onClick={() => navigate("/settings?section=accounts")}>{zh ? "管理供应商与账号" : "Manage connections"}</button></p>}
        <Composer
          draftId="new:conversation"
          running={false}
          submissionDisabledReason={blockingReason}
          onCreateSession={create}
          starterControls={instance && <PermissionModeSelect
            value={configuration.permissionMode ?? instance.permissionMode ?? "default"}
            options={permissionModes}
            onChange={(permissionMode) => setConfiguration((current) => ({ ...current, permissionMode }))}
          />}
          trailingControls={instance ? <SessionModelControl draft={{
            instanceId: instance.id,
            configuration: effectiveConfiguration,
            onChange: (patch) => setConfiguration((current) => ({ ...current, ...patch }))
          }} /> : <button type="button" className="composer-setup-agent" onClick={openAgentSettings}>{zh ? "配置 Harness" : "Set up a harness"}</button>}
        />
        {!getBridge() && <p role="status" className="composer-footnote">{zh ? "请在桌面应用中连接 Agent" : "Connect an agent in the desktop app"}</p>}
      </div>
        </div>
      </div>
      <AddProjectDialog open={addProject} onOpenChange={setAddProject} />
    </section>
  );
}
