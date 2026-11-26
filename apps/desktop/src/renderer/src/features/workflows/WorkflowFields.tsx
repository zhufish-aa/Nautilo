import { useEffect, useRef, useState } from "react";
import { Braces, Minus, Plus, X } from "lucide-react";
import type { VerificationCommandTemplate, WorkflowDefinition, WorkflowNode, WorkflowTemplate, WorkflowType } from "@agenthub/domain";
import { nodeLabel } from "./workflow-model";
import type { InspectorTab } from "./workflow-editing";
import { WorkflowSelect, workflowChoices } from "./WorkflowSelect";

interface FieldsProps {
  node: WorkflowNode;
  definition: WorkflowDefinition;
  templates: WorkflowTemplate[];
  verificationTemplates?: VerificationCommandTemplate[];
  readOnly: boolean;
  tab?: InspectorTab;
  exitId?: string;
  onEdit: (edit: (node: WorkflowNode) => void) => void;
  onInsertField?: (name: string) => void;
}

export function JsonField({ label, value, readOnly, object, onCommit }: {
  label: string; value: unknown; readOnly: boolean; object?: boolean; onCommit: (value: unknown) => void;
}): JSX.Element {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  const [text, setText] = useState(serialized), [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(serialized); setError(""); input.current?.setCustomValidity(""); }, [serialized]);
  return <label className="wf-json-field">{label}<textarea ref={input} aria-label={label} spellCheck={false} readOnly={readOnly} data-multiline={text.includes("\n") || undefined}
    value={text} aria-invalid={!!error} onChange={event => { setText(event.target.value); setError(""); event.target.setCustomValidity(""); }} onBlur={() => {
      try {
        const next: unknown = JSON.parse(text);
        if (object && (!next || typeof next !== "object" || Array.isArray(next))) throw new Error("请填写 JSON 对象，例如 {\"question\": \"{{input.question}}\"}");
        if (JSON.stringify(next) !== JSON.stringify(value)) onCommit(next);
        setError(""); input.current?.setCustomValidity("");
      } catch (error) {
        const message = error instanceof SyntaxError ? "格式还不完整，请检查引号、逗号和括号。" : String(error instanceof Error ? error.message : error);
        setError(message); input.current?.setCustomValidity(message);
      }
    }}/>{error && <span role="alert">{error}</span>}</label>;
}

const exitChoices = (node: WorkflowNode) => node.exits.map(exit => ({ value: exit.id, label: exit.name }));
const fieldTypes = { text: "文本", number: "数值", boolean: "是 / 否", json: "任意结果", "list<text>": "文本列表", "list<json>": "结果列表" };

