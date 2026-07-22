import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import { PageHeader } from "../../components/layout/AppShell";
import { TabBar } from "../../components/ui/Tabs";
import { useAgentsStore } from "../../stores/agents";
import { InstancesPanel } from "./InstancesPanel";
import { ProvidersPanel } from "./ProvidersPanel";

export function AgentsPage(): JSX.Element {
  const { t } = useI18n();
  const instanceCount = useAgentsStore((state) => state.instances.length);
  const readyCount = useAgentsStore(
    (state) => state.installations.filter((item) => item.status === "ready").length
  );
  const [tab, setTab] = useState("instances");

  return (
    <>
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
              { value: "providers", label: t("agents.tabs.providers"), count: readyCount }
            ]}
          />
        }
      />
      {tab === "instances" ? <InstancesPanel /> : <ProvidersPanel />}
    </>
  );
}
