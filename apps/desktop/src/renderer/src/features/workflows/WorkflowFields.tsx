import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { VerificationCommandTemplate, WorkflowDefinition, WorkflowNode, WorkflowTemplate, WorkflowType } from "@agenthub/domain";
import { nodeLabel } from "./workflow-model";

interface FieldsProps {
  node: WorkflowNode;
  definition: WorkflowDefinition;
  templates: WorkflowTemplate[];
  verificationTemplates?: VerificationCommandTemplate[];
  readOnly: boolean;
  onEdit: (edit: (node: WorkflowNode) => void) => void;
}

function JsonField({ label, value, readOnly, object, onCommit }: {
  label: string; value: unknown; readOnly: boolean; object?: boolean; onCommit: (value: unknown) => void;
}): JSX.Element {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  const [text, setText] = useState(serialized), [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(serialized); setError(""); input.current?.setCustomValidity(""); }, [serialized]);
  return <label className="wf-json-field">{label}<textarea ref={input} aria-label={label} spellCheck={false} readOnly={readOnly}
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

function ExitOptions({ node }: { node: WorkflowNode }): JSX.Element {
  return <>{node.exits.map(exit => <option key={exit.id} value={exit.id}>{exit.name}</option>)}</>;
}

function OutputField({ name: initialName, type, node, onEdit }: {
  name: string; type: WorkflowType; node: WorkflowNode; onEdit: FieldsProps["onEdit"];
}): JSX.Element {
  const [name, setName] = useState(initialName), [error, setError] = useState("");
  const choices = ["text", "number", "boolean", "json", "list<text>", "list<json>"];
  return <div className="wf-output-field">
    <div className="wf-rule-row"><input aria-label={initialName + "的字段名称"} value={name} onChange={event => { setName(event.target.value); setError(""); event.target.setCustomValidity(""); }} onBlur={event => {
      const key = name.trim();
      if (!key || (key !== initialName && Object.hasOwn(node.outputs || {}, key))) { setError("字段名不能为空或重复。"); event.target.setCustomValidity("字段名不能为空或重复。"); return; }
      event.target.setCustomValidity("");
      if (key !== initialName) onEdit(node => { node.outputs = Object.fromEntries(Object.entries(node.outputs || {}).map(([name, value]) => [name === initialName ? key : name, value])); });
    }}/><select aria-label={initialName + "的字段类型"} value={typeof type === "string" && choices.includes(type) ? type : "custom"} onChange={event => onEdit(node => {
      node.outputs ||= {}; node.outputs[initialName] = event.target.value === "custom" ? { properties: { value: "text" }, required: ["value"] } : event.target.value as WorkflowType;
    })}><option value="text">文本</option><option value="number">数值</option><option value="boolean">是 / 否</option><option value="json">任意结果</option><option value="list<text>">文本列表</option><option value="list<json>">结果列表</option><option value="custom">结构化类型</option></select>
      <button aria-label={"移除字段 " + initialName} onClick={() => onEdit(node => { delete node.outputs?.[initialName]; })}><X size={12}/></button>
    </div>
    {error && <small className="wf-field-error" role="alert">{error}</small>}
    {(typeof type !== "string" || !choices.includes(type)) && <JsonField label={initialName + "的结构化类型"} value={type} readOnly={false} onCommit={value => onEdit(node => { node.outputs ||= {}; node.outputs[initialName] = value as WorkflowType; })}/>}
  </div>;
}

