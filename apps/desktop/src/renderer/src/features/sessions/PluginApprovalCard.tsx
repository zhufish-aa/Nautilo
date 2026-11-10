import { useId, useState } from "react";
import { Check, Download, ExternalLink, Github, Info, LoaderCircle, Puzzle } from "lucide-react";
import type { InteractionRequest, InteractionResponse } from "@agenthub/domain";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import "./PluginApprovalCard.css";

type Presentation = NonNullable<InteractionRequest["presentation"]>;

export function pluginPresentation(interaction: InteractionRequest): Presentation | undefined {
  if (interaction.kind !== "approval") return undefined;
  if (interaction.presentation) return interaction.presentation;
  // Keep an approval already open during a renderer update usable.
  const legacy = /^(安装|连接|Install|Connect)\s+(.+)$/i.exec(interaction.title);
  if (interaction.providerId !== "codex" || !legacy || !interaction.options?.some((option) => option.id === "confirm")) return undefined;
  return { type: /^(安装|Install)$/i.test(legacy[1]!) ? "plugin_install" : "plugin_authorization", name: legacy[2]! };
}

export function PluginApprovalCard({ interaction, presentation, onRespond }: {
  interaction: InteractionRequest;
  presentation: Presentation;
  onRespond: (interaction: InteractionRequest, response: InteractionResponse) => Promise<void>;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [opening, setOpening] = useState<string>();
  const [opened, setOpened] = useState(false);
  const authorize = presentation.type === "plugin_authorization";
  const github = /^github(?:@|$)/i.test(presentation.pluginId ?? presentation.name);
  const Mark = github ? Github : Puzzle;
  const approve = interaction.options?.find((option) => option.intent === "approve" || option.id === "confirm");
  const decline = interaction.options?.find((option) => option.intent === "reject" || option.id === "decline");
  const links = interaction.links ?? [];
  const title = `${authorize ? (zh ? "连接" : "Connect") : (zh ? "安装" : "Install")} ${presentation.name}`;

  const respond = async (accept: boolean): Promise<void> => {
    if (submitting) return;
    const option = accept ? approve : decline;
    if (accept && !option) return;
    setSubmitting(true);
    try { await onRespond(interaction, option ? { outcome: "selected", optionId: option.id } : { outcome: "cancelled" }); }
    finally { setSubmitting(false); }
  };
  const open = async (url: string): Promise<void> => {
    if (opening) return;
    setOpening(url);
    try {
      const bridge = getBridge();
      if (!bridge) throw new Error(zh ? "请在桌面应用中打开授权页面" : "Open authorization in the desktop app");
      await bridge.shell.openExternal(url);
      setOpened(true);
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(undefined); }
  };

  return <article className="plugin-approval-card" aria-label={title} aria-busy={submitting}>
    <div className="plugin-approval-identity">
      <span className="plugin-approval-mark" data-brand={github ? "github" : "plugin"}><Mark size={23} strokeWidth={1.8} aria-hidden /></span>
      <h3>{title}</h3>
      {interaction.detail && <Tooltip content={zh ? "查看请求详情" : "View request details"}><button type="button" className="plugin-approval-info" aria-label={zh ? "查看请求详情" : "View request details"} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}><Info size={15} aria-hidden /></button></Tooltip>}
    </div>
    <div className="plugin-approval-actions">
      <Button variant="ghost" size="sm" disabled={submitting} onClick={() => void respond(false)}>{zh ? "暂不" : "Not now"}</Button>
      {links.map((link, index) => <Button key={link.url} variant={!opened && index === 0 ? "primary" : "outline"} size="sm" disabled={submitting || Boolean(opening)} onClick={() => void open(link.url)}>
        {opening === link.url ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : <ExternalLink size={14} aria-hidden />}
        {links.length === 1 ? (zh ? "前往授权" : "Authorize") : link.label}
      </Button>)}
      <Button variant={!authorize || opened || !links.length ? "primary" : "outline"} size="sm" disabled={submitting || !approve} onClick={() => void respond(true)}>
        {submitting ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : authorize ? <Check size={14} aria-hidden /> : <Download size={14} aria-hidden />}
        {submitting ? (zh ? "处理中" : "Processing") : authorize ? (zh ? "检查连接" : "Check connection") : (zh ? "安装" : "Install")}
      </Button>
    </div>
    {expanded && <div className="plugin-approval-detail" id={detailId}>{interaction.detail}</div>}
  </article>;
}
