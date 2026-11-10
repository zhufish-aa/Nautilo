import { useState, type ReactNode } from "react";
import { DEFAULT_REASONING_EFFORTS, withDefaultReasoning } from "../../lib/model-reasoning";
import { ArrowDown, ArrowRight, ArrowUp, Info, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { useI18n } from "../../lib/i18n";
import { newId } from "../../lib/utils";
import { effortValues, modelRow, priceKeys, type ModelRow } from "./model-editor";

export function ModelConfigurationEditor({ models, onChange, fetchAction }: {
  models: ModelRow[];
  onChange: (models: ModelRow[]) => void;
  fetchAction?: ReactNode;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [tab, setTab] = useState<"reasoning" | "pricing">("reasoning");
  const [newEffort, setNewEffort] = useState("");
  const [pricingToggles, setPricingToggles] = useState<Record<string, boolean>>({});
  const selected = models.find((row) => row.key === selectedKey) ?? models[0];
  const visible = models.filter((row) => `${row.displayName} ${row.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const patch = (key: string, changes: Partial<ModelRow>): void => onChange(models.map((row) => row.key === key ? { ...row, ...changes } : row));
  const add = (): void => {
    const row = modelRow(withDefaultReasoning({ id: "", defaultReasoningEffort: "low" }), newId("model"));
    onChange([...models, row]);
    setSelectedKey(row.key);
    setQuery("");
    setNewEffort("");
  };
  const move = (key: string, offset: number): void => {
    const next = [...models];
    const index = next.findIndex((row) => row.key === key);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const updateEfforts = (values: string[]): void => {
    if (!selected) return;
    patch(selected.key, {
      efforts: values.join(", "),
      defaultReasoningEffort: values.includes(selected.defaultReasoningEffort) ? selected.defaultReasoningEffort : values[0] ?? ""
    });
  };
  const addEffort = (): void => {
    if (!selected || !newEffort.trim()) return;
    updateEfforts(effortValues(`${selected.efforts}, ${newEffort}`));
    setNewEffort("");
  };
  const efforts = selected ? effortValues(selected.efforts) : [];
  const pricingEnabled = selected ? pricingToggles[selected.key] ?? priceKeys.some((key) => selected[key].trim()) : false;
  const labels = {
    input: zh ? "输入价格" : "Input price", output: zh ? "输出价格" : "Output price",
    cacheRead: zh ? "缓存读取价格" : "Cache read price", cacheWrite: zh ? "缓存写入价格" : "Cache write price"
  };

  return <div className="model-configuration">
    <aside className="model-catalog">
      <div className="model-catalog-actions">
        {fetchAction}
        <Button variant="primary" onClick={add}><Plus size={18} />{zh ? "手动添加" : "Add model"}</Button>
      </div>
      <div className="model-search"><Search size={20} aria-hidden /><Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={zh ? "搜索模型" : "Search models"} placeholder={zh ? "搜索模型名称或 ID" : "Search model name or ID"} /></div>
      <div className="model-catalog-list">
        {visible.map((row) => <div key={row.key} className={`model-catalog-row ${selected?.key === row.key ? "is-selected" : ""}`}>
          <button type="button" aria-pressed={selected?.key === row.key} onClick={() => { setSelectedKey(row.key); setNewEffort(""); }}>
            <strong>{row.displayName || row.id || (zh ? "新模型" : "New model")}</strong>
            <span>{row.id || (zh ? "填写模型 ID" : "Enter model ID")}</span>
          </button>
          <Switch checked={row.enabled} onCheckedChange={(enabled) => patch(row.key, { enabled })} aria-label={`${row.displayName || row.id} ${zh ? "启用模型" : "Enable model"}`} />
        </div>)}
        {!visible.length && <p className="model-empty">{models.length ? (zh ? "没有匹配的模型" : "No matching models") : (zh ? "获取模型，或手动添加服务商提供的模型 ID。" : "Fetch models or add a model ID from your provider.")}</p>}
      </div>
      <p className="model-catalog-count">{zh ? `${models.length} 个模型 · ${models.filter((row) => row.enabled).length} 个已启用` : `${models.length} models · ${models.filter((row) => row.enabled).length} enabled`}</p>
    </aside>
    {selected ? <section className="model-detail" aria-label={zh ? "编辑模型" : "Edit model"}>
      <header className="model-detail-heading">
        <h3>{selected.displayName || selected.id || (zh ? "新模型" : "New model")}</h3>
        <span className="model-status">{selected.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已停用" : "Disabled")}</span>
        <div className="model-row-actions">
          <Button variant="ghost" size="icon" disabled={models[0]?.key === selected.key} onClick={() => move(selected.key, -1)} aria-label={zh ? "上移模型" : "Move model up"}><ArrowUp size={16} /></Button>
          <Button variant="ghost" size="icon" disabled={models.at(-1)?.key === selected.key} onClick={() => move(selected.key, 1)} aria-label={zh ? "下移模型" : "Move model down"}><ArrowDown size={16} /></Button>
          <Button variant="ghost" size="icon" onClick={() => { onChange(models.filter((row) => row.key !== selected.key)); setSelectedKey(undefined); }} aria-label={zh ? "移除模型" : "Remove model"}><Trash2 size={16} /></Button>
        </div>
      </header>
      <div className="model-identity">
        <Field label={zh ? "显示名称" : "Display name"}><Input value={selected.displayName} onChange={(event) => patch(selected.key, { displayName: event.target.value })} aria-label={zh ? "显示名称" : "Display name"} /></Field>
        <ArrowRight size={22} aria-hidden />
        <Field label={zh ? "上游模型 ID" : "Upstream model ID"}><Input value={selected.id} onChange={(event) => patch(selected.key, { id: event.target.value })} className="font-mono" spellCheck={false} aria-label={zh ? "上游模型 ID" : "Upstream model ID"} /></Field>
      </div>
      <div className="model-tabs" role="tablist" aria-label={zh ? "模型设置" : "Model settings"}>
        <button role="tab" aria-selected={tab === "reasoning"} aria-controls="model-reasoning-panel" id="model-reasoning-tab" tabIndex={tab === "reasoning" ? 0 : -1} onKeyDown={(event) => { if (event.key === "ArrowRight") { setTab("pricing"); document.getElementById("model-pricing-tab")?.focus(); } }} onClick={() => setTab("reasoning")}>{zh ? "能力与推理" : "Capabilities & reasoning"}</button>
        <button role="tab" aria-selected={tab === "pricing"} aria-controls="model-pricing-panel" id="model-pricing-tab" tabIndex={tab === "pricing" ? 0 : -1} onKeyDown={(event) => { if (event.key === "ArrowLeft") { setTab("reasoning"); document.getElementById("model-reasoning-tab")?.focus(); } }} onClick={() => setTab("pricing")}>{zh ? "价格与缓存" : "Pricing & cache"}</button>
      </div>
      {tab === "reasoning" ? <div role="tabpanel" id="model-reasoning-panel" aria-labelledby="model-reasoning-tab">
        <div className="model-image-capability">
          <label htmlFor="model-image-input">{zh ? "支持图片输入" : "Image input"}</label>
          <Switch id="model-image-input" checked={selected.inputModalities?.includes("image") ?? false} onCheckedChange={enabled => patch(selected.key, { inputModalities: enabled ? ["text", "image"] : ["text"] })} aria-label={zh ? "支持图片输入" : "Image input"} />
        </div>
        <div className="model-reasoning-card">
          <div className="model-section-heading"><h4>{zh ? "推理强度" : "Reasoning effort"}</h4><label><Switch checked={efforts.length > 0} onCheckedChange={(enabled) => updateEfforts(enabled ? DEFAULT_REASONING_EFFORTS : [])} aria-label={zh ? "启用推理强度" : "Enable reasoning effort"} />{zh ? "启用" : "Enable"}</label></div>
          <p className="model-help">{zh ? "关闭后不发送推理强度参数。" : "When disabled, reasoning effort is omitted."}</p>
          {efforts.length > 0 && <>
            <div className="model-effort-row"><span>{zh ? "可选档位" : "Options"}</span><div className="model-effort-input">
              <div className="model-effort-tags">{efforts.map((effort) => <span key={effort}>{effort}<button aria-label={`${zh ? "移除" : "Remove"} ${effort}`} onClick={() => updateEfforts(efforts.filter((value) => value !== effort))}><X size={14} /></button></span>)}</div>
              <div className="model-effort-add"><Input value={newEffort} onChange={(event) => setNewEffort(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addEffort(); } }} placeholder={zh ? "输入自定义档位" : "Custom effort level"} aria-label={zh ? "自定义推理档位" : "Custom reasoning effort"} /><Button variant="outline" disabled={!newEffort.trim()} onClick={addEffort}><Plus size={16} />{zh ? "添加" : "Add"}</Button></div>
            </div></div>
            <div className="model-effort-row"><span>{zh ? "默认强度" : "Default effort"}</span><SelectField value={selected.defaultReasoningEffort || efforts[0]} options={efforts.map((value) => ({ value, label: value }))} onValueChange={(value) => patch(selected.key, { defaultReasoningEffort: value })} aria-label={zh ? "默认推理强度" : "Default reasoning effort"} /></div>
          </>}
        </div>
        <details className="model-context"><summary>{zh ? "上下文窗口" : "Context window"}</summary><Input type="number" min={1} step={1} value={selected.contextWindow} onChange={(event) => patch(selected.key, { contextWindow: event.target.value })} aria-label={zh ? "上下文窗口 token 数" : "Context window tokens"} placeholder={zh ? "服务商默认" : "Provider default"} /></details>
      </div> : <div role="tabpanel" id="model-pricing-panel" aria-labelledby="model-pricing-tab" className="model-pricing">
        <div className="model-section-heading"><h4>{zh ? "模型价格" : "Model pricing"}</h4><span className="model-status">{zh ? "可选" : "Optional"}</span><Switch checked={pricingEnabled} onCheckedChange={(enabled) => { setPricingToggles((current) => ({ ...current, [selected.key]: enabled })); if (!enabled) patch(selected.key, { input: "", output: "", cacheRead: "", cacheWrite: "" }); }} aria-label={zh ? "启用价格配置" : "Enable pricing"} /><a href="#/settings?section=usage">{zh ? "用量与费用 ↗" : "Usage & costs ↗"}</a></div>
        <span className="model-status model-pricing-source">{zh ? "手动配置" : "Manual rates"}</span>
        <div className="model-pricing-grid"><Field label={zh ? "币种" : "Currency"}><div className="model-static-field">USD</div></Field><Field label={zh ? "计价单位" : "Unit"}><div className="model-static-field">{zh ? "每 1M tokens" : "Per 1M tokens"}</div></Field>
          {priceKeys.map((key) => <Field key={key} label={labels[key]}><div className="model-price-input"><Input type="number" disabled={!pricingEnabled} min={0} step="any" value={selected[key]} placeholder={zh ? "未设置" : "Not set"} onChange={(event) => patch(selected.key, { [key]: event.target.value })} aria-label={labels[key]} /><span>USD</span></div></Field>)}
        </div>
        <p className="model-pricing-note"><Info size={18} />{zh ? "未设置不代表免费，缺少价格时仅显示已知费用。" : "Unset prices are unknown. Only known costs are included."}</p>
        <p className="model-help">{zh ? "费用为本地估算，以供应商账单为准。" : "Costs are local estimates. Refer to your provider’s bill."}</p>
      </div>}
    </section> : <div className="model-empty model-detail">{zh ? "选择或添加一个模型，开始配置。" : "Select or add a model to configure it."}</div>}
  </div>;
}
