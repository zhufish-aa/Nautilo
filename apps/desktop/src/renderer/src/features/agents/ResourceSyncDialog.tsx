import { AnimatePresence, motion } from "framer-motion";
import type { ResourceConflictResolution } from "@agenthub/schemas";
import {
  ArrowRight,
  Check,
  FileCode2,
  FolderSync,
  History,
  RefreshCw,
  RotateCcw,
  Server,
  Sparkles,
} from "lucide-react";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { SelectField } from "../../components/ui/Select";
import { useI18n } from "../../lib/i18n";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";
import { useResourceSync } from "./resource-sync/useResourceSync";
import "./resource-sync.css";

export function ResourceSyncDialog({
  open,
  onOpenChange,
  kind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "mcp" | "skill";
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN",
    reduced = useUiReducedMotion();
  const {
    inventory,
    selected,
    setSelected,
    targetId,
    setTarget,
    resolution,
    setResolution,
    plan,
    history,
    tab,
    setTab,
    busy,
    error,
    target,
    load,
    invalidate,
    action,
  } = useResourceSync(open, kind);
  const ops: Record<string, string> = zh
    ? {
        create: "新增",
        update: "更新",
        unchanged: "一致",
        keep: "保留原配置",
        rename: "另存名称",
      }
    : {
        create: "Create",
        update: "Update",
        unchanged: "Identical",
        keep: "Keep native",
        rename: "Rename",
      };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
      title={zh ? "原生资源同步" : "Native resource sync"}
      widthClass="resource-sync-dialog"
    >
      <div className="resource-sync-toolbar">
        <div role="tablist">
          {[
            ["sync", zh ? "同步资源" : "Sync"],
            ["history", zh ? "同步记录" : "History"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {id === "sync" ? <FolderSync size={15} /> : <History size={15} />}{" "}
              {label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void load()}
          aria-label={zh ? "刷新" : "Refresh"}
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && (
        <div className="resource-sync-error" role="alert">
          {error}
        </div>
      )}
      {tab === "sync" ? (
        <>
          <div className="resource-sync-target">
            <SelectField
              value={targetId}
              onValueChange={(id) => {
                setTarget(id);
                invalidate();
              }}
              disabled={busy}
              options={(inventory?.targets ?? []).map((t) => ({
                value: t.id,
                label: t.label,
              }))}
              aria-label={
                zh ? "目标 Harness 或账号" : "Target harness or account"
              }
            />
            <ArrowRight size={16} />
            <span
              title={
                kind === "skill" ? target?.skillDirectory : target?.mcpPath
              }
            >
              {(kind === "skill" ? target?.skillDirectory : target?.mcpPath) ||
                (zh ? "随原生会话传入" : "Merged at invocation")}
            </span>
          </div>
          {kind === "mcp" && target && !target.mcpPath ? (
            <div className="resource-sync-invocation">
              <Server size={22} />
              <strong>{target.label}</strong>
              <p>
                {zh
                  ? "此 Harness 通过会话扩展合并 MCP。启用的服务会随会话传入；这里不会写入未验证的全局配置。"
                  : "This harness receives enabled MCP services through its session extension. No unverified global configuration is written."}
              </p>
            </div>
          ) : (
            <>
              <div className="resource-sync-resources">
                {inventory?.resources
                  .filter((r) => r.kind === kind)
                  .map((r) => (
                    <label key={r.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(r.id)}
                        disabled={busy}
                        onChange={(e) => {
                          setSelected((ids) =>
                            e.target.checked
                              ? [...ids, r.id]
                              : ids.filter((id) => id !== r.id),
                          );
                          invalidate();
                        }}
                      />
                      {kind === "skill" ? (
                        <Sparkles size={17} />
                      ) : (
                        <Server size={17} />
                      )}
                      <span>
                        <strong>{r.name}</strong>
                        <span title={r.sourcePath}>
                          {r.source === "unknown"
                            ? zh
                              ? "来源未记录"
                              : "Source not recorded"
                            : r.source}
                          {r.sourcePath && ` · ${r.sourcePath}`}
                        </span>
                      </span>
                      <span className="resource-sync-owner">Nautilo</span>
                    </label>
                  ))}
                {inventory &&
                  !inventory.resources.some((r) => r.kind === kind) && (
                    <p>{zh ? "没有可同步的资源" : "No resources to sync"}</p>
                  )}
              </div>
              <div className="resource-sync-options">
                <span>{zh ? "同名冲突" : "Name conflicts"}</span>
                <SelectField
                  value={resolution}
                  onValueChange={(v) => {
                    setResolution(v as ResourceConflictResolution);
                    invalidate();
                  }}
                  disabled={busy}
                  options={[
                    { value: "keep", label: zh ? "保留原配置" : "Keep native" },
                    {
                      value: "replace",
                      label: zh ? "替换所选条目" : "Replace selected entries",
                    },
                    {
                      value: "rename",
                      label: zh ? "另存名称" : "Use another name",
                    },
                  ]}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !selected.length}
                  onClick={() =>
                    void action("resource.preview", {
                      targetId,
                      capabilityIds: selected,
                      resolution,
                    })
                  }
                >
                  {zh ? "预览差异" : "Preview changes"}
                </Button>
              </div>
            </>
          )}
          <AnimatePresence initial={false}>
            {plan && (
              <motion.div
                className="resource-sync-plan"
                key={plan.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.24, ease: UI_EASE_OUT }}
              >
                <div className="resource-sync-plan-heading">
                  <strong>{zh ? "同步计划" : "Sync plan"}</strong>
                  <span>
                    {plan.state === "applied"
                      ? zh
                        ? "已应用"
                        : "Applied"
                      : plan.state === "undone"
                        ? zh
                          ? "已撤销"
                          : "Undone"
                        : zh
                          ? "尚未写入"
                          : "Not yet applied"}
                  </span>
                </div>
                {plan.changes.map((c, i) => (
                  <div className="resource-sync-change" key={`${c.path}:${i}`}>
                    <FileCode2 size={15} />
                    <div>
                      <strong>{c.name}</strong>
                      <span title={c.path}>{c.path}</span>
                      {c.before !== undefined &&
                        c.after !== undefined &&
                        c.operation !== "unchanged" && (
                          <details>
                            <summary>
                              {zh ? "查看条目差异" : "View entry changes"}
                            </summary>
                            <pre>
                              − {c.before || "—"}
                              {"\n"}+ {c.after}
                            </pre>
                          </details>
                        )}
                    </div>
                    <span data-conflict={c.conflict}>{ops[c.operation]}</span>
                  </div>
                ))}
                <div className="resource-sync-actions">
                  {plan.state === "preview" && (
                    <Button
                      variant="primary"
                      disabled={
                        busy ||
                        !plan.changes.some(
                          (c) => !["keep", "unchanged"].includes(c.operation),
                        )
                      }
                      onClick={() =>
                        void action("resource.apply", { planId: plan.id })
                      }
                    >
                      <Check size={15} />
                      {zh ? "应用同步" : "Apply sync"}
                    </Button>
                  )}
                  {plan.state === "applied" && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void action("resource.undo", { planId: plan.id })
                      }
                    >
                      <RotateCcw size={15} />
                      {zh ? "撤销这次同步" : "Undo this sync"}
                    </Button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <div className="resource-sync-history">
          {history.map((h) => (
            <div key={h.id}>
              <History size={17} />
              <div>
                <strong>
                  {inventory?.targets.find((t) => t.id === h.targetId)?.label ??
                    h.targetId}
                </strong>
                <span>
                  {new Date(h.createdAt).toLocaleString()} ·{" "}
                  {
                    h.changes.filter(
                      (c) => !["keep", "unchanged"].includes(c.operation),
                    ).length
                  }{" "}
                  {zh ? "项更改" : "changes"}
                </span>
              </div>
              <span>
                {h.state === "applied"
                  ? zh
                    ? "已应用"
                    : "Applied"
                  : h.state === "undone"
                    ? zh
                      ? "已撤销"
                      : "Undone"
                    : zh
                      ? "预览"
                      : "Preview"}
              </span>
              {h.state === "applied" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void action("resource.undo", { planId: h.id })}
                >
                  <RotateCcw size={14} />
                  {zh ? "撤销" : "Undo"}
                </Button>
              )}
            </div>
          ))}
          {!history.length && (
            <p>{zh ? "还没有同步记录" : "No sync history"}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