export function WorkflowFields({ node, definition, templates, verificationTemplates = [], readOnly, onEdit }: FieldsProps): JSX.Element | null {
  if (node.kind === "join") {
    const sources = [...new Set(definition.edges.filter(edge => edge.to === node.id || edge.onLimit === node.id).map(edge => edge.from[0]))];
    return <div className="wf-control-fields">
      <label className="wf-inline-field">等待方式<select disabled={readOnly} value={node.wait || "all"} onChange={event => onEdit(node => { node.wait = event.target.value as WorkflowNode["wait"]; if (node.wait === "quorum") node.quorum ||= 1; })}><option value="all">全部来源</option><option value="firstValid">首个合格结果</option><option value="quorum">达到指定份数</option></select></label>
      <label className="wf-inline-field">所属分派<select disabled={readOnly} value={node.scope || ""} onChange={event => onEdit(node => { node.scope = event.target.value; if (definition.nodes.find(n => n.id === node.scope)?.forEach) delete node.sources; })}>{definition.nodes.filter(n => n.id !== node.id).map(n => <option key={n.id} value={n.id}>{nodeLabel(n)}</option>)}</select></label>
      <label className="wf-inline-field">汇合范围<select disabled={readOnly} value={node.sources?.length ? "nodes" : "branches"} onChange={event => onEdit(node => { if (event.target.value === "nodes") node.sources = sources; else delete node.sources; })}><option value="branches">本批分支 / 列表项</option><option value="nodes" disabled={!sources.length || !!definition.nodes.find(n => n.id === node.scope)?.forEach}>已连接的来源节点</option></select></label>
      {!!node.sources?.length && <div className="wf-source-chips" aria-label="汇合来源">{node.sources.map(id => <span key={id}>{definition.nodes.find(n => n.id === id) ? nodeLabel(definition.nodes.find(n => n.id === id)!) : id}</span>)}</div>}
      {node.wait === "quorum" && <label className="wf-inline-field">所需份数<input aria-label="汇合所需份数" disabled={readOnly} type="number" min={1} max={node.sources?.length} value={node.quorum || 1} onChange={event => onEdit(node => { node.quorum = Number(event.target.value); })}/></label>}
      <label className="wf-inline-field">其余来源<select disabled={readOnly} value={node.remaining || "continue"} onChange={event => onEdit(node => { node.remaining = event.target.value as WorkflowNode["remaining"]; })}><option value="continue">继续执行</option><option value="cancel">结果足够后取消</option></select></label>
      <p className="wf-field-help">{node.sources?.length ? "同一份结果可以交给多个汇合，各自独立等待。" : "等待本次实际分派的分支，或列表中的各项。"}</p>
    </div>;
  }
  if (node.kind === "condition") return <div className="wf-control-fields">
    <p className="wf-field-help">按顺序检查结果字段，匹配后沿对应出口前进。</p>
    {node.cases?.map((rule, index) => <div className="wf-condition-rule" key={index}>
      <label className="wf-inline-field">字段<input aria-label={`条件 ${index + 1} 的字段`} readOnly={readOnly} placeholder="incoming.result.approved" value={rule.path} onChange={event => onEdit(node => { node.cases![index].path = event.target.value; })}/></label>
      <label className="wf-inline-field">判断方式<select disabled={readOnly} value={rule.operator || "eq"} onChange={event => onEdit(node => {
        node.cases![index].operator = event.target.value as NonNullable<WorkflowNode["cases"]>[number]["operator"];
      })}>{Object.entries({ eq: "等于", ne: "不等于", gt: "大于", ge: "大于等于", lt: "小于", le: "小于等于", exists: "有值", missing: "缺少字段" }).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      {!["exists", "missing"].includes(rule.operator || "") && <JsonField label={`条件 ${index + 1} ${!rule.operator || rule.operator === "eq" ? "等于" : "比较值"}`} value={rule.equals} readOnly={readOnly} onCommit={value => onEdit(node => { node.cases![index].equals = value; })}/>}
      <label className="wf-inline-field">匹配出口<select disabled={readOnly} value={rule.exit} onChange={event => onEdit(node => { node.cases![index].exit = event.target.value; })}><ExitOptions node={node}/></select>{!readOnly && <button aria-label={`移除条件 ${index + 1}`} onClick={() => onEdit(node => { node.cases!.splice(index, 1); })}><X size={12}/></button>}</label>
    </div>)}
    {!readOnly && <button className="wf-add-exit" onClick={() => onEdit(node => { node.cases ||= []; node.cases.push({ path: "incoming.result.approved", equals: true, exit: node.exits[0]?.id || "" }); })}><Plus size={12}/>添加判断条件</button>}
    <label className="wf-inline-field">都不匹配<select disabled={readOnly} value={node.otherwise || ""} onChange={event => onEdit(node => { node.otherwise = event.target.value; })}><option value="">选择默认出口</option><ExitOptions node={node}/></select></label>
  </div>;
  if (node.kind === "call") return <div className="wf-control-fields">
    <label className="wf-inline-field">引用流程<select disabled={readOnly} value={node.ref ? `${node.ref.id}@${node.ref.revision}` : ""} onChange={event => {
      const template = templates.find(template => `${template.id}@${template.revision}` === event.target.value);
      if (!template) { onEdit(node => { delete node.ref; node.input = {}; node.exitMap = {}; }); return; }
      const returns = [...new Set(template.definition.edges.filter(edge => edge.to === "$return").map(edge => template.definition.nodes.find(n => n.id === edge.from[0])?.exits.find(exit => exit.id === edge.from[1])?.name).filter((name): name is string => !!name))];
      onEdit(node => { node.ref = { id: template.id, revision: template.revision }; node.input = Object.fromEntries(Object.keys(template.definition.inputs || {}).map(key => [key, node.input?.[key] ?? ""])); node.exitMap = Object.fromEntries(returns.map(name => [name, node.exitMap?.[name] || node.exits[0]?.id || ""])); });
    }}><option value="">选择已保存的流程</option>{node.ref && !templates.some(t => t.id === node.ref?.id && t.revision === node.ref?.revision) && <option value={`${node.ref.id}@${node.ref.revision}`}>{node.ref.id} · 修订 {node.ref.revision}</option>}{templates.filter(template => template.id !== definition.id).map(template => <option key={template.id} value={`${template.id}@${template.revision}`}>{template.name} · 修订 {template.revision}</option>)}</select></label>
    <p className="wf-field-help">本次引用固定到所选修订。模板以后更新，不会改动这次流程。</p>
    <JsonField label="子流程输入映射" value={node.input || {}} readOnly={readOnly} object onCommit={value => onEdit(node => { node.input = value as WorkflowNode["input"]; })}/>
    {Object.entries(node.exitMap || {}).map(([name, exit]) => <label className="wf-inline-field" key={name}>{name}<span>→</span><select aria-label={name + "返回时的出口"} disabled={readOnly} value={exit} onChange={event => onEdit(node => { node.exitMap![name] = event.target.value; })}><ExitOptions node={node}/></select></label>)}
    {!Object.keys(node.exitMap || {}).length && <JsonField label="子流程出口映射" value={node.exitMap || {}} readOnly={readOnly} object onCommit={value => onEdit(node => { node.exitMap = value as WorkflowNode["exitMap"]; })}/>}
  </div>;
  if (node.kind === "agent" && !readOnly) return <><details className="wf-advanced-fields">
    <summary>结果与派发规则</summary>
    <label className="wf-inline-field">出口选择<select value={node.exitMode || "one"} onChange={event => onEdit(node => { node.exitMode = event.target.value as WorkflowNode["exitMode"]; })}><option value="one">选择一个出口</option><option value="some">允许同时选择多个</option></select></label>
    <div className="wf-field-title">结果字段</div>{Object.entries(node.outputs || {}).map(([name, type]) => <OutputField key={name} name={name} type={type} node={node} onEdit={onEdit}/>)}
    <button className="wf-add-exit" onClick={() => onEdit(node => { node.outputs ||= {}; let name = "field"; for (let i = 2; Object.hasOwn(node.outputs, name); i++) name = `field_${i}`; node.outputs[name] = "text"; })}><Plus size={12}/>添加结果字段</button>
    <label className="wf-inline-field wf-toggle-field"><input type="checkbox" checked={!!node.forEach} onChange={event => onEdit(node => { if (event.target.checked) node.forEach = { source: "incoming.result.items", key: "id", maxItems: 20, maxParallel: 3, emptyExit: node.exits[0]?.id }; else delete node.forEach; })}/>按列表逐项派发</label>
    {node.forEach && <div className="wf-condition-rule">
      <label className="wf-inline-field">列表来源<input value={node.forEach.source} aria-label="派发列表来源" onChange={event => onEdit(node => { node.forEach!.source = event.target.value; })}/></label>
      <label className="wf-inline-field">每项标识<input value={node.forEach.key} aria-label="列表项唯一标识" onChange={event => onEdit(node => { node.forEach!.key = event.target.value; })}/></label>
      <label className="wf-inline-field">最多项数<input type="number" min={1} value={node.forEach.maxItems} onChange={event => onEdit(node => { node.forEach!.maxItems = Number(event.target.value); })}/></label>
      <label className="wf-inline-field">同时执行<input type="number" min={1} max={node.forEach.maxItems} value={node.forEach.maxParallel} onChange={event => onEdit(node => { node.forEach!.maxParallel = Number(event.target.value); })}/></label>
      <label className="wf-inline-field">列表为空<select value={node.forEach.emptyExit || ""} onChange={event => onEdit(node => { node.forEach!.emptyExit = event.target.value; })}><option value="">选择出口</option><ExitOptions node={node}/></select></label>
    </div>}
    <label className="wf-inline-field">执行失败<select value={node.onError || ""} onChange={event => onEdit(node => { if (event.target.value) node.onError = event.target.value; else delete node.onError; })}><option value="">交由引擎判断与升级</option><ExitOptions node={node}/></select></label>
    <label className="wf-inline-field">最多尝试<input type="number" min={1} max={5} value={node.maxAttempts || 1} onChange={event => onEdit(node => { node.maxAttempts = Number(event.target.value); })}/></label>
    <JsonField label="变量缺失时的默认值" value={node.fallbacks || {}} object readOnly={false} onCommit={value => onEdit(node => { node.fallbacks = value as Record<string, unknown>; })}/>
    <label className="wf-verification-option"><input type="checkbox" checked={!!node.dynamicSubflow} onChange={event => onEdit(node => {
      if (event.target.checked) node.dynamicSubflow = { roles: node.role ? [node.role] : [], maxInstances: 12, maxDepth: 0 };
      else delete node.dynamicSubflow;
    })}/>允许这个 Agent 临时创建子流程</label>
    {node.dynamicSubflow && <div className="wf-condition-rule">
      <JsonField label="子流程可以使用的角色" value={node.dynamicSubflow.roles} readOnly={false} onCommit={value => onEdit(node => { node.dynamicSubflow!.roles = value as string[]; })}/>
      <label className="wf-inline-field">子图实例上限<input type="number" min={1} max={100000} value={node.dynamicSubflow.maxInstances} onChange={event => onEdit(node => { node.dynamicSubflow!.maxInstances = Number(event.target.value); })}/></label>
      <label className="wf-inline-field">允许再嵌套的层数<input type="number" min={0} max={31} value={node.dynamicSubflow.maxDepth} onChange={event => onEdit(node => { node.dynamicSubflow!.maxDepth = Number(event.target.value); })}/></label>
    </div>}
  </details><details className="wf-workspace-fields">
    <summary>工作区与验收</summary>
    <label className="wf-inline-field">工作区<select aria-label="节点工作区策略" value={node.workspace?.mode || "inherit"} onChange={event => onEdit(node => { node.workspace ||= {}; node.workspace.mode = event.target.value as "inherit" | "isolated"; })}><option value="inherit">沿用项目设置</option><option value="isolated">独立 Git 工作区</option></select></label>
    <label className="wf-path-field">允许修改的路径<textarea aria-label="节点允许修改的路径" spellCheck={false} rows={3} placeholder={"留空表示项目目录内均可修改\n例如 src/**"} value={(node.workspace?.allowedPaths || []).join("\n")} onChange={event => onEdit(node => { node.workspace ||= {}; node.workspace.allowedPaths = event.target.value.split("\n"); })} onBlur={event => onEdit(node => { node.workspace ||= {}; node.workspace.allowedPaths = event.target.value.split("\n").map(path => path.trim()).filter(Boolean); })}/></label>
    <p className="wf-field-help">每行一个相对路径，可用 * 与 **。配置路径范围后使用独立工作区，在交给下游前检查全部修改。</p>
    <div className="wf-field-title">项目验收项</div>
    <label className="wf-inline-field">验收规则<select aria-label="节点验收规则" value={node.workspace?.verificationTemplates === undefined ? "inherit" : "custom"} onChange={event => onEdit(node => { node.workspace ||= {}; if (event.target.value === "inherit") delete node.workspace.verificationTemplates; else node.workspace.verificationTemplates = []; })}><option value="inherit">沿用项目的全部检查</option><option value="custom">选择可选检查</option></select></label>
    {verificationTemplates.filter(template => template.scopes.includes("task")).map(template => <label className="wf-verification-option" key={template.id}>
      <input aria-label={"验收项 " + template.name} type="checkbox" checked={template.required || node.workspace?.verificationTemplates === undefined || !!node.workspace.verificationTemplates.includes(template.id)} disabled={template.required || node.workspace?.verificationTemplates === undefined} onChange={event => onEdit(node => { node.workspace ||= {}; const ids = new Set(node.workspace.verificationTemplates || []); if (event.target.checked) ids.add(template.id); else ids.delete(template.id); node.workspace.verificationTemplates = [...ids]; })}/><span>{template.name}</span>{template.required && <small>必需</small>}
    </label>)}
    {!verificationTemplates.length && <p className="wf-field-help">选择运行会话后，显示该项目登记的验收项。项目要求的检查始终执行。</p>}
    {(node.workspace?.verificationTemplates || []).filter(id => !verificationTemplates.some(template => template.id === id)).map(id => <div className="wf-verification-option" key={id}><code>{id}</code><small>待核对项目</small><button aria-label={"移除验收项 " + id} onClick={() => onEdit(node => { node.workspace!.verificationTemplates = node.workspace!.verificationTemplates!.filter(value => value !== id); })}><X size={12}/></button></div>)}
  </details></>;
  return null;
}
