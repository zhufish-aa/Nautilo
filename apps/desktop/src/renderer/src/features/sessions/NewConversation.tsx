import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Box, Folder, Settings2, Users, UserRound } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { getBridge } from "../../lib/bridge";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { useProjectsStore } from "../../stores/projects";
import { useAgentsStore } from "../../stores/agents";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { connectionSupportsAgent } from "../../lib/session-connections";
import { connectionModelCatalog, hasConfiguredConnectionModels, resolveDraftConnectionConfiguration } from "../../lib/connection-models";
import { useTeamsStore } from "../../stores/teams";
import { useSessionsStore } from "../../stores/sessions";
import type { ComposerConfiguration } from "./SessionModelControl";
import { useProvidersStore } from "../../stores/providers";
import { SelectField } from "../../components/ui/Select";
import { Composer } from "./Composer";
import { NautiloMark, ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { HarnessModeControl } from "./HarnessModeControl";
import { ConnectionPicker } from "./ConnectionPicker";
import { AddProjectDialog } from "../projects/AddProjectDialog";
import "./new-conversation.css";

/** A draft becomes a real conversation only when the first message is sent. */
export function NewConversation({ mode = "code", onCreated, active = true }: {
  mode?: "code" | "work";
  onCreated: (id: string) => void;
  active?: boolean;
}): JSX.Element {
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
  const backdrop = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0, frame: undefined as number | undefined });
  const reducedMotion = useUiReducedMotion();
  useEffect(() => {
    const layer = backdrop.current;
    const position = pointer.current;
    return () => {
      if (position.frame !== undefined) cancelAnimationFrame(position.frame);
      position.frame = undefined;
      layer?.removeAttribute("data-pointer");
    };
  }, [active, reducedMotion]);

  function lightPointer(event: PointerEvent<HTMLElement>): void {
    if (!active || reducedMotion || event.pointerType !== "mouse") return;
    const position = pointer.current;
    position.x = event.clientX;
    position.y = event.clientY;
    if (position.frame !== undefined) return;
    position.frame = requestAnimationFrame(() => {
      position.frame = undefined;
      const layer = backdrop.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      layer.style.setProperty("--bg-mx", `${position.x - rect.left}px`);
      layer.style.setProperty("--bg-my", `${position.y - rect.top}px`);
      layer.dataset.pointer = "";
    });
  }

  function dimPointer(): void {
    const position = pointer.current;
    if (position.frame !== undefined) cancelAnimationFrame(position.frame);
    position.frame = undefined;
    backdrop.current?.removeAttribute("data-pointer");
  }
  useEffect(() => setProjectId(requestedProject), [requestedProject]);
  useProvidersStore((state) => state.catalog);

  const available = instances.filter((instance) => instance.enabled && instance.configurationKind === "harness");
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const instance = available.find((item) => item.id === instanceId) ?? available[0];
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
  const blockingReason = !getBridge() ? (zh ? "请在桌面应用中连接 Agent。" : "Connect an agent in the desktop app.")
    : !project ? (zh ? "选择一个项目后即可发送。" : "Choose a project to send your message.")
    : !instance ? (zh ? "请先在设置中安装并启用一个 Harness。" : "Install and enable a harness in settings first.")
    : configuration.connectionId && !connection ? (zh ? "所选供应商与当前 Harness 不兼容或已停用，请重新选择。" : "The selected provider is incompatible with this harness or disabled. Choose another connection.")
    : connection?.kind === "api" && connection.hasCredential === false ? (zh ? "这个供应商尚未保存 API Key，请在供应商设置中补充。" : "This provider has no saved API key. Add it in provider settings.")
    : !teamReady ? (zh ? "团队成员尚未配置兼容的 Harness 与供应商。" : "Configure a compatible harness and connection for each team member.")
    : connection && !selectedModel && hasConfiguredConnectionModels(connection) ? (zh ? "请在供应商设置中保存并启用一个模型。" : "Save and enable a model in provider settings.")
    : undefined;
  const canStart = !blockingReason;
  const openAgentSettings = (): void => {
    navigate("/settings?section=agents", { state: { returnTo: location.pathname + location.search } });
  };
  const create = (text: string): string | undefined => {
    if (!canStart || !project || !instance || !getBridge()) return undefined;
    const session = useSessionsStore.getState().createSession({
      projectId: project.id,
      target: { type: "agent", instanceId: instance.id, teamId: teamId || undefined },
      title: text.trim().slice(0, 48) || (zh ? "新对话" : "New conversation"),
      mode,
      ...effectiveConfiguration,
      model: connection ? selectedModel : effectiveConfiguration.model,
      connectionId: connection?.id,
      connectionRevision: connection?.revision
    });
    onCreated(session.id);
    return session.id;
  };

  const contextControls = <>
    <div className="starter-context" role="group" aria-label={zh ? "任务配置" : "Task configuration"}>
      {projects.length ? <label className="starter-context-picker" data-tour="session-project">
        <Folder size={14} aria-hidden />
        <SelectField aria-label={zh ? "选择项目" : "Choose project"} value={project?.id} onValueChange={setProjectId} options={projects.map((item) => ({ value: item.id, label: item.name }))} className="context-select" />
      </label> : <button type="button" className="starter-context-picker" onClick={() => setAddProject(true)}><Folder size={14} aria-hidden />{zh ? "选择项目" : "Choose project"}</button>}
      <label className="starter-context-picker starter-context-harness">
        {instance ? <ProviderAvatar providerId={instance.providerId} size="sm" /> : <Box size={14} aria-hidden />}
        <SelectField className="context-select" aria-label="Harness" value={instance?.id} placeholder="Harness" options={available.map((item) => ({ value: item.id, label: item.displayName }))} onValueChange={(id) => { setInstanceId(id); setConfiguration({}); }} />
      </label>
      {instance && <label className="starter-context-picker" title={connection?.name ?? (zh ? "使用 Harness 原生配置" : "Use the harness’s native configuration")}><UserRound size={14} aria-hidden /><ConnectionPicker instance={instance} className="context-select" fallback={{ value: "__native", label: zh ? "原生配置" : "Native config" }} value={configuration.connectionId} onChange={selected => { setConfiguration(current => ({ agentMode: current.agentMode, permissionMode: current.permissionMode, connectionId: selected?.id, connectionRevision: selected?.revision })); }} /></label>}
      <label className="starter-context-picker">
        <Users size={14} aria-hidden />
        <SelectField aria-label={zh ? "协作团队" : "Collaboration team"} value={teamId || "__solo"} onValueChange={(value) => setTeamId(value === "__solo" ? "" : value)} options={[{ value: "__solo", label: zh ? "独立工作" : "Solo" }, ...teams.map((team) => ({ value: team.id, label: team.name }))]} className="context-select" />
      </label>
      {instance && <div className="starter-context-mode"><HarnessModeControl instanceId={instance.id} value={configuration.agentMode} onChange={agentMode => setConfiguration(current => ({ ...current, agentMode }))} /></div>}
    </div>
    {!teamReady && <p className="starter-context-note text-xs text-warn">{zh ? "这个团队的成员需要迁移到 Harness 与独立连接。" : "Team members need a harness and an independent connection."}<button className="ml-2 underline" onClick={() => navigate(`/settings?section=teams&team=${encodeURIComponent(teamId)}`)}>{zh ? "配置团队" : "Configure team"}</button></p>}
  </>;

  return (
    <section className="new-conversation" data-active={active || undefined} onPointerMove={lightPointer} onPointerLeave={dimPointer} aria-label={zh ? "新建任务" : "New task"}>
      <div ref={backdrop} className="new-conversation-backdrop" aria-hidden="true">
        <div className="new-conversation-aurora" />
        <div className="new-conversation-dots" />
        <div className="new-conversation-skylight" />
        <div className="new-conversation-spotlight" />
      </div>
      <button type="button" className="new-conversation-settings" onClick={openAgentSettings} aria-label={zh ? "助理设置" : "Assistant settings"} title={zh ? "助理设置" : "Assistant settings"}><Settings2 size={16} aria-hidden /></button>
      <div className="new-conversation-body">
        <div className="new-conversation-start">
          <div className="new-conversation-welcome">
            <div className="new-conversation-emblem" aria-hidden>
              <NautiloMark />
            </div>
            <h1>{project
              ? (zh ? <>在 <span>{project.name}</span> 开始新任务</> : <>Start a task in <span>{project.name}</span></>)
              : (zh ? "准备开始什么任务？" : "What would you like to work on?")}</h1>
            <p className="new-conversation-subtitle">
              <i className="new-conversation-ready-dot" data-ready={canStart} aria-hidden />
              <span>{zh ? "多 Agent 协同工作台 · 按 @ 快速引用技能、MCP 或工作流" : "Multi-agent workbench · Type @ to invoke skills, MCPs or workflows"}</span>
            </p>
          </div>
          <Composer
            draftId="new:conversation"
            projectId={project?.id}
            running={false}
            submissionDisabledReason={blockingReason}
            onCreateSession={create}
            contextControls={contextControls}
            starterControls={instance ? {
              instanceId: instance.id,
              configuration: effectiveConfiguration,
              onChange: (patch) => setConfiguration((current) => ({ ...current, ...patch }))
            } : undefined}
            trailingControls={!instance && <button type="button" className="composer-setup-agent" onClick={openAgentSettings}>{zh ? "配置 Harness" : "Set up a harness"}</button>}
          />
          {!getBridge() && <p role="status" className="composer-footnote">{zh ? "请在桌面应用中连接 Agent" : "Connect an agent in the desktop app"}</p>}
        </div>
      </div>
      <AddProjectDialog open={addProject} onOpenChange={setAddProject} />
    </section>
  );
}
