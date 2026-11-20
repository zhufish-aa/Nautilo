import { memo, useId } from "react";
import { Check, PanelLeftClose, PanelLeftOpen, Plus, Workflow } from "lucide-react";
import type { WorkflowTemplate } from "@agenthub/domain";
import { diagramBounds, diagramWires, loopEdges, placeNodes } from "./workflow-geometry";
import { nodeTone } from "./workflow-model";

const Thumbnail = memo(function Thumbnail({ template }: { template: WorkflowTemplate }) {
  const nodes = placeNodes(template.definition, template.layout);
  const wires = diagramWires(template.definition, template.layout, nodes);
  const loops = loopEdges(template.definition.edges);
  const { left, top, width, height } = diagramBounds(nodes, wires);
  const padding = Math.max(24, Math.max(width, height) * .075);
  return <div className="wf-library-thumbnail" aria-hidden="true">
    <svg viewBox={[left - padding, top - padding, width + 2 * padding, height + 2 * padding].join(" ")} preserveAspectRatio="xMidYMid meet">
      {wires.map(wire => <path className="wf-thumbnail-wire" key={wire.key} d={wire.path} data-loop={wire.selection.limit || loops.has(wire.index)} vectorEffect="non-scaling-stroke"/>)}
      {nodes.map(({ node, position: { x, y }, size: { width, height } }) => node.kind === "join"
        ? <path className="wf-thumbnail-node" key={node.id} data-tone={nodeTone(node)} d={`M ${x + width / 2} ${y + 3} L ${x + width - 3} ${y + height / 2} L ${x + width / 2} ${y + height - 3} L ${x + 3} ${y + height / 2} Z`} vectorEffect="non-scaling-stroke"/>
        : <g key={node.id} data-tone={nodeTone(node)}>
          <rect className="wf-thumbnail-node" x={x} y={y} width={width} height={height} rx={node.kind === "main" ? height / 2 : 10} vectorEffect="non-scaling-stroke"/>
          <circle className="wf-thumbnail-symbol" cx={x + 30} cy={y + height / 2} r={10}/>
          <path className="wf-thumbnail-name" d={`M ${x + 52} ${y + height / 2} h ${Math.min(width - 76, Math.max(22, [...(node.name || node.id)].length * 10))}`}/>
        </g>)}
    </svg>
  </div>;
});

interface Props {
  templates: WorkflowTemplate[];
  activeId?: string;
  ready: boolean;
  showDraft: boolean;
  draftActive: boolean;
  busy: boolean;
  collapsed: boolean;
  onToggle(): void;
  onOpen(template: WorkflowTemplate): void;
  onNew(): void;
  onDraft(): void;
}

export function WorkflowLibrary({ templates, activeId, ready, showDraft, draftActive, busy, collapsed, onToggle, onOpen, onNew, onDraft }: Props) {
  const listId = useId();
  const toggleLabel = collapsed ? "展开流程库" : "收起流程库";
  return <aside className="wf-library" aria-label="流程库" data-collapsed={collapsed}>
    <header className="wf-rail-header">
      {!collapsed && <span><Workflow size={15}/>流程库</span>}
      <div className="wf-rail-actions">
        {!collapsed && <button type="button" className="wf-icon-button" aria-label="新建流程" title="新建流程" disabled={busy} onClick={onNew}><Plus size={16}/></button>}
        <button type="button" className="wf-icon-button" aria-label={toggleLabel} title={toggleLabel} aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
          {collapsed ? <PanelLeftOpen size={15}/> : <PanelLeftClose size={15}/>}
        </button>
      </div>
    </header>
    <div id={listId} className="wf-library-list" hidden={collapsed}>
      {showDraft && <button type="button" className="wf-draft-link" aria-current={draftActive ? "true" : undefined} disabled={busy} onClick={onDraft}><span>未保存的草稿</span>{draftActive && <Check size={13}/>}</button>}
      {templates.map(template => <button type="button" key={template.id} className="wf-library-item" aria-label={"打开流程 " + template.name} aria-current={activeId === template.id ? "true" : undefined} disabled={busy} onClick={() => onOpen(template)}>
        <Thumbnail template={template}/>
        <span className="wf-library-caption"><strong title={template.name}>{template.name}</strong>{activeId === template.id && <Check size={13} aria-hidden="true"/>}</span>
      </button>)}
      {ready && !templates.length && <div className="wf-library-empty">保存后的流程会显示在这里。</div>}
      {!ready && <div className="wf-library-empty" role="status">正在加载流程…</div>}
    </div>
  </aside>;
}
