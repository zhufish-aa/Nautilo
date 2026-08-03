import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import { PageHeader } from "../../components/layout/AppShell";
import { TabBar } from "../../components/ui/Tabs";
import { useAgentsStore } from "../../stores/agents";
import { usePluginsStore } from "../../stores/plugins";
import { InstancesPanel } from "./InstancesPanel";
import { PluginMarketPanel } from "./PluginMarketPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { ProviderToolsPanel } from "./ProviderToolsPanel";
import { useProviderToolsStore } from "../../stores/provider-tools";

export function AgentsPage(): JSX.Element {
  const { t } = useI18n();
  const instanceCount = useAgentsStore((state) => state.instances.length);
  const readyCount = useAgentsStore(
    (state) => state.installations.filter((item) => item.status === "ready").length
  );
  const toolsCount = useProviderToolsStore((state) => state.tools.length);
  const pluginCount = usePluginsStore((state) => state.installed.length);
  const [tab, setTab] = useState("instances");

  return (
    <div data-tour="agents-page">
      <PageHeader
        title={t("agents.title")}
        subtitle={t("agents.subtitle")}
        actions={
          <TabBar
            aria-label={t("agents.title")}
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "instances", label: t("agents.tabs.instances"), count: instanceCount },
              { value: "providers", label: t("agents.tabs.providers"), count: readyCount },
              { value: "tools", label: t("agents.tabs.tools"), count: toolsCount },
              { value: "market", label: t("agents.tabs.market"), count: pluginCount }
            ]}
          />
        }
      />
      {tab === "instances" ? <InstancesPanel /> : tab === "providers" ? <ProvidersPanel /> : tab === "tools" ? <ProviderToolsPanel /> : <PluginMarketPanel />}
    </div>
  );
}
