import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { useI18n } from "../../lib/i18n";
import { newId } from "../../lib/utils";
import { effortValues, modelRow, priceKeys, type ModelRow } from "./model-editor";

export function ModelConfigurationEditor({ models, onChange }: { models: ModelRow[]; onChange: (models: ModelRow[]) => void }): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>();
  const selected = models.find((row) => row.key === selectedKey);
  const patch = (key: string, changes: Partial<ModelRow>): void => onChange(models.map((row) => row.key === key ? { ...row, ...changes } : row));
  const add = (): void => {
    const row = modelRow({ id: "", reasoningEfforts: [] }, newId("model"));
    onChange([...models, row]); setSelectedKey(row.key); setQuery("");
  };
  const move = (key: string, offset: number): void => {
    const next = [...models]; const index = next.findIndex((row) => row.key === key); const target = index + offset;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!]; onChange(next);
  };
  const labels = { input: zh ? "输入价格" : "Input", output: zh ? "输出价格" : "Output", cacheRead: zh ? "缓存读取" : "Cache read", cacheWrite: zh ? "缓存写入" : "Cache write" };
  return <div className="space-y-4">
    <div className="flex items-center gap-3">
      <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={zh ? "搜索模型" : "Search models"} placeholder={zh ? "搜索模型名称或 ID" : "Search models by name or ID"} /></div>
      <Button variant="outline" size="sm" onClick={add}><Plus className="h-4 w-4" />{zh ? "手动添加" : "Add model"}</Button>
    </div>
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_52px_64px] gap-3 border-b border-line px-4 py-3 text-xs text-ink-3"><span>{zh ? "显示名称" : "Display name"}</span><span>{zh ? "上游模型 ID" : "Upstream model ID"}</span><span>{zh ? "启用" : "Enabled"}</span><span>{zh ? "价格" : "Pricing"}</span></div>
      {models.filter((row) => `${row.displayName} ${row.id}`.toLowerCase().includes(query.toLowerCase())).map((row) => <div key={row.key} className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_52px_64px] items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 ${selectedKey === row.key ? "bg-hover" : ""}`}>
        <button type="button" className="truncate text-left text-sm font-medium text-ink hover:underline" onClick={() => setSelectedKey(row.key)}>{row.displayName || row.id || (zh ? "新模型" : "New model")}</button>
        <button type="button" className="truncate text-left font-mono text-xs text-ink-2" onClick={() => setSelectedKey(row.key)}>{row.id || "—"}</button>
        <Switch checked={row.enabled} onCheckedChange={(enabled) => patch(row.key, { enabled })} aria-label={`${row.displayName || row.id}: ${zh ? "启用模型" : "Enable model"}`} />
        <button type="button" onClick={() => setSelectedKey(row.key)} className="text-left text-xs text-ink-3">{priceKeys.some((key) => row[key].trim()) ? (zh ? "已设置" : "Set") : (zh ? "未设置" : "Not set")}</button>
      </div>)}
      {models.length === 0 && <p className="px-4 py-6 text-sm text-ink-3">{zh ? "尚未配置模型。获取模型，或输入服务商提供的模型 ID。" : "Fetch models or add a model ID supplied by your provider."}</p>}
      {models.length > 0 && !models.some((row) => `${row.displayName} ${row.id}`.toLowerCase().includes(query.toLowerCase())) && <p className="px-4 py-6 text-sm text-ink-3">{zh ? "没有匹配的模型" : "No matching models"}</p>}
    </div>
    {selected && <section className="space-y-5 rounded-lg border border-line p-5" aria-label={zh ? "编辑模型" : "Edit model"}>
      <div className="flex items-center justify-between"><h3 className="text-sm font-medium">{zh ? "编辑模型" : "Edit model"}</h3><div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" disabled={models[0]?.key === selected.key} onClick={() => move(selected.key, -1)} aria-label={zh ? "上移模型" : "Move model up"}><ArrowUp className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" disabled={models.at(-1)?.key === selected.key} onClick={() => move(selected.key, 1)} aria-label={zh ? "下移模型" : "Move model down"}><ArrowDown className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={() => { onChange(models.filter((row) => row.key !== selected.key)); setSelectedKey(undefined); }} aria-label={zh ? "移除模型" : "Remove model"}><Trash2 className="h-4 w-4" /></Button>
      </div></div>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={zh ? "显示名称" : "Display name"}><Input value={selected.displayName} onChange={(event) => patch(selected.key, { displayName: event.target.value })} aria-label={zh ? "显示名称" : "Display name"} /></Field><Field label={zh ? "上游模型 ID" : "Upstream model ID"}><Input value={selected.id} onChange={(event) => patch(selected.key, { id: event.target.value })} className="font-mono" spellCheck={false} aria-label={zh ? "上游模型 ID" : "Upstream model ID"} /></Field></div>
      <div className="space-y-4 border-t border-line pt-4"><h4 className="text-sm font-medium">{zh ? "推理强度" : "Reasoning strength"}</h4><div className="grid gap-4 sm:grid-cols-2">
        <Field label={zh ? "可选值（逗号分隔）" : "Option values (comma-separated)"}><Input value={selected.efforts} placeholder="low, medium, high" onChange={(event) => { const efforts = event.target.value; const values = effortValues(efforts); patch(selected.key, { efforts, defaultReasoningEffort: values.includes(selected.defaultReasoningEffort) ? selected.defaultReasoningEffort : values[0] ?? "" }); }} aria-label={zh ? "推理强度可选值" : "Reasoning values"} /></Field>
        <Field label={zh ? "默认推理强度" : "Default reasoning strength"}><SelectField value={selected.defaultReasoningEffort || effortValues(selected.efforts)[0] || "__provider_default"} options={effortValues(selected.efforts).length ? effortValues(selected.efforts).map((value) => ({ value, label: value })) : [{ value: "__provider_default", label: zh ? "服务商默认" : "Provider default" }]} onValueChange={(value) => patch(selected.key, { defaultReasoningEffort: value === "__provider_default" ? "" : value })} aria-label={zh ? "默认推理强度" : "Default reasoning strength"} /></Field>
      </div><p className="text-xs text-ink-3">{zh ? "填写服务商支持的原始值。此处配置不会检测上游是否支持该强度。" : "Use values supported by your provider. These settings do not verify upstream support."}</p></div>
      <div className="space-y-4 border-t border-line pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{zh ? "价格配置" : "Pricing"}</h4><span className="text-xs text-ink-3">USD / 1M tokens</span></div><div className="grid grid-cols-2 gap-4">{priceKeys.map((key) => <Field key={key} label={labels[key]}><Input type="number" min={0} step="any" value={selected[key]} placeholder={zh ? "未设置" : "Not set"} onChange={(event) => patch(selected.key, { [key]: event.target.value })} aria-label={labels[key]} /></Field>)}</div><p className="text-xs text-ink-3">{zh ? "自定义价格仅用于估算，不是账单。留空不计价；0 表示免费。" : "User-entered rates are estimates, not billing. Blank means unknown; 0 means free."}</p></div>
      <details className="border-t border-line pt-4"><summary className="flex cursor-pointer items-center gap-2 text-sm text-ink-2"><ChevronDown className="h-4 w-4" />{zh ? "上下文窗口" : "Context window"}</summary><Input className="mt-3" type="number" min={1} step={1} value={selected.contextWindow} onChange={(event) => patch(selected.key, { contextWindow: event.target.value })} aria-label={zh ? "上下文窗口 token 数" : "Context window tokens"} placeholder={zh ? "服务商默认" : "Provider default"} /></details>
      <p className="text-xs text-ink-3">{zh ? "模型修改随连接设置一起保存。" : "Model changes are saved with this connection."}</p>
    </section>}
  </div>;
}
