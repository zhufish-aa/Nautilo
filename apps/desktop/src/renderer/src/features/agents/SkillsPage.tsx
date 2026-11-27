import { NavLink, useLocation } from "react-router-dom";
import { Layers, Server } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { ProviderToolsPanel } from "./ProviderToolsPanel";

export default function SkillsPage(): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const kind = useLocation().pathname === "/skills/mcp" ? "mcp" : "skill";
  const title = zh ? "技能与连接器" : "Skills & connectors";

  return (
    <section className="skills-route-stage mx-auto flex h-full min-h-0 w-full max-w-[1480px] flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <nav aria-label={title} className="skills-route-tabs inline-flex items-center gap-1 rounded-[10px] border border-line/70 bg-card/70 p-1">
          {[
            { path: "/skills", label: zh ? "Skills 技能" : "Skills", icon: Layers },
            { path: "/skills/mcp", label: zh ? "MCP 服务" : "MCP servers", icon: Server },
          ].map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              end
              className={({ isActive }) => cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                isActive
                  ? "bg-accent/15 text-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--glass-accent-blue)_32%,transparent)]"
                  : "text-ink-3 hover:text-ink",
              )}
            >
              <Icon size={13} aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <ProviderToolsPanel key={kind} kind={kind} />
    </section>
  );
}