function OutputField({ name: initialName, type, node, onEdit, onInsertField }: {
  name: string; type: WorkflowType; node: WorkflowNode; onEdit: FieldsProps["onEdit"]; onInsertField?: FieldsProps["onInsertField"];
}): JSX.Element {
  const [name, setName] = useState(initialName), [error, setError] = useState("");
  const selectedType = typeof type === "string" && Object.hasOwn(fieldTypes, type) ? type : "custom";
  return <div className="wf-output-field">
    <div className="wf-rule-row">
      <i className="wf-output-type-mark" data-type={selectedType} aria-hidden/>
      <input aria-label={initialName + "的字段名称"} value={name} onChange={event => { setName(event.target.value); setError(""); event.target.setCustomValidity(""); }} onBlur={event => {
      const key = name.trim();
      if (!key || (key !== initialName && Object.hasOwn(node.outputs || {}, key))) { setError("字段名不能为空或重复。"); event.target.setCustomValidity("字段名不能为空或重复。"); return; }
      event.target.setCustomValidity("");
      if (key !== initialName) onEdit(node => {
        node.outputs = Object.fromEntries(Object.entries(node.outputs || {}).map(([name, value]) => [name === initialName ? key : name, value]));
        if (node.outputDescriptions && Object.hasOwn(node.outputDescriptions, initialName)) {
          node.outputDescriptions[key] = node.outputDescriptions[initialName];
          delete node.outputDescriptions[initialName];
        }
      });
    }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}/><WorkflowSelect label={initialName + "的字段类型"}
      value={selectedType} options={workflowChoices({ ...fieldTypes, custom: "结构化类型" })} onChange={value => onEdit(node => {
        node.outputs![initialName] = value === "custom" ? { properties: { value: "text" }, required: ["value"] } : value as WorkflowType;
      })}/>
      <div className="wf-output-actions">
        {onInsertField && <button type="button" title="插入到提示词" aria-label={"插入字段 " + initialName} onClick={() => onInsertField(initialName)}><Braces size={13}/></button>}
        <button type="button" aria-label={"移除字段 " + initialName} onClick={() => onEdit(node => {
          delete node.outputs?.[initialName];
          if (!node.outputDescriptions) return;
          delete node.outputDescriptions[initialName];
          if (!Object.keys(node.outputDescriptions).length) delete node.outputDescriptions;
        })}><X size={13}/></button>
      </div>
    </div>
    <textarea className="wf-output-description" rows={1} aria-label={initialName + "的字段说明"} placeholder="添加字段描述…" value={node.outputDescriptions?.[initialName] ?? ""}
        onChange={event => onEdit(node => { (node.outputDescriptions ??= {})[initialName] = event.target.value; })}
        onBlur={event => {
          const description = event.target.value.trim();
          if (description && description === node.outputDescriptions?.[initialName]) return;
          onEdit(node => {
            if (description) (node.outputDescriptions ??= {})[initialName] = description;
            else if (node.outputDescriptions) {
              delete node.outputDescriptions[initialName];
              if (!Object.keys(node.outputDescriptions).length) delete node.outputDescriptions;
            }
          });
        }}/>
    {error && <small className="wf-field-error" role="alert">{error}</small>}
    {selectedType === "custom" && <JsonField label={initialName + "的结构化类型"} value={type} readOnly={false} onCommit={value => onEdit(node => { node.outputs![initialName] = value as WorkflowType; })}/>}
  </div>;
}

