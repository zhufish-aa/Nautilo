import { useEffect, useRef, useState } from "react";
import type {
  ResourceInventory,
  ResourceSyncPlan,
  ResourceConflictResolution,
} from "@agenthub/schemas";
import { requestCore } from "../../../lib/bridge";

/** Owns request cancellation and preview invalidation; the dialog only renders. */
export function useResourceSync(open: boolean, kind: "mcp" | "skill") {
  const [inventory, setInventory] = useState<ResourceInventory>(),
    [selected, setSelected] = useState<string[]>([]),
    [targetId, setTarget] = useState(""),
    [resolution, setResolution] = useState<ResourceConflictResolution>("keep"),
    [plan, setPlan] = useState<ResourceSyncPlan>(),
    [history, setHistory] = useState<ResourceSyncPlan[]>([]),
    [tab, setTab] = useState("sync"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    target = inventory?.targets.find((t) => t.id === targetId);
  const load = async () => {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const [inv, h] = await Promise.all([
        requestCore<ResourceInventory>("resource.inventory"),
        requestCore<ResourceSyncPlan[]>("resource.history"),
      ]);
      if (version !== generation.current) return;
      setInventory(inv);
      setHistory(h);
      setTarget(
        (current) =>
          current ||
          inv.targets.find((t) =>
            kind === "skill" ? t.skillDirectory : t.mcpPath,
          )?.id ||
          "",
      );
    } catch (e) {
      if (version === generation.current) setError(String(e));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (open) {
      void load();
      setPlan(undefined);
      setSelected([]);
    }
    return () => {
      generation.current++;
    };
  }, [open, kind]);
  const invalidate = () => setPlan(undefined);
  const action = async (method: string, input: unknown) => {
    if (busy) return;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = await requestCore<ResourceSyncPlan>(method, input);
      if (version !== generation.current) return;
      setPlan(value);
      const history = await requestCore<ResourceSyncPlan[]>("resource.history");
      if (version === generation.current) setHistory(history);
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  return {
    inventory,
    selected,
    setSelected,
    targetId,
    setTarget,
    resolution,
    setResolution,
    plan,
    setPlan,
    history,
    tab,
    setTab,
    busy,
    error,
    target,
    load,
    invalidate,
    action,
  };
}
