import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowUpRight, Check, ChevronDown, FileDiff, Folder, GitBranch, GitFork, Globe, ListChecks, PanelRight, SquareTerminal, Users, Workflow } from "lucide-react";
import { useRef, type RefObject } from "react";
import { useI18n } from "../../lib/i18n";
import type { UiProject } from "../../lib/types";
import "./session-workspace-menu.css";

const tools = [
  { id: "terminal", label: "sessions.workspace.terminal", icon: SquareTerminal, key: "T" },
  { id: "browser", label: "sessions.workspace.browser", icon: Globe, key: "B" },
  { id: "source-control", label: "sessions.workspace.git", icon: GitBranch, key: "G" }
] as const;

const sessionViews = [
  { id: "artifacts", label: "sessions.workspace.files", icon: FileDiff, key: "D" },
  { id: "goals", label: "sessions.workspace.goals", icon: ListChecks, key: "L" },
  { id: "dag", label: "sessions.header.dag", icon: GitFork, key: "P" },
  { id: "workflows", label: "nav.workflows", icon: Workflow, key: "W" },
  { id: "agents", label: "sessions.workspace.agents", icon: Users, key: "A" }
] as const;

type Entry = (typeof tools)[number] | (typeof sessionViews)[number];
type Action = { run(): void; checked?: boolean; detail?: string; external?: boolean };
type Actions = Partial<Record<Entry["id"], Action>>;

export function SessionWorkspaceMenu({ project, openFolder, actions, trigger }: {
  project?: Pick<UiProject, "name" | "rootPath">;
  openFolder?: () => void;
  actions: Actions;
  trigger: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const { t } = useI18n();
  const selection = useRef<{ run(): void; anchor: HTMLButtonElement }>();
  const workspace = t("sessions.workspace.title");
  function select(run: () => void): void {
    if (trigger.current) selection.current = { run, anchor: trigger.current };
  }
  const projectInfo = project && <>
    <span className="session-workspace-project-icon"><Folder size={17} aria-hidden /></span>
    <div><strong title={project.name}>{project.name}</strong>{project.rootPath && <span title={project.rootPath}>{project.rootPath}</span>}</div>
  </>;

  function row(entry: Entry): JSX.Element | null {
    const action = actions[entry.id];
    if (!action) return null;
    const { icon: Icon, key } = entry;
    const label = t(entry.label);
    const props = {
      className: "session-workspace-item",
      "data-shortcut": key,
      "aria-keyshortcuts": key,
      textValue: label,
      onSelect: () => select(action.run)
    };
    const contents = <>
      <Icon size={16} className="session-workspace-item-icon" aria-hidden />
      <span className="session-workspace-item-label">{label}</span>
      {action.detail && <span className="session-workspace-detail">{action.detail}</span>}
      {action.external && <><ArrowUpRight size={13} aria-hidden /><span className="sr-only">{t("sessions.workspace.newWindow")}</span></>}
      {action.checked && <Check size={14} aria-hidden />}
      <kbd aria-hidden>{key}</kbd>
    </>;
    return action.checked === undefined
      ? <Menu.Item key={entry.id} {...props}>{contents}</Menu.Item>
      : <Menu.CheckboxItem key={entry.id} {...props} checked={action.checked}>{contents}</Menu.CheckboxItem>;
  }

  return <Menu.Root modal={false}>
    <Menu.Trigger ref={trigger} type="button" className="session-workspace-trigger" aria-label={workspace} title={workspace}>
      <PanelRight size={16} aria-hidden />
      <span>{workspace}</span>
      <ChevronDown size={12} className="session-workspace-chevron" aria-hidden />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className="session-workspace-menu" aria-label={workspace} align="end" sideOffset={7} collisionPadding={10}
        onCloseAutoFocus={event => {
          // The panel remembers the stable toolbar button as its return target.
          // Run after the menu releases focus so it cannot steal focus back.
          const action = selection.current;
          selection.current = undefined;
          if (!action) return;
          event.preventDefault();
          if (!action.anchor.isConnected) return;
          action.anchor.focus({ preventScroll: true });
          action.run();
        }}
        onKeyDownCapture={event => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || !/^[a-z]$/i.test(event.key)) return;
          const item = event.currentTarget.querySelector<HTMLElement>(`[data-shortcut="${event.key.toUpperCase()}"]`);
          if (!item) return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) item.click();
        }}>
        {project && (openFolder
          ? <Menu.Item className="session-workspace-project" textValue={project.name} data-shortcut="F" aria-keyshortcuts="F" aria-label={t("sessions.workspace.openFolder", { name: project.name })}
              title={t("sessions.workspace.openFolder", { name: project.name })} onSelect={() => select(openFolder)}>
              {projectInfo}<ArrowUpRight size={14} className="session-workspace-folder-arrow" aria-hidden />
            </Menu.Item>
          : <div className="session-workspace-project">{projectInfo}</div>)}
        <Menu.Group aria-label={t("sessions.workspace.tools")} className="session-workspace-group">{tools.map(row)}</Menu.Group>
        <Menu.Separator className="session-workspace-divider" />
        <Menu.Group aria-label={t("sessions.workspace.session")} className="session-workspace-group">
          <Menu.Label className="session-workspace-caption">{t("sessions.workspace.session")}</Menu.Label>
          {sessionViews.map(row)}
        </Menu.Group>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}