export function WorkflowFields({ node, definition, templates, verificationTemplates = [], readOnly, tab, exitId, onEdit, onInsertField }: FieldsProps): JSX.Element | null {
  if (node.kind === "join") {
    const sources = [...new Set(definition.edges.filter(edge => edge.to === node.id || edge.onLimit === node.id).map(edge => edge.from[0]))];
    return <div className="wf-control-fields">
      <div className="wf-inline-field">等待方式<WorkflowSelect label="等待方式" disabled={readOnly} value={node.wait || "all"} options={workflowChoices({ all: "全部来源", firstValid: "首个合格结果", quorum: "达到指定份数" })} onChange={value => onEdit(node => { node.wait = value as WorkflowNode["wait"]; if (node.wait === "quorum") node.quorum ||= 1; })}/></div>
      <div className="wf-inline-field">所属分派<WorkflowSelect label="所属分派" disabled={readOnly} value={node.scope} options={definition.nodes.filter(item => item.id !== node.id).map(item => ({ value: item.id, label: nodeLabel(item) }))} onChange={value => onEdit(node => { node.scope = value; if (definition.nodes.find(n => n.id === value)?.forEach) delete node.sources; })}/></div>
      <div className="wf-inline-field">汇合范围<WorkflowSelect label="汇合范围" disabled={readOnly} value={node.sources?.length ? "nodes" : "branches"} options={[{ value:"branches", label:"本批分支 / 列表项" }, { value:"nodes", label:"已连接的来源节点", disabled:!sources.length || !!definition.nodes.find(n => n.id === node.scope)?.forEach }]} onChange={value => onEdit(node => { if (value === "nodes") node.sources = sources; else delete node.sources; })}/></div>
      {!!node.sources?.length && <div className="wf-source-chips" aria-label="汇合来源">{node.sources.map(id => <span key={id}>{definition.nodes.find(n => n.id === id) ? nodeLabel(definition.nodes.find(n => n.id === id)!) : id}</span>)}</div>}
      {node.wait === "quorum" && <label className="wf-inline-field">所需份数<input aria-label="汇合所需份数" disabled={readOnly} type="number" min={1} max={node.sources?.length} value={node.quorum || 1} onChange={event => onEdit(node => { node.quorum = Number(event.target.value); })}/></label>}
      <div className="wf-inline-field">其余来源<WorkflowSelect label="其余来源" disabled={readOnly} value={node.remaining || "continue"} options={workflowChoices({ continue: "继续执行", cancel: "结果足够后取消" })} onChange={value => onEdit(node => { node.remaining = value as WorkflowNode["remaining"]; })}/></div>
      <p className="wf-field-help">{node.sources?.length ? "同一份结果可以交给多个汇合，各自独立等待。" : "等待本次实际分派的分支，或列表中的各项。"}</p>
    </div>;
  }
  if (node.kind === "condition") return <div className="wf-control-fields">
    <p className="wf-field-help">按顺序检查结果字段，匹配后沿对应出口前进。</p>
    {node.cases?.map((rule, index) => (!exitId || rule.exit === exitId) && <div className="wf-condition-rule" key={index}>
      <label className="wf-inline-field">字段<input aria-label={`条件 ${index + 1} 的字段`} readOnly={readOnly} placeholder="incoming.result.approved" value={rule.path} onChange={event => onEdit(node => { node.cases![index].path = event.target.value; })}/></label>
      <div className="wf-inline-field">判断方式<WorkflowSelect label={`条件 ${index + 1} 的判断方式`} disabled={readOnly} value={rule.operator || "eq"}
        options={workflowChoices({ eq: "等于", ne: "不等于", gt: "大于", ge: "大于等于", lt: "小于", le: "小于等于", exists: "有值", missing: "缺少字段" })}
        onChange={value => onEdit(node => { node.cases![index].operator = value as NonNullable<WorkflowNode["cases"]>[number]["operator"]; })}/></div>
      {!["exists", "missing"].includes(rule.operator || "") && <JsonField label={`条件 ${index + 1} ${!rule.operator || rule.operator === "eq" ? "等于" : "比较值"}`} value={rule.equals} readOnly={readOnly} onCommit={value => onEdit(node => { node.cases![index].equals = value; })}/>}
      <div className="wf-inline-field">匹配出口<WorkflowSelect label={`条件 ${index + 1} 的匹配出口`} disabled={readOnly} value={rule.exit} options={exitChoices(node)} onChange={value => onEdit(node => { node.cases![index].exit = value; })}/>{!readOnly && <button aria-label={`移除条件 ${index + 1}`} onClick={() => onEdit(node => { node.cases!.splice(index, 1); })}><X size={12}/></button>}</div>
    </div>)}
    {!readOnly && <button className="wf-add-exit" onClick={() => onEdit(node => { node.cases ||= []; node.cases.push({ path: "incoming.result.approved", equals: true, exit: exitId || node.exits[0]?.id || "" }); })}><Plus size={12}/>添加判断条件</button>}
    {exitId ? <label className="wf-verification-option">设为默认兜底出口<input type="checkbox" role="switch" checked={node.otherwise === exitId} disabled={readOnly} onChange={event => onEdit(node => { if (event.target.checked) node.otherwise = exitId; else delete node.otherwise; })}/></label>
      : <div className="wf-inline-field">都不匹配<WorkflowSelect label="默认出口" disabled={readOnly} value={node.otherwise || ""} options={[{ value:"", label:"选择默认出口" }, ...exitChoices(node)]} onChange={value => onEdit(node => { node.otherwise = value; })}/></div>}
  </div>;
  if (node.kind === "call") return <div className="wf-control-fields">
    <div className="wf-inline-field">引用流程<WorkflowSelect label="引用流程" disabled={readOnly} value={node.ref ? `${node.ref.id}@${node.ref.revision}` : ""}
      options={[{ value:"", label:"选择已保存的流程" },
        ...node.ref && !templates.some(t => t.id === node.ref?.id && t.revision === node.ref?.revision) ? [{ value:`${node.ref.id}@${node.ref.revision}`, label:`${node.ref.id} · 修订 ${node.ref.revision}` }] : [],
        ...templates.filter(item => item.id !== definition.id).map(item => ({ value: `${item.id}@${item.revision}`, label: `${item.name} · 修订 ${item.revision}` }))]} onChange={value => {
      const template = templates.find(template => `${template.id}@${template.revision}` === value);
      if (!template) { onEdit(node => { delete node.ref; node.input = {}; node.exitMap = {}; }); return; }
      const returns = [...new Set(template.definition.edges.filter(edge => edge.to === "$return").map(edge => template.definition.nodes.find(n => n.id === edge.from[0])?.exits.find(exit => exit.id === edge.from[1])?.name).filter((name): name is string => !!name))];
      onEdit(node => { node.ref = { id: template.id, revision: template.revision }; node.input = Object.fromEntries(Object.keys(template.definition.inputs || {}).map(key => [key, node.input?.[key] ?? ""])); node.exitMap = Object.fromEntries(returns.map(name => [name, node.exitMap?.[name] || node.exits[0]?.id || ""])); });
    }}/></div>
    <p className="wf-field-help">本次引用固定到所选修订。模板以后更新，不会改动这次流程。</p>
    <JsonField label="子流程输入映射" value={node.input || {}} readOnly={readOnly} object onCommit={value => onEdit(node => { node.input = value as WorkflowNode["input"]; })}/>
    {Object.entries(node.exitMap || {}).map(([name, exit]) => <div className="wf-inline-field" key={name}>{name}<span>→</span><WorkflowSelect label={name + "返回时的出口"} disabled={readOnly} value={exit} options={exitChoices(node)} onChange={value => onEdit(node => { node.exitMap![name] = value; })}/></div>)}
    {!Object.keys(node.exitMap || {}).length && <JsonField label="子流程出口映射" value={node.exitMap || {}} readOnly={readOnly} object onCommit={value => onEdit(node => { node.exitMap = value as WorkflowNode["exitMap"]; })}/>}
  </div>;
  if (node.kind === "agent" && !readOnly && tab === "output") return <div className="wf-agent-fields">
    <section className="wf-inspector-section">
      <div className="wf-inline-field">结果交付<WorkflowSelect label="结果交付" value={node.completion || "tool"} options={workflowChoices({ tool: "调用提交工具", structured_final: "最终回复提交 JSON" })} onChange={value => onEdit(node => { node.completion = value as WorkflowNode["completion"]; })}/></div>
      <div className="wf-field-title wf-output-title">
        结果字段
        <button type="button" aria-label="添加结果字段" onClick={() => onEdit(node => { node.outputs ||= {}; let name = "field"; for (let i = 2; Object.hasOwn(node.outputs, name); i++) name = `field_${i}`; node.outputs[name] = "text"; })}>+ 添加</button>
      </div>
      {Object.entries(node.outputs || {}).map(([name, type]) => <OutputField key={name} name={name} type={type} node={node} onEdit={onEdit} onInsertField={onInsertField}/>)}
    </section>
    <section className="wf-inspector-section">
      <div className="wf-field-title">派发与变量</div>
      <label className="wf-verification-option wf-toggle-field">
        <span>按列表逐项派发<small>引擎会在派发前校验变量</small></span>
        <input type="checkbox" role="switch" aria-label="按列表逐项派发" checked={!!node.forEach} onChange={event => onEdit(node => { if (event.target.checked) node.forEach = { source: "incoming.result.items", key: "id", maxItems: 20, maxParallel: 3, emptyExit: node.exits[0]?.id }; else delete node.forEach; })}/>
      </label>
      {node.forEach && <div className="wf-condition-rule">
        <label className="wf-inline-field">列表来源<input value={node.forEach.source} aria-label="派发列表来源" onChange={event => onEdit(node => { node.forEach!.source = event.target.value; })}/></label>
        <label className="wf-inline-field">每项标识<input value={node.forEach.key} aria-label="列表项唯一标识" onChange={event => onEdit(node => { node.forEach!.key = event.target.value; })}/></label>
        <label className="wf-inline-field">最多项数<input type="number" min={1} value={node.forEach.maxItems} onChange={event => onEdit(node => { node.forEach!.maxItems = Number(event.target.value); })}/></label>
        <label className="wf-inline-field">同时执行<input type="number" min={1} max={node.forEach.maxItems} value={node.forEach.maxParallel} onChange={event => onEdit(node => { node.forEach!.maxParallel = Number(event.target.value); })}/></label>
        <div className="wf-inline-field">列表为空<WorkflowSelect label="列表为空" value={node.forEach.emptyExit || ""} options={[{value:"",label:"选择出口"}, ...exitChoices(node)]} onChange={value => onEdit(node => { node.forEach!.emptyExit = value; })}/></div>
      </div>}
      <div className="wf-flow-defaults">{Object.entries(node.fallbacks ?? {}).map(([path, value]) =>
        <label className="wf-inline-field" key={path}><code title={path}>{path}</code>
          <WorkflowSelect label={path + "的默认值"} value={value === null ? "null" : value === 0 ? "zero" : "custom"} options={workflowChoices({null:"空值", zero:"0", custom:"自定义"})} onChange={value => {
            if (value === "custom") requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="缺失默认值"]')?.focus());
            else onEdit(node => { node.fallbacks![path] = value === "null" ? null : 0; });
          }}/>
        </label>)}</div>
      <div className="wf-missing-default">
        <JsonField label="缺失默认值" value={node.fallbacks || {}} object readOnly={false} onCommit={value => onEdit(node => { node.fallbacks = value as Record<string, unknown>; })}/>
      </div>
    </section>
  </div>;
  if (node.kind === "agent" && !readOnly && tab === "environment") return <div className="wf-agent-fields">
    <section className="wf-inspector-section">
      <div className="wf-field-title">容错策略</div>
      <div className="wf-inline-field">执行失败<WorkflowSelect label="执行失败" value={node.onError || ""} options={[{value:"", label:"交由引擎判断与升级"}, ...exitChoices(node)]} onChange={value => onEdit(node => { if (value) node.onError = value; else delete node.onError; })}/></div>
      <div className="wf-inline-field">最多重试<Stepper label="最多重试" value={(node.maxAttempts ?? 1) - 1} min={0} max={4} onChange={value => onEdit(node => { node.maxAttempts = value + 1; })}/></div>
      <label className="wf-verification-option">允许按需加派子任务<input type="checkbox" role="switch" checked={!!node.dynamicSubflow} onChange={event => onEdit(node => {
        if (event.target.checked) node.dynamicSubflow = { roles: node.role ? [node.role] : [], maxInstances: 12, maxDepth: 0 };
        else delete node.dynamicSubflow;
      })}/></label>
      {node.dynamicSubflow && <div className="wf-condition-rule">
        <JsonField label="子流程可以使用的角色" value={node.dynamicSubflow.roles} readOnly={false} onCommit={value => onEdit(node => { node.dynamicSubflow!.roles = value as string[]; })}/>
        <label className="wf-inline-field">子图实例上限<input type="number" min={1} max={100000} value={node.dynamicSubflow.maxInstances} onChange={event => onEdit(node => { node.dynamicSubflow!.maxInstances = Number(event.target.value); })}/></label>
        <label className="wf-inline-field">允许再嵌套的层数<input type="number" min={0} max={31} value={node.dynamicSubflow.maxDepth} onChange={event => onEdit(node => { node.dynamicSubflow!.maxDepth = Number(event.target.value); })}/></label>
      </div>}
    </section>
    <section className="wf-inspector-section">
      <div className="wf-field-title">工作区与权限</div>
      <div className="wf-inline-field">工作区<WorkflowSelect label="节点工作区策略" value={node.workspace?.mode || "inherit"} options={workflowChoices({inherit:"沿用项目设置", isolated:"独立 Git 工作区"})} onChange={value => onEdit(node => { node.workspace ||= {}; node.workspace.mode = value as "inherit" | "isolated"; })}/></div>
      <label className="wf-path-field">允许修改的路径<textarea aria-label="节点允许修改的路径" spellCheck={false} rows={3} placeholder={"留空表示项目目录内均可修改\n例如 src/**"} value={(node.workspace?.allowedPaths || []).join("\n")} onChange={event => onEdit(node => { node.workspace ||= {}; node.workspace.allowedPaths = event.target.value.split("\n"); })} onBlur={event => onEdit(node => { node.workspace ||= {}; node.workspace.allowedPaths = event.target.value.split("\n").map(path => path.trim()).filter(Boolean); })}/></label>
      <div className="wf-path-presets">{[["只读", "."], ["仅 src/**", "src/**"], ["仅测试", "tests/**"]].map(([label, path]) =>
        <button key={path} type="button" title={path === "." ? "验收时拒绝文件修改" : path}
          onClick={() => onEdit(node => { node.workspace ||= {}; node.workspace.allowedPaths = [path]; })}>{label}</button>)}</div>
      {node.workspace?.allowedPaths?.some(path => /^(?:[A-Za-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)) && <small className="wf-field-error">请使用工作区内的相对路径。</small>}
      <p className="wf-field-help">每行一个相对路径，可用 * 与 **。配置路径范围后使用独立工作区，在交给下游前检查全部修改。</p>
      <div className="wf-field-title wf-section-title">项目验收项</div>
      <div className="wf-inline-field">验收规则<WorkflowSelect label="节点验收规则" value={node.workspace?.verificationTemplates === undefined ? "inherit" : "custom"} options={workflowChoices({inherit:"沿用项目的全部检查", custom:"选择可选检查"})} onChange={value => onEdit(node => { node.workspace ||= {}; if (value === "inherit") delete node.workspace.verificationTemplates; else node.workspace.verificationTemplates = []; })}/></div>
      {verificationTemplates.filter(template => template.scopes.includes("task")).map(template => <label className="wf-verification-option" key={template.id}>
        <span>{template.name}</span>{template.required && <small>必需</small>}
        <input aria-label={"验收项 " + template.name} type="checkbox" role="switch" checked={template.required || node.workspace?.verificationTemplates === undefined || !!node.workspace.verificationTemplates.includes(template.id)} disabled={template.required || node.workspace?.verificationTemplates === undefined} onChange={event => onEdit(node => { node.workspace ||= {}; const ids = new Set(node.workspace.verificationTemplates || []); if (event.target.checked) ids.add(template.id); else ids.delete(template.id); node.workspace.verificationTemplates = [...ids]; })}/>
      </label>)}
      {!verificationTemplates.length && <p className="wf-field-help">选择运行会话后，显示该项目登记的验收项。项目要求的检查始终执行。</p>}
      <p className="wf-field-help">批准规则沿用项目和团队设置，需要确认的验收命令会在执行前弹出批准请求。</p>
      {(node.workspace?.verificationTemplates || []).filter(id => !verificationTemplates.some(template => template.id === id)).map(id => <div className="wf-verification-option" key={id}><code>{id}</code><small>待核对项目</small><button aria-label={"移除验收项 " + id} onClick={() => onEdit(node => { node.workspace!.verificationTemplates = node.workspace!.verificationTemplates!.filter(value => value !== id); })}><X size={12}/></button></div>)}
    </section>
  </div>;
  return null;
}

export function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return <div className="wf-stepper">
    <button type="button" aria-label={`减少${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={12}/></button>
    <input type="number" aria-label={label} min={min} max={max} value={value} onChange={event => {
      const number = event.currentTarget.valueAsNumber;
      if (Number.isInteger(number) && number >= min && number <= max) onChange(number);
    }}/>
    <button type="button" aria-label={`增加${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={12}/></button>
  </div>;
}
