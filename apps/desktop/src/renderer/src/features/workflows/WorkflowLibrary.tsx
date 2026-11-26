import { memo, useState } from "react";
import { Archive, Check, Copy, Download, Plus, Search, Upload } from "lucide-react";
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
  onOpen(template: WorkflowTemplate): void;
  onClone(template: WorkflowTemplate): void;
  onExport(template: WorkflowTemplate): void;
  onArchive(template: WorkflowTemplate): void;
  onImport(): void;
  onNew(): void;
  onDraft(): void;
}

export function WorkflowLibrary({ templates, activeId, ready, showDraft, draftActive, busy, collapsed, onOpen, onClone, onExport, onArchive, onImport, onNew, onDraft }: Props) {
  const [query, setQuery] = useState("");
  const filtered = templates.filter(template => template.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <aside className="wf-library" aria-label="流程库" data-collapsed={collapsed} aria-hidden={collapsed || undefined}>
    <div id="wf-library" className="wf-library-list" hidden={collapsed}>
      <header className="wf-rail-header"><strong>流程库</strong></header>
      <label className="wf-library-search"><Search size={13}/><input aria-label="搜索流程" placeholder="搜索流程" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="wf-library-rows">
        {showDraft && !query && <button type="button" className="wf-draft-link" aria-current={draftActive ? "true" : undefined} disabled={busy} onClick={onDraft}><span>未保存的草稿</span>{draftActive && <Check size={13}/>}</button>}
        {filtered.map(template => <div key={template.id} className="wf-library-row">
          <button type="button" className="wf-library-item" aria-label={"打开流程 " + template.name} aria-current={activeId === template.id ? "true" : undefined} disabled={busy} onClick={() => onOpen(template)}>
            <Thumbnail template={template}/>
            <span className="wf-library-caption"><strong title={template.name}>{template.name}</strong>{activeId === template.id && <Check size={13} aria-hidden/>}</span>
          </button>
          <div className="wf-library-item-actions">
            <button type="button" aria-label={"复制副本 " + template.name} title="复制副本" onClick={() => onClone(template)}><Copy size={12}/></button>
            <button type="button" aria-label={"导出 JSON " + template.name} title="导出 JSON" onClick={() => onExport(template)}><Download size={12}/></button>
            <button type="button" aria-label={"删除 " + template.name} title="从流程库移除" onClick={() => onArchive(template)}><Archive size={12}/></button>
          </div>
        </div>)}
        {!filtered.length && <div className="wf-library-empty" role="status">{!ready ? "正在加载流程…" : query ? "没有匹配的流程" : "暂无已保存的流程"}</div>}
      </div>
      <footer className="wf-library-footer">
        <button type="button" aria-label="新建流程" disabled={busy} onClick={onNew}><Plus size={14}/>新建</button>
        <button type="button" disabled={busy} onClick={onImport}><Upload size={13}/>导入 JSON</button>
      </footer>
    </div>
  </aside>;
}
