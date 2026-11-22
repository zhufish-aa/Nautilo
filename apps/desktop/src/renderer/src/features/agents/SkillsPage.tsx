import { NavLink, useLocation } from "react-router-dom";
import { PageHeader } from "../../components/layout/AppShell";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { ProviderToolsPanel } from "./ProviderToolsPanel";

export default function SkillsPage(): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const kind = useLocation().pathname === "/skills/mcp" ? "mcp" : "skill";
  const title = zh ? "技能与连接器" : "Skills & connectors";

  return <section>
    <PageHeader title={title} actions={
      <nav aria-label={title} className="ui-tabs inline-flex gap-1 rounded-xl border border-line bg-card p-1">
        {[
          { path: "/skills", label: zh ? "技能" : "Skills" },
          { path: "/skills/mcp", label: zh ? "MCP 服务" : "MCP servers" },
        ].map(({ path, label }) => <NavLink key={path} to={path} end className={({ isActive }) => cn(
          "rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent",
          isActive ? "bg-accent-soft text-ink" : "text-ink-3 hover:text-ink",
        )}>{label}</NavLink>)}
      </nav>
    } />
    <ProviderToolsPanel key={kind} kind={kind} />
  </section>;
}
