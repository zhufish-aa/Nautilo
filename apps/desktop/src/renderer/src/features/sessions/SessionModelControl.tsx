import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Zap } from "lucide-react";
import type { ProviderModel } from "@agenthub/domain";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { configureWorkbenchSession, switchWorkbenchSessionInstance } from "../../lib/orchestration-runtime";
import { permissionModesFor } from "../../lib/provider-catalog";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { Input } from "../../components/ui/Input";

type MenuView = "summary" | "models" | "efforts" | "speeds" | "modes" | "sources";

function effortLabel(value: string): string {
  const labels: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[value.toLowerCase()] ?? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

/** Groups catalog models by the source prefix of `source/model` ids (opencode-style); flat ids land in one unnamed group. */
function groupModelsBySource(catalogModels: ProviderModel[]): { source: string; models: ProviderModel[] }[] {
  const groups = new Map<string, ProviderModel[]>();
  for (const item of catalogModels) {
    const slash = item.id.indexOf("/");
    const source = slash > 0 ? item.id.slice(0, slash) : "";
    const list = groups.get(source) ?? [];
    list.push(item);
    groups.set(source, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, groupModels]) => ({ source, models: groupModels }));
}

/** A Codex-style, per-session model and reasoning control. */
export function SessionModelControl({ sessionId, disabled }: { sessionId?: string; disabled?: boolean }): JSX.Element | null {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("summary");
  const [advancedDetails, setAdvancedDetails] = useState(false);
  const [previousStandardModelId, setPreviousStandardModelId] = useState<string>();
  const [customModelId, setCustomModelId] = useState("");
  const [customEffort, setCustomEffort] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const instances = useAgentsStore((state) => state.instances);
  const catalogs = useAgentsStore((state) => state.modelCatalogs);
  const loadModels = useAgentsStore((state) => state.loadModels);
  const instanceId = session?.target.type === "agent" ? session.target.instanceId : undefined;
  const instance = instances.find((item) => item.id === instanceId);
  const catalog = instance ? catalogs[instance.id] : undefined;
  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const modelId = session?.model || catalog?.defaultModel || "";
  const model = catalog?.models.find((item) => item.id === modelId);
  const effort = session?.reasoningEffort
    || model?.defaultReasoningEffort
    || model?.reasoningEfforts[0]
    || "";
  const effortIndex = Math.max(0, model?.reasoningEfforts.indexOf(effort) ?? 0);
  const progress = model && model.reasoningEfforts.length > 1
    ? (effortIndex / (model.reasoningEfforts.length - 1)) * 100
    : 0;
  const highspeedModel = models.find((item) => /high[-_ ]?speed/i.test(`${item.id} ${item.displayName}`));
  const serviceTiers = model?.serviceTiers ?? [];
  const speedTiers = useMemo(() => [
    { id: "standard", name: t("sessions.composer.standard"), description: undefined as string | undefined },
    ...(serviceTiers.length > 0
      ? serviceTiers
      : highspeedModel
        ? [{ id: `model:${highspeedModel.id}`, name: t("sessions.composer.fast"), description: highspeedModel.description }]
        : [])
  ], [highspeedModel, serviceTiers, t]);
  const speedTierId = serviceTiers.length > 0
    ? session?.serviceTier || model?.defaultServiceTier || "standard"
    : highspeedModel?.id === modelId ? `model:${highspeedModel.id}` : "standard";
  const speedTier = speedTiers.find((item) => item.id === speedTierId) ?? speedTiers[0]!;
  const fastTier = speedTiers.find((item) => item.id !== "standard");
  const fastActive = !!fastTier && speedTier.id === fastTier.id;

  const permissionModes = useMemo(() => (instance ? permissionModesFor(instance.providerId) : []), [instance]);
  // Same-provider enabled instances are the switchable API sources for this session.
  const sourceInstances = useMemo(
    () => (instance ? instances.filter((item) => item.providerId === instance.providerId && item.enabled) : []),
    [instance, instances]
  );
  const modelGroups = useMemo(() => groupModelsBySource(models), [models]);
  const effectivePermissionMode = session?.permissionMode ?? instance?.permissionMode ?? "";
  const permissionModeOption = permissionModes.find((mode) => mode.value === effectivePermissionMode);
  const displayPermissionMode = permissionModeOption
    ? permissionModeOption.name[locale]
    : t("sessions.composer.permissionModeDefault");

  useEffect(() => {
    if (!instance?.id) return;
    void loadModels(instance.id);
  }, [instance?.id, loadModels]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!sessionId || !instance) return null;

  const selectModel = (nextModelId: string): void => {
    const next = models.find((item) => item.id === nextModelId);
    if (next && !/high[-_ ]?speed/i.test(`${next.id} ${next.displayName}`)) setPreviousStandardModelId(next.id);
    void configureWorkbenchSession(sessionId, {
      model: nextModelId,
      reasoningEffort: next?.defaultReasoningEffort ?? next?.reasoningEfforts[0] ?? "",
      serviceTier: next?.defaultServiceTier ?? ""
    });
    setView("summary");
  };
  const selectCustomModel = (): void => {
    const nextModelId = customModelId.trim();
    if (!nextModelId) return;
    selectModel(nextModelId);
  };
  const selectEffort = (nextEffort: string): void => {
    void configureWorkbenchSession(sessionId, { reasoningEffort: nextEffort });
    setView("summary");
  };
  const selectCustomEffort = (): void => {
    const nextEffort = customEffort.trim();
    if (!nextEffort) return;
    selectEffort(nextEffort);
  };
  const selectPermission = (nextMode: string): void => {
    // Empty selection clears the session override so the instance setting applies.
    void configureWorkbenchSession(sessionId, { permissionMode: nextMode || undefined });
    setView("summary");
  };
  const selectSpeed = (nextTierId: string): void => {
    if (nextTierId.startsWith("model:")) {
      const nextModelId = nextTierId.slice("model:".length);
      const nextModel = models.find((item) => item.id === nextModelId);
      if (!nextModel) return;
      if (modelId !== nextModelId) setPreviousStandardModelId(modelId);
      void configureWorkbenchSession(sessionId, {
        model: nextModel.id,
        reasoningEffort: nextModel.defaultReasoningEffort ?? nextModel.reasoningEfforts[0] ?? "",
        serviceTier: ""
      });
      setView("summary");
      return;
    }
    if (nextTierId === "standard" && highspeedModel?.id === modelId) {
      const fallback = models.find((item) => item.id === previousStandardModelId)
        ?? models.find((item) => item.isDefault && item.id !== highspeedModel.id)
        ?? models.find((item) => item.id !== highspeedModel.id);
      if (fallback) {
        void configureWorkbenchSession(sessionId, {
          model: fallback.id,
          reasoningEffort: fallback.defaultReasoningEffort ?? fallback.reasoningEfforts[0] ?? "",
          serviceTier: ""
        });
      }
      setView("summary");
      return;
    }
    void configureWorkbenchSession(sessionId, { serviceTier: nextTierId === "standard" ? "" : nextTierId });
    setView("summary");
  };
  const toggleFast = (): void => {
    if (!fastTier) return;
    selectSpeed(fastActive ? "standard" : fastTier.id);
  };
  const toggle = (): void => {
    setOpen((current) => {
      if (!current) setAdvancedDetails(false);
      return !current;
    });
    setView("summary");
  };

  const displayModel = model?.displayName ?? (modelId || t("agents.editor.basic.model"));
  const displayEffort = effort ? effortLabel(effort) : t("agents.editor.basic.reasoningDefault");
  const panelKey = view === "summary" ? (advancedDetails ? "advanced" : "quick") : view;
  const panelWidth = view === "models" ? 320 : view !== "summary" ? 288 : advancedDetails ? 264 : 224;

  return (
    <div ref={rootRef} className="relative ml-auto shrink-0">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97, width: panelWidth }}
            animate={{ opacity: 1, y: 0, scale: 1, width: panelWidth }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 430, damping: 34, mass: 0.7 }}
            className="absolute right-0 bottom-full z-40 mb-2 overflow-hidden rounded-2xl border border-line/80 bg-card p-1.5 shadow-pop"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={panelKey}
                layout="size"
                initial={{ opacity: 0, x: view === "summary" ? 0 : 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: view === "summary" ? 0 : -14 }}
                transition={{ opacity: { duration: 0.15 }, x: { type: "spring", stiffness: 460, damping: 36 }, layout: { type: "spring", stiffness: 360, damping: 32 } }}
              >
                {view === "summary" && !advancedDetails && (
                <>
                  <div className="flex h-10 w-full items-center rounded-xl px-1.5 text-ink-3 transition-colors hover:bg-card-hover hover:text-ink">
                    <button
                      type="button"
                      onClick={() => setAdvancedDetails(true)}
                      className="flex h-9 flex-1 items-center rounded-lg px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      aria-expanded={false}
                    >
                      <span>{t("sessions.composer.advanced")}</span>
                      <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
                    </button>
                    <motion.button
                      type="button"
                      whileTap={fastTier ? { scale: 0.82 } : undefined}
                      onClick={toggleFast}
                      disabled={!fastTier}
                      aria-label={t("sessions.composer.fast")}
                      aria-pressed={fastActive}
                      title={fastTier?.description ?? t("sessions.composer.fastUnavailable")}
                      className={`grid h-7 w-7 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${fastActive ? "bg-info/10 text-info" : fastTier ? "text-ink-3 hover:bg-card hover:text-ink" : "cursor-not-allowed text-ink-3/35"}`}
                    >
                      <Zap className="h-4 w-4" aria-hidden />
                    </motion.button>
                  </div>
                  {model && model.reasoningEfforts.length > 0 && (
                    <div className="px-2.5 pt-0.5 pb-3">
                      <div className="relative flex h-8 items-center">
                        <div className="session-effort-track pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden">
                          <motion.div
                            className={`session-effort-fill ${fastActive ? "is-fast" : ""}`}
                            animate={{ width: `${progress}%` }}
                            transition={{ type: "spring", stiffness: 420, damping: 36 }}
                          >
                            {fastActive && <span className="session-speed-particles" aria-hidden />}
                          </motion.div>
                        </div>
                        <input
                          className="session-effort-range relative z-30 w-full"
                          type="range"
                          min={0}
                          max={Math.max(0, model.reasoningEfforts.length - 1)}
                          step={1}
                          value={effortIndex}
                          onChange={(event) => selectEffort(model.reasoningEfforts[Number(event.target.value)] ?? effort)}
                          aria-label={t("agents.editor.basic.reasoning")}
                          style={{ "--effort-progress": `${progress}%` } as CSSProperties}
                        />
                        <div className="pointer-events-none absolute inset-x-3 z-20 flex items-center justify-between">
                          {model.reasoningEfforts.map((item, index) => (
                            <span
                              key={item}
                              className={`h-1 w-1 rounded-full ${index <= effortIndex ? "bg-white/60" : "bg-ink-3/35"}`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
                )}

                {view === "summary" && advancedDetails && (
                <>
                  <SettingRow
                    label={t("sessions.composer.apiSource")}
                    value={instance.displayName}
                    disabled={sourceInstances.length <= 1}
                    onClick={() => setView("sources")}
                  />
                  <SettingRow
                    label={t("agents.editor.basic.model")}
                    value={displayModel}
                    onClick={() => {
                      setCustomModelId(modelId === "default" ? "" : modelId);
                      setView("models");
                    }}
                  />
                  <SettingRow
                    label={t("agents.editor.basic.reasoning")}
                    value={displayEffort}
                    disabled={!model?.reasoningEfforts.length}
                    onClick={() => setView("efforts")}
                  />
                  <SettingRow
                    label={t("sessions.composer.speed")}
                    value={speedTier.name}
                    disabled={speedTiers.length <= 1}
                    onClick={() => setView("speeds")}
                  />
                  {permissionModes.length > 0 && (
                    <SettingRow
                      label={t("agents.editor.basic.permissionMode")}
                      value={displayPermissionMode}
                      onClick={() => setView("modes")}
                    />
                  )}
                  <div className="mt-1 border-t border-line pt-1">
                    <button
                      type="button"
                      onClick={() => setAdvancedDetails(false)}
                      className="flex h-9 w-full items-center gap-1 rounded-xl px-3 text-sm text-ink-3 outline-none transition-colors hover:bg-card-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
                      aria-expanded
                    >
                      <span>{t("sessions.composer.advanced")}</span>
                      <ChevronDown className="h-4 w-4 rotate-180" aria-hidden />
                    </button>
                  </div>
                </>
                )}

                {view === "models" && (
                  <SelectionList title={t("agents.editor.basic.model")} onBack={() => setView("summary")}>
                    <form
                      className="border-b border-line px-2 py-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        selectCustomModel();
                      }}
                    >
                      <div className="flex gap-2">
                        <Input
                          value={customModelId}
                          onChange={(event) => setCustomModelId(event.target.value)}
                          placeholder={t("agents.editor.basic.modelCustomPlaceholder")}
                          aria-label={t("agents.editor.basic.modelCustomPlaceholder")}
                          autoComplete="off"
                          spellCheck={false}
                          className="h-9 min-w-0 flex-1 font-mono text-xs"
                        />
                        <button
                          type="submit"
                          disabled={!customModelId.trim()}
                          className="shrink-0 rounded-lg bg-accent px-3 text-xs font-medium text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t("common.confirm")}
                        </button>
                      </div>
                      <p className="mt-1.5 px-0.5 text-[11px] leading-4 text-ink-3">
                        {t("agents.editor.basic.modelCustom")}
                      </p>
                    </form>
                    {modelGroups.map((group) => (
                      <div key={group.source || "default"}>
                        {modelGroups.length > 1 && (
                          <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-3/70">{group.source}</p>
                        )}
                        {group.models.map((item) => (
                          <SelectionItem
                            key={item.id}
                            label={item.displayName}
                            description={item.description}
                            selected={item.id === modelId}
                            onClick={() => selectModel(item.id)}
                          />
                        ))}
                      </div>
                    ))}
                  </SelectionList>
                )}

                {view === "efforts" && (
                  <SelectionList title={t("agents.editor.basic.reasoning")} onBack={() => setView("summary")}>
                    <form
                      className="border-b border-line px-2 py-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        selectCustomEffort();
                      }}
                    >
                      <div className="flex gap-2">
                        <Input
                          value={customEffort}
                          onChange={(event) => setCustomEffort(event.target.value)}
                          placeholder={t("agents.editor.basic.reasoningCustomPlaceholder")}
                          aria-label={t("agents.editor.basic.reasoningCustomPlaceholder")}
                          autoComplete="off"
                          spellCheck={false}
                          className="h-9 min-w-0 flex-1 font-mono text-xs"
                        />
                        <button
                          type="submit"
                          disabled={!customEffort.trim()}
                          className="shrink-0 rounded-lg bg-accent px-3 text-xs font-medium text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t("common.confirm")}
                        </button>
                      </div>
                      <p className="mt-1.5 px-0.5 text-[11px] leading-4 text-ink-3">
                        {t("agents.editor.basic.reasoningCustom")}
                      </p>
                    </form>
                    {effort && !model?.reasoningEfforts.includes(effort) && (
                      <SelectionItem
                        label={effortLabel(effort)}
                        description={t("agents.editor.basic.reasoningCustomCurrent")}
                        selected
                        onClick={() => selectEffort(effort)}
                      />
                    )}
                    {(model?.reasoningEfforts ?? []).map((item) => (
                      <SelectionItem
                        key={item}
                        label={effortLabel(item)}
                        selected={item === effort}
                        onClick={() => selectEffort(item)}
                      />
                    ))}
                  </SelectionList>
                )}

                {view === "speeds" && (
                  <SelectionList title={t("sessions.composer.speed")} onBack={() => setView("summary")}>
                    {speedTiers.map((item) => (
                      <SelectionItem
                        key={item.id}
                        label={item.name}
                        description={item.description}
                        selected={item.id === speedTier.id}
                        onClick={() => selectSpeed(item.id)}
                      />
                    ))}
                  </SelectionList>
                )}

                {view === "modes" && (
                  <SelectionList title={t("agents.editor.basic.permissionMode")} onBack={() => setView("summary")}>
                    <SelectionItem
                      label={t("sessions.composer.permissionModeDefault")}
                      selected={!session?.permissionMode}
                      onClick={() => selectPermission("")}
                    />
                    {permissionModes.map((mode) => (
                      <SelectionItem
                        key={mode.value}
                        label={mode.name[locale]}
                        description={mode.description[locale]}
                        selected={session?.permissionMode === mode.value}
                        onClick={() => selectPermission(mode.value)}
                      />
                    ))}
                  </SelectionList>
                )}

                {view === "sources" && (
                  <SelectionList title={t("sessions.composer.apiSource")} onBack={() => setView("summary")}>
                    {sourceInstances.map((item) => (
                      <SelectionItem
                        key={item.id}
                        label={item.displayName}
                        description={item.baseUrl ?? item.executable}
                        selected={item.id === instanceId}
                        onClick={() => {
                          if (sessionId && item.id !== instanceId) void switchWorkbenchSessionInstance(sessionId, item.id);
                          setView("summary");
                        }}
                      />
                    ))}
                  </SelectionList>
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        animate={{ width: open ? panelWidth : 224 }}
        transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.65 }}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={`${t("agents.editor.basic.model")}: ${displayModel}; ${t("agents.editor.basic.reasoning")}: ${displayEffort}`}
        aria-expanded={open}
        className={`grid h-8 grid-cols-[1fr_auto_1fr] items-center rounded-full border-0 px-3 text-xs text-ink-2 outline-none transition-colors hover:bg-card-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-45 ${open ? "bg-card-hover" : "bg-transparent"}`}
      >
        <span aria-hidden />
        <span className="flex min-w-0 items-center justify-center gap-1.5">
          <span className="truncate font-medium text-ink">{displayModel}</span>
          <span className="truncate text-ink-3">{displayEffort}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 justify-self-end transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </motion.button>
    </div>
  );
}

function SettingRow({ label, value, disabled, onClick }: { label: string; value: string; disabled?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="grid h-10 w-full grid-cols-[1fr_auto_16px] items-center gap-2 rounded-xl px-3 text-sm outline-none transition-colors hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="text-left text-ink">{label}</span>
      <span className="max-w-32 truncate text-right text-ink-3">{value}</span>
      <ChevronRight className="h-4 w-4 text-ink-3" aria-hidden />
    </button>
  );
}

function SelectionList({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="flex h-10 items-center gap-2 border-b border-line px-1.5 pb-1">
        <button type="button" onClick={onBack} className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 outline-none hover:bg-card-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="text-sm font-medium text-ink">{title}</span>
      </div>
      <div className="max-h-72 overflow-y-auto pt-1">{children}</div>
    </div>
  );
}

function SelectionItem({ label, description, selected, onClick }: { label: string; description?: string; selected: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="grid min-h-10 w-full grid-cols-[1fr_18px] items-center gap-2 rounded-xl px-3 py-2 text-left outline-none hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-accent/60">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-ink-3">{description}</span>}
      </span>
      {selected && <Check className="h-4 w-4 text-accent" aria-hidden />}
    </button>
  );
}
