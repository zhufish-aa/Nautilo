import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Activity, ArrowDownUp, ArrowLeft, ArrowUpRight, BellRing, Braces, ChevronRight, CircleAlert, Copy, Download, Link, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Redo2, Scan, Search, SkipBack, Square, StepBack, StepForward, Trash2, Undo2, Workflow, X } from "lucide-react";
import type { WorkflowDefinition, WorkflowLayout, WorkflowNode, WorkflowRun, WorkflowTemplate, WorkflowValidation, WorkflowIssue } from "@agenthub/domain";
import { StageActivityPill } from "../../components/layout/StageActivityPill";
import { Dialog } from "../../components/ui/Dialog";
import { WorkflowSegments, WorkflowSelect, workflowChoices } from "./WorkflowSelect";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { requestCore } from "../../lib/bridge";
import { providerMeta } from "../../lib/provider-catalog";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { useSessionsStore } from "../../stores/sessions";
import { useWorkflowsStore } from "../../stores/workflows";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { Stepper, WorkflowFields } from "./WorkflowFields";
import { WorkflowPrompt } from "./WorkflowPrompt";
import { WorkflowWorkspace, type WorkspaceAction } from "./WorkflowAcceptance";
import { WorkflowRunInspector } from "./WorkflowRunInspector";
import { appendOutlet, blankWorkflow, canRemoveOutlet, cleanLayout, connectNodes, createNode, graphIssues, removeLink, type AddableKind, type InspectorTab } from "./workflow-editing";
import { edgeKey, findEdge, loopEdges, placeNodes, type Connection, type EdgeSelection, type Point } from "./workflow-geometry";
import { applyStarter, eventProjection, initialLayout, nodeKinds, nodeLabel, nodeSize, nodeTone, statusLabels, workflowEventText } from "./workflow-model";
import { buildWorkflowMotionPreview, type WorkflowMotionPreviewFrame } from "./workflow-motion-preview";
import "./workflows.css";
import "./workflow-motion.css";

interface Draft { definition: WorkflowDefinition; layout: WorkflowLayout; revision: number }
interface DraftView { draft: Draft; selected: string; undo: Draft[]; redo: Draft[] }
interface PreviewPlayback { definition: WorkflowDefinition; frames: WorkflowMotionPreviewFrame[]; index: number }
const draftKey = (id?: string): string => "nautilo.workflow.draft." + (id && id !== "__new" ? id : "new");
const copy = <T,>(value: T): T => structuredClone(value);
const workflowReturns = [{ value: "$return", label: "交回主会话" }, { value: "$return_needs_decision", label: "交回判断" }];
const roles = { Explorer: "Explorer · 探索取证", Analyst: "Analyst · 汇总判断", Verifier: "Verifier · 独立复核", custom: "自定义" };
function asDraft(template: WorkflowTemplate): Draft { return { definition: template.definition, layout: template.layout, revision: template.revision }; }
function readDraft(id?: string): Draft | undefined {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(id)) || "null") as Draft | null;
    return draft?.definition?.schemaVersion === 1 && Array.isArray(draft.definition.nodes) && Array.isArray(draft.definition.edges) && draft.layout?.nodes ? draft : undefined;
  } catch { return undefined; }
}
function writeDraft(id: string, draft: Draft): void {
  try { localStorage.setItem(draftKey(id), JSON.stringify(draft)); } catch { /* The editor also keeps its drafts in memory. */ }
}
function editorValid(): boolean {
  const invalid = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(".wf-inspector :invalid");
  if (!invalid) return true;
  for (let parent = invalid.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  invalid.focus(); invalid.reportValidity(); return false;
}

function PromptText({ text }: { text?: string }): JSX.Element {
  return <>{text?.split(/(\{\{[^{}\r\n]+\}\})/g).map((part, index) => index % 2 ? <code key={index}>{part}</code> : part)}</>;
}

export function WorkflowsPage({ inspection }: { inspection?: { runId: string; onOpenSession: (id: string) => void } } = {}): JSX.Element {
  const navigate = useNavigate(), [params, setParams] = useSearchParams();
  const motionReduced = useUiReducedMotion();
  const templates = useWorkflowsStore(state => state.templates), summaries = useWorkflowsStore(state => state.runs);
  const ready = useWorkflowsStore(state => state.loaded);
  const [inspectedRunId, setInspectedRunId] = useState<string>();
  const templateId = inspection ? undefined : params.get("template") || undefined;
  const runId = inspection ? inspectedRunId ?? inspection.runId : params.get("run") || undefined;
  const targetInstance = inspection ? null : params.get("instance");
  const inspectRun = (id: string): void => {
    if (inspection) setInspectedRunId(id);
    else setParams({ run: id });
  };
  const openConversation = (id: string): void => {
    if (inspection) inspection.onOpenSession(id);
    else navigate("/sessions?session=" + encodeURIComponent(id));
  };
  const [draft, setDraft] = useState<Draft>(() => readDraft(templateId) || blankWorkflow());
  const [selected, setSelected] = useState(draft.definition.entry);
  const [selectedEdge, setSelectedEdge] = useState<EdgeSelection>();
  const [locate, setLocate] = useState<{ nodeId: string; exitId?: string; request: number; reveal?: boolean }>();
  const [clipboard, setClipboard] = useState<WorkflowNode>();
  const [hasLocalDraft, setHasLocalDraft] = useState(() => !!readDraft());
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => localStorage.getItem("nautilo.workflow.library-collapsed") === "true");
  const [inspectorWidth, setInspectorWidth] = useState(352);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("instructions");
  const [canvasLocked, setCanvasLocked] = useState(false);
  const canvasLockRef = useRef(false);
  canvasLockRef.current = canvasLocked;
  const [hoveredOutlet, setHoveredOutlet] = useState<EdgeSelection>();
  const [archiveTarget, setArchiveTarget] = useState<WorkflowTemplate>();
  const importFile = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState<string>();
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const libraryToggled = useRef(false);
  const [previewPlayback, setPreviewPlayback] = useState<PreviewPlayback>();
  const [snapshot, setRun] = useState<WorkflowRun>(), [mode, setMode] = useState<"design" | "run">(runId ? "run" : "design");
  const run = snapshot?.id === runId ? snapshot : undefined;
  const [sequence, setSequence] = useState<number>(), [following, setFollowing] = useState(true);
  const [replaying, setReplaying] = useState(false);
  const [instanceId, setInstanceId] = useState<string>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runError, setRunError] = useState("");
  const [jsonOpen, setJsonOpen] = useState(false), [jsonText, setJsonText] = useState(""), [jsonError, setJsonError] = useState("");
  const jsonPreview = useRef<HTMLPreElement>(null);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const sessions = useSessionsStore(state => state.sessions);
  const projects = useProjectsStore(state => state.projects);
  const sessionId = run?.sessionId ?? params.get("session") ?? useSessionsStore.getState().activeSessionId;
  const inspector = useRef<HTMLElement>(null);
  const inspectedNode = useRef(selected);
  const [validation, setValidation] = useState<{ definition: WorkflowDefinition; result: WorkflowValidation }>();
  const [retryInstance, setRetryInstance] = useState<string>();
  const history = useRef<Draft[]>([]), future = useRef<Draft[]>([]), moveStart = useRef<Draft>();
  const [historyVersion, setHistoryVersion] = useState(0);
  const draftRef = useRef(draft); draftRef.current = draft;
  const loadedId = useRef<string | undefined>(templateId ? undefined : "__new");
  const draftViews = useRef(new Map<string, DraftView>());
  useEffect(() => {
    if (inspection) return;
    void useWorkflowsStore.getState().load().catch(() => setError("暂时无法读取流程库。请稍后重试。"));
  }, [Boolean(inspection)]);
  function rememberDraft(): void {
    const id = loadedId.current;
    if (!id) return;
    writeDraft(id, draftRef.current);
    draftViews.current.set(id, { draft: draftRef.current, selected, undo: [...history.current], redo: [...future.current] });
    if (id === "__new") setHasLocalDraft(true);
  }
  function openEditor(template?: WorkflowTemplate, fresh = false): void {
    const id = template?.id || "__new";
    if (id === loadedId.current && !fresh) { setMode("design"); return; }
    rememberDraft();
    const view = fresh ? undefined : draftViews.current.get(id);
    const cached = view?.draft || (!fresh ? readDraft(id) : undefined);
    const next = cached && (!template || cached.revision === template.revision) ? cached : template ? asDraft(template) : blankWorkflow();
    const priorScratch = fresh ? draftViews.current.get("__new")?.draft : undefined;
    history.current = view?.draft === next && view ? [...view.undo] : priorScratch ? [priorScratch] : [];
    future.current = view?.draft === next && view ? [...view.redo] : [];
    loadedId.current = id;
    draftRef.current = next;
    setDraft(next);
    setSelected(view?.selected && next.definition.nodes.some(node => node.id === view.selected) ? view.selected : next.definition.entry);
    setSelectedEdge(undefined); setLocate(undefined); setInspectorTab("instructions"); setError("");
    setHistoryVersion(version => version + 1);
    writeDraft(id, next);
    if (id === "__new") setHasLocalDraft(true);
  }
  function openFromLibrary(template?: WorkflowTemplate, fresh = false): void {
    openEditor(template, fresh);
    setMode("design");
    setParams(template ? { template: template.id } : {});
  }
  useEffect(() => {
    if (loadedId.current === (templateId || "__new")) return;
    const template = templates.find(template => template.id === templateId);
    if (templateId && !template) return;
    openEditor(template);
  }, [templateId, templates]);
  useEffect(() => {
    if (inspection) return;
    const timer = window.setTimeout(() => {
      if (loadedId.current !== (templateId || "__new")) return;
      writeDraft(templateId || "__new", draft);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, templateId, Boolean(inspection)]);
  useEffect(() => {
    if (!runId) { setRun(undefined); setRunError(""); return; }
    let disposed = false, timer: number;
    const refresh = async (): Promise<void> => {
      let pending = true;
      try {
        const next = await requestCore<WorkflowRun>("workflow.get", { runId });
        if (!disposed) { setRun(next); setRunError(""); useWorkflowsStore.getState().observe(next); }
        const cleanupStages = ["planning", "preparing", "verifying", "waiting_approval", "waiting_merge", "merging"];
        const cleanup = ["cancelled", "failed", "needs_decision"].includes(next.status) && (cleanupStages.includes(next.workspace?.stage || "") || next.instances.some(instance => ["preparing", "verifying", "waiting_approval"].includes(instance.workspace?.stage || "")));
        pending = ["running", "paused", "finalizing"].includes(next.status) || cleanup || next.messages.some(message => ["queued", "delivering", "waiting_approval"].includes(message.status));
      } catch (error) { if (!disposed) setRunError(String(error)); }
      if (!disposed && pending) timer = window.setTimeout(() => void refresh(), document.hidden ? 10000 : 1500);
    };
    void refresh(); return () => { disposed = true; window.clearTimeout(timer); };
  }, [runId, refreshKey]);
  useEffect(() => { if (runId) setMode("run"); setSequence(undefined); setFollowing(true); setReplaying(false); setInstanceId(undefined); }, [runId]);
  useEffect(() => {
    const instance = run?.instances.find(item => item.id === targetInstance);
    if (run?.id === runId && instance) {
      setFollowing(false); setSelected(instance.nodeId); setInstanceId(instance.id);
    }
  }, [runId, targetInstance, run?.id]);
  useEffect(() => {
    if (!replaying || !run) return;
    const timer = window.setInterval(() => setSequence(value => {
      const next = run.events.find(event => event.sequence > (value ?? 0));
      if (!next || next === run.events.at(-1)) setReplaying(false);
      return next?.sequence ?? value;
    }), 700);
    return () => window.clearInterval(timer);
  }, [replaying, run?.events]);
  const definition = mode === "run" && run ? run.definition : draft.definition;
  const preview = mode === "design" && previewPlayback?.definition === definition ? previewPlayback.frames[previewPlayback.index] : undefined;
  const previewPlaying = !!preview?.duration;
  useEffect(() => {
    if (!previewPlayback || !preview?.duration) return;
    const timer = window.setTimeout(() => {
      setPreviewPlayback(current => current === previewPlayback ? { ...current, index: current.index + 1 } : current);
    }, preview.duration);
    return () => window.clearTimeout(timer);
  }, [preview, previewPlayback]);
  useEffect(() => { setPreviewPlayback(undefined); }, [mode, definition]);
  useLayoutEffect(() => {
    const changed = inspectedNode.current !== selected;
    inspectedNode.current = selected;
    const panel = inspector.current;
    if (!changed || !selected || mode !== "design" || motionReduced || !panel?.animate) return;
    const tokens = getComputedStyle(panel);
    const duration = Number.parseFloat(tokens.getPropertyValue("--wf-motion-inspector"));
    const stagger = Number.parseFloat(tokens.getPropertyValue("--wf-motion-stagger"));
    const easing = tokens.getPropertyValue("--wf-motion-panel-ease").trim();
    const items = panel.querySelectorAll<HTMLElement>(".wf-node-identity, .wf-inspector-tabs, .wf-inspector-grid [role=tabpanel], .wf-control-fields, .wf-control-description, .wf-exits");
    const animations = Array.from(items, (item, index) => item.animate([
      { translate: "0 5px", opacity: .68 }, { translate: "0 0", opacity: 1 },
    ], { duration, delay: Math.min(index, 6) * stagger, easing, fill: "backwards" }));
    return () => animations.forEach(animation => animation.cancel());
  }, [selected, mode, motionReduced]);
  useEffect(() => {
    if (mode !== "design") return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void requestCore<WorkflowValidation>("workflow.validate", { definition: draft.definition }).then(result => {
        if (!disposed) setValidation({ definition: draft.definition, result });
      }).catch(() => {});
    }, 250);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [mode, draft.definition]);
  const layout = useMemo(() => run && mode === "run" ? run.layout || initialLayout(run.definition) : draft.layout, [run?.definition, run?.layout, mode, draft.layout]);
  const projection = useMemo(() => run && mode === "run" ? eventProjection(run, sequence) : { instances: new Map(), events: [] }, [run, sequence, mode]);
  const node = definition.nodes.find(node => node.id === selected);
  const returnSelected = selected === "$return" || selected === "$return_needs_decision";
  const edge = selectedEdge && findEdge(definition, selectedEdge);
  const loop = useMemo(() => loopEdges(definition.edges), [definition.edges]);
  const sourceNode = edge && definition.nodes.find(node => node.id === edge.from[0]);
  const outlet = sourceNode?.exits.find(port => port.id === edge?.from[1]);
  const nodeChoices = definition.nodes.map(item => ({ value: item.id, label: nodeLabel(item) }));
  const inspectorNodeChoices = [...nodeChoices, ...workflowReturns.filter(item => definition.edges.some(edge => [edge.to, edge.onLimit].includes(item.value)))];
  const targetChoices = [{ value: "", label: "未连接" }, ...nodeChoices.filter(item => item.value !== definition.entry), ...workflowReturns];
  function targetName(id?: string): string {
    if (id === "$return") return "交回主会话";
    if (id === "$return_needs_decision") return "交回判断";
    const target = definition.nodes.find(node => node.id === id);
    return target ? nodeLabel(target) : "未连接";
  }
  const issues = useMemo(() => mode === "design" ? graphIssues(draft.definition, validation?.definition === draft.definition ? validation.result.issues : []) : [], [mode, draft.definition, validation]);
  const blockingIssues = issues.filter(issue => !issue.warning);
  const nodeInstances = [...projection.instances.values()].filter(instance => instance.nodeId === selected);
  const latestInstance = nodeInstances.find(instance => instance.id === instanceId) || nodeInstances.at(-1);
  const activation = latestInstance && projection.events.find(event => event.type === "node.activated" && event.instanceId === latestInstance.id);
  const taskPrompt = latestInstance?.taskText ?? (activation?.data as { prompt?: string } | undefined)?.prompt ?? latestInstance?.prompt;
  const latestEvent = projection.events.at(-1);
  useEffect(() => { if (following && mode === "run" && latestEvent?.nodeId) setSelected(latestEvent.nodeId); }, [following, mode, latestEvent?.sequence]);
  const change = useCallback((edit: (next: Draft) => void): void => {
    if (canvasLockRef.current) return;
    const previous = draftRef.current, next = copy(previous); edit(next);
    if (JSON.stringify(previous.definition.edges) !== JSON.stringify(next.definition.edges)) {
      for (const node of next.definition.nodes.filter(node => node.kind === "join" && node.sources)) {
        node.sources = [...new Set(next.definition.edges.filter(edge => edge.to === node.id || edge.onLimit === node.id).map(edge => edge.from[0]))];
        if (!node.sources.length) delete node.sources;
      }
      cleanLayout(next.definition, next.layout);
    }
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    history.current.push(moveStart.current ?? previous); moveStart.current = undefined;
    history.current = history.current.slice(-50); future.current = [];
    draftRef.current = next; setDraft(next);
    setHistoryVersion(v => v + 1);
  }, []);
  const editNode = (edit: (node: WorkflowNode) => void): void => change(next => { const n = next.definition.nodes.find(n => n.id === selected); if (n) edit(n); });
  const rememberMove = (): void => {
    if (!moveStart.current) return;
    history.current.push(moveStart.current); history.current = history.current.slice(-50); future.current = []; moveStart.current = undefined; setHistoryVersion(v => v + 1);
  };
  useEffect(() => { window.addEventListener("pointerup", rememberMove); window.addEventListener("pointercancel", rememberMove); return () => { window.removeEventListener("pointerup", rememberMove); window.removeEventListener("pointercancel", rememberMove); }; }, []);
  const selectNode = (id: string): void => { if (id !== selected) setInspectorTab("instructions"); setSelected(id); setSelectedEdge(undefined); setHoveredOutlet(undefined); setInstanceId(undefined); if (mode === "run") setFollowing(false); };
  const selectEdge = (selection: EdgeSelection): void => { setSelectedEdge(selection); setSelected(""); };
  function locateNode(id: string): void {
    setLocate(current => ({ nodeId: id, request: (current?.request ?? 0) + 1 }));
  }
  function showIssue(issue: WorkflowIssue): void {
    if (!issue.nodeId) return;
    selectNode(issue.nodeId);
    if (issue.path === "loop" && issue.exitId) selectEdge({ source: issue.nodeId, exit: issue.exitId });
    else if (issue.exitId || issue.path.includes("forEach")) setInspectorTab("output");
    setLocate(current => ({ nodeId: issue.nodeId!, exitId: issue.exitId, request: (current?.request ?? 0) + 1 }));
    if (issue.path.includes("prompt")) requestAnimationFrame(() => requestAnimationFrame(() => inspector.current?.querySelector<HTMLTextAreaElement>('[aria-label="任务提示词"]')?.focus({preventScroll:true})));
  }
  function canSubmit(): boolean {
    if (!editorValid()) return false;
    const issue = blockingIssues[0];
    if (!issue) return true;
    setError(""); showIssue(issue);
    return false;
  }
  const undo = (redo = false): void => {
    if (canvasLocked) return;
    const from = redo ? future.current : history.current, to = redo ? history.current : future.current;
    const previous = from.pop(); if (!previous) return; to.push(draftRef.current); draftRef.current = previous; setDraft(previous); setHistoryVersion(v => v + 1);
  };
  async function save(): Promise<void> {
    if (busy || !canSubmit()) return;
    const snapshot = draftRef.current;
    const id = loadedId.current;
    setBusy(true); setError("");
    try {
      const name = snapshot.definition.name?.trim() || "未命名流程";
      const saved = await useWorkflowsStore.getState().save({ id: snapshot.definition.id, revision: snapshot.revision, name, definition: { ...snapshot.definition, name }, layout: snapshot.layout });
      const next = draftRef.current === snapshot ? asDraft(saved) : { ...draftRef.current, revision: saved.revision };
      if (id === "__new") {
        draftViews.current.delete(id);
        try { localStorage.removeItem(draftKey(id)); } catch { /* Storage can be disabled. */ }
        setHasLocalDraft(false);
      }
      loadedId.current = saved.id; draftRef.current = next; setDraft(next);
      history.current = history.current.filter(item => item.definition.id === saved.id).map(item => ({ ...item, revision: saved.revision }));
      future.current = future.current.filter(item => item.definition.id === saved.id).map(item => ({ ...item, revision: saved.revision }));
      writeDraft(saved.id, next);
      setParams({ template: saved.id }); toast.success("流程已保存");
    } catch (failure) {
      const reported: WorkflowValidation = { valid: false, issues: [{ path: "save", message: String(failure) }] };
      const checked = graphIssues(snapshot.definition, reported.issues).find(issue => !issue.warning);
      if (checked?.nodeId && draftRef.current.definition === snapshot.definition) {
        setValidation({ definition: snapshot.definition, result: reported });
        showIssue(checked);
      }
      else setError(/revision|版本/i.test(String(failure)) ? "这个流程有更新的保存版本。重新打开后再保存。" : "流程未能保存。请检查连线和节点设置后重试。");
    } finally { setBusy(false); }
  }
  function toggleLibrary(): void {
    libraryToggled.current = true;
    localStorage.setItem("nautilo.workflow.library-collapsed", String(!libraryCollapsed));
    setLibraryCollapsed(!libraryCollapsed);
  }
  function duplicateTemplate(template: WorkflowTemplate): void {
    if (canvasLocked) return;
    openFromLibrary(undefined, true);
    change(next => {
      next.definition = { ...copy(template.definition), id: next.definition.id, name: template.name + " 副本" };
      next.layout = copy(template.layout);
    });
    selectNode(template.definition.entry);
  }
  function exportDefinition(value: WorkflowDefinition, jsonText = JSON.stringify(value, null, 2)): void {
    const url = URL.createObjectURL(new Blob([jsonText], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = value.id + ".json"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importDefinition(file: File): Promise<void> {
    if (canvasLocked) return;
    setBusy(true);
    try {
      const definition = JSON.parse(await file.text()) as WorkflowDefinition;
      const checked = await requestCore<WorkflowValidation>("workflow.validate", { definition });
      if (!checked.valid) throw new Error(checked.issues.map(issue => issue.message).join("\n"));
      openFromLibrary(undefined, true);
      change(next => { next.definition = { ...definition, id: next.definition.id }; next.layout = initialLayout(next.definition); });
      selectNode(definition.entry);
    } catch (error) { setError("导入失败 · " + String(error)); }
    finally { setBusy(false); }
  }
  async function archiveTemplate(template: WorkflowTemplate): Promise<void> {
    setBusy(true);
    try {
      await requestCore("workflow.archive", { id: template.id, revision: template.revision });
      if (template.id === templateId) openFromLibrary();
      setArchiveTarget(undefined);
      await useWorkflowsStore.getState().loadTemplates();
      toast.success("已从流程库移除");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  async function control(action: "pause" | "resume" | "cancel" | "approve" | "reject" | "retry_node" | "decline_retry" | WorkspaceAction, instanceId?: string): Promise<void> {
    if (!run) return; setBusy(true);
    try {
      const next = await requestCore<WorkflowRun>("workflow.control", { runId: run.id, action, ...(instanceId ? { instanceId } : {}), ...(["recheck_workspace", "retry_node"].includes(action) ? { confirmed: true } : {}) });
      setRun(next); useWorkflowsStore.getState().observe(next); setRefreshKey(value => value + 1);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  function addNode(kind: AddableKind, at?: Point, from?: Connection, insert?: EdgeSelection): void {
    const newNode = createNode(kind, draftRef.current.definition);
    const id = newNode.id;
    change(next => {
      const origin = next.layout.nodes[selected || next.definition.entry] || { x: 80, y: 140 };
      const size = nodeSize(newNode);
      let position = at ? { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2) }
        : { x: origin.x + 240, y: origin.y + Math.min(3, next.definition.nodes.length - 2) * 48 };
      if (insert) {
        const rows = placeNodes(next.definition, next.layout);
        const edge = findEdge(next.definition, insert);
        const source = rows.find(row => row.node.id === insert.source);
        const target = rows.find(row => row.node.id === (insert.limit ? edge?.onLimit : edge?.to));
        if (source && target && !edge?.maxTraversals && source.position.x < target.position.x) {
          position.x = Math.max(position.x, source.position.x + source.size.width + 52);
          const column = target.position.x;
          const space = Math.max(0, position.x + size.width + 52 - column);
          if (space) for (const row of rows) if (row.position.x >= column) {
            row.position = { x: row.position.x + space, y: row.position.y };
            next.layout.nodes[row.node.id] = row.position;
          }
        }
        const occupied = rows.filter(row =>
          position.x < row.position.x + row.size.width + 22 && position.x + size.width > row.position.x - 22);
        const candidates = [position.y, ...occupied.flatMap(row => [row.position.y - size.height - 32, row.position.y + row.size.height + 32])]
          .sort((a, b) => Math.abs(a - position.y) - Math.abs(b - position.y));
        const y = candidates.find(y => occupied.every(row => y + size.height + 22 <= row.position.y || y >= row.position.y + row.size.height + 22));
        position = { ...position, y: y ?? position.y };
      }
      next.definition.nodes.push(newNode);
      next.layout.nodes[id] = position;
      if (insert) {
        const previous = findEdge(next.definition, insert);
        const target = insert.limit ? previous?.onLimit : previous?.to;
        if (target && connectNodes(next.definition, insert, id)) {
          connectNodes(next.definition, { source: id, exit: newNode.exits[0].id }, target);
          if (next.layout.edgeRoutes) delete next.layout.edgeRoutes[edgeKey(insert)];
        }
      } else if (from) connectNodes(next.definition, from, id);
    });
    selectNode(id);
    setLocate(current => ({ nodeId: id, reveal: true, request: (current?.request ?? 0) + 1 }));
  }
  function deleteNodes(ids: string[]): void {
    const removable = new Set(ids.filter(id => id !== draftRef.current.definition.entry));
    if (!removable.size) return;
    change(next => {
      next.definition.nodes = next.definition.nodes.filter(node => !removable.has(node.id));
      next.definition.edges = next.definition.edges.filter(edge => !removable.has(edge.from[0]) && !removable.has(edge.to));
      for (const edge of next.definition.edges) if (edge.onLimit && removable.has(edge.onLimit)) { delete edge.onLimit; delete edge.maxTraversals; }
      for (const id of removable) delete next.layout.nodes[id];
    });
    selectNode("");
  }
  const deleteNode = (id: string) => deleteNodes([id]);
  function bypassNodes(ids: string[]): void {
    change(next => {
      const nodes = next.definition.nodes.filter(node => ids.includes(node.id) && node.kind === "agent" && node.exits.length === 1 && !node.forEach);
      const bypass = nodes.some(node => !node.bypass);
      for (const node of nodes) if (bypass) node.bypass = true; else delete node.bypass;
    });
  }
  function arrangeNodes(ids: string[], action: "horizontal" | "vertical" | "parallel", groupId?: string): void {
    const coordinates = ids.map(id => layout.nodes[id]).filter(Boolean);
    if (!coordinates.length) return;
    if (action !== "parallel") {
      const axis = action === "horizontal" ? "y" : "x";
      const at = Math.round(coordinates.reduce((sum, point) => sum + point[axis], 0) / coordinates.length);
      change(next => { for (const id of ids) if (next.layout.nodes[id]) next.layout.nodes[id][axis] = at; });
      return;
    }
    const sources = definition.edges.filter(edge => ids.includes(edge.to));
    const predecessor = definition.nodes.find(node => node.id === sources[0]?.from[0]);
    const targetGroup = definition.nodes.find(node => node.id === groupId);
    const sharesPredecessor = sources.length === ids.length && !!predecessor && sources.every(edge => edge.from[0] === predecessor.id && !edge.maxTraversals) &&
      new Set(sources.map(edge => edge.to)).size === ids.length;
    if (targetGroup && !sources.length && ids.every(id => id !== definition.entry)) {
      change(next => { for (const id of ids) connectNodes(next.definition, { source: targetGroup.id }, id); });
      return;
    }
    if (!sharesPredecessor || predecessor.kind !== "main" && predecessor.kind !== "dispatch" || ids.includes(predecessor.id)
      || targetGroup && targetGroup.id !== predecessor.id && targetGroup.kind !== "dispatch") {
      toast.error("请选择从同一个并行入口发出的分支，或把尚未连线的节点拖入分组。");
      return;
    }
    if (targetGroup?.id === predecessor.id) return;
    if (targetGroup) {
      if (!definition.edges.some(edge => edge.from[0] === predecessor.id && edge.to === targetGroup.id)
        || definition.nodes.some(node => node.kind === "join" && node.scope === predecessor.id)) {
        toast.error("此节点和目标分组使用不同的汇合范围。请先调整连线。"); return;
      }
      change(next => {
        const root = next.definition.nodes.find(node => node.id === predecessor.id)!;
        root.exits = root.exits.filter(port => !sources.some(edge => edge.from[1] === port.id));
        next.definition.edges = next.definition.edges.filter(edge => !sources.some(source => source.from[0] === edge.from[0] && source.from[1] === edge.from[1]));
        for (const edge of sources) connectNodes(next.definition, { source: targetGroup.id }, edge.to);
      });
      return;
    }
    if (definition.nodes.some(node => node.kind === "join" && node.scope === predecessor.id) && predecessor.exits.length !== sources.length) {
      toast.error("这个入口有汇合节点。请选中该汇合等待的全部分支。"); return;
    }
    const dispatch = createNode("dispatch", definition);
    dispatch.name = "并行分工";
    change(next => {
      const root = next.definition.nodes.find(node => node.id === predecessor.id)!;
      const edges = next.definition.edges.filter(edge => edge.from[0] === root.id && ids.includes(edge.to));
      const moving = new Set(edges.map(edge => edge.from[1]));
      dispatch.exits = root.exits.filter(port => moving.has(port.id));
      root.exits = root.exits.filter(port => !moving.has(port.id));
      next.definition.nodes.push(dispatch);
      for (const edge of edges) edge.from[0] = dispatch.id;
      connectNodes(next.definition, { source: root.id }, dispatch.id);
      for (const node of next.definition.nodes) if (node.kind === "join" && node.scope === root.id) node.scope = dispatch.id;
      next.layout = initialLayout(next.definition);
    });
    selectNode(dispatch.id);
  }
  function rewireSource(selection: EdgeSelection, id: string): void {
    change(next => {
      const previous = findEdge(next.definition, selection);
      const targetNode = next.definition.nodes.find(node => node.id === id);
      if (!previous || !targetNode || id === previous.to) return;
      const free = targetNode.exits.find(port => !findEdge(next.definition, { source: id, exit: port.id }));
      const connection = connectNodes(next.definition, { source: id, exit: free?.id }, previous.to);
      if (!connection) return;
      Object.assign(findEdge(next.definition, connection)!, { maxTraversals: previous.maxTraversals, onLimit: previous.onLimit });
      removeLink(next.definition, selection);
      selectEdge(connection);
    });
  }
  function moveOutOfGroup(id: string, groupId: string): void {
    const group = definition.nodes.find(node => node.id === groupId);
    if (group?.kind !== "dispatch" || group.exits.length < 2) return;
    const incoming = definition.edges.filter(edge => edge.to === groupId || edge.onLimit === groupId);
    const root = definition.nodes.find(node => node.id === incoming[0]?.from[0]);
    const branch = definition.edges.find(edge => edge.from[0] === groupId && edge.to === id);
    if (incoming.length !== 1 || !root || !["main", "dispatch"].includes(root.kind) || !branch || branch.maxTraversals
      || definition.nodes.some(node => node.kind === "join" && node.scope === groupId)) return;
    change(next => {
      const node = next.definition.nodes.find(node => node.id === groupId)!;
      node.exits = node.exits.filter(port => port.id !== branch.from[1]);
      removeLink(next.definition, { source: groupId, exit: branch.from[1] });
      connectNodes(next.definition, { source: root.id }, id);
    });
  }
  function arrangeLayout(): void {
    const before = layout.nodes;
    change(next => { next.layout = initialLayout(next.definition); });
    if (motionReduced) return;
    requestAnimationFrame(() => {
      for (const element of inspector.current?.parentElement?.querySelectorAll<HTMLElement>(".wf-node[data-node-id]") ?? []) {
        const id = element.dataset.nodeId!;
        const from = before[id], to = draftRef.current.layout.nodes[id];
        if (from && to && (from.x !== to.x || from.y !== to.y)) element.animate([
          { translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: "0 0" },
        ], { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    });
  }
  function connect(from: Connection, target: string): void {
    if (from.source === target) return;
    let connection: EdgeSelection | undefined;
    change(next => { connection = connectNodes(next.definition, from, target); });
    if (connection) selectEdge(connection);
  }
  function unlink(selection: EdgeSelection): void {
    change(next => removeLink(next.definition, selection));
    selectNode(selection.source);
  }
  function deleteOutlet(source: string, exit: string): void {
    change(next => {
      const node = next.definition.nodes.find(node => node.id === source);
      if (!node || !canRemoveOutlet(node, exit)) return;
      node.exits = node.exits.filter(port => port.id !== exit);
      removeLink(next.definition, { source, exit });
    });
    selectNode(source);
  }
  function copyNode(id: string): void {
    const node = draftRef.current.definition.nodes.find(node => node.id === id);
    if (node && node.kind !== "main") { setClipboard(copy(node)); toast.success("节点已复制"); }
  }
  function pasteNode(point: Point): void {
    if (!clipboard) return;
    cloneNode(clipboard, point);
  }
  function cloneNode(source: WorkflowNode, point?: Point): void {
    const node = { ...copy(source), id: source.kind + "-" + crypto.randomUUID().slice(0, 8), name: nodeLabel(source) + " 副本" };
    const origin = draftRef.current.layout.nodes[source.id] ?? { x: 80, y: 140 };
    change(next => {
      if (node.kind === "join") {
        delete node.sources;
        if (!next.definition.nodes.some(source => source.id === node.scope)) node.scope = next.definition.entry;
      }
      next.definition.nodes.push(node);
      next.layout.nodes[node.id] = point ? { x: Math.round(point.x), y: Math.round(point.y - nodeSize(node).height / 2) } : { x: origin.x + 32, y: origin.y + 36 };
    });
    selectNode(node.id);
  }
  function moveWire(selection: EdgeSelection, point?: Point): void {
    change(next => {
      const key = edgeKey(selection);
      if (point) (next.layout.edgeRoutes ??= {})[key] = { x: Math.round(point.x), y: Math.round(point.y) };
      else if (next.layout.edgeRoutes) delete next.layout.edgeRoutes[key];
      cleanLayout(next.definition, next.layout);
    });
  }
  const active = run && ["running", "paused", "finalizing"].includes(run.status);
  const liveRun = mode === "run" && sequence === undefined ? run : undefined;
  const executing = liveRun && !liveRun.approvalId && !liveRun.workspace?.approvalId &&
    (liveRun.status === "running" || liveRun.status === "finalizing" && liveRun.workspace?.stage !== "waiting_merge");
  const runningNodes = executing ? liveRun.instances.filter(instance => ["running", "verifying", "starting"].includes(instance.status)) : [];
  const runningNode = definition.nodes.find(node => node.id === runningNodes[0]?.nodeId);
  const runOptions = mode === "run" && !inspection ? summaries.map(item => ({ value: item.id, label: `${new Date(item.createdAt).toLocaleString()} · ${statusLabels[item.status]}` })) : [];
  if (run && !inspection && !runOptions.some(item => item.value === run.id)) runOptions.push({ value: run.id, label: "本次运行" });
  const verificationTemplates = projects.find(project => project.id === sessions.find(session => session.id === sessionId)?.projectId)?.verificationTemplates || [];
  const pendingNodes = mode === "run" && sequence === undefined && run ? run.instances.filter(instance => instance.workspace?.stage === "waiting_approval") : [];
  const saved = templates.find(template => template.id === draft.definition.id);
  const dirty = saved ? JSON.stringify(draft) !== JSON.stringify(asDraft(saved)) : history.current.length > 0 || draft.definition.nodes.length > 1;
  const assignment = mode === "run" && run ? run.assignments?.[selected] : undefined;
  const playbackIndex = sequence === undefined ? (run?.events.length ?? 1) - 1 : Math.max(0, projection.events.length - 1);
  function seek(index: number): void {
    const event = run?.events[Math.min(run.events.length - 1, Math.max(index, 0))];
    if (!event) return;
    setSequence(event.sequence); setReplaying(false); setFollowing(true);
  }
  const query = search?.trim().toLowerCase();
  const searchResults = query === undefined ? [] : definition.nodes.filter(node => [nodeLabel(node), node.role, ...Object.keys(node.outputs ?? {})].some(value => value?.toLowerCase().includes(query)));
  const searchEdges = query ? definition.edges.flatMap(item => {
    const source = definition.nodes.find(node => node.id === item.from[0]);
    const outlet = source?.exits.find(port => port.id === item.from[1]);
    return outlet && [outlet.name, ...source!.cases?.filter(rule => rule.exit === outlet.id).map(rule => rule.path) ?? []].some(text => text.toLowerCase().includes(query))
      ? [{ source: item.from[0], exit: item.from[1], name: outlet.name }] : [];
  }) : [];
  function selectSearchResult(id: string, exitId?: string): void {
    setSearch(undefined);
    if (exitId) selectEdge({ source: id, exit: exitId }); else selectNode(id);
    setLocate(current => ({ nodeId: id, exitId, request: (current?.request ?? 0) + 1 }));
  }
  if (inspection && !run) return <div className="workflow-inspection-loading" role={runError ? "alert" : "status"}>
    <span>{runError ? "暂时无法打开执行记录" : "正在读取执行记录…"}</span>
    {runError && <button type="button" onClick={() => { setRunError(""); setRefreshKey(value => value + 1); }}>重试</button>}
  </div>;
  return <div className="workflow-studio" data-inspection={!!inspection || undefined} data-mode={mode} data-history={historyVersion} data-motion-reduced={motionReduced} onKeyDown={event => {
    if (event.key === "Escape" && preview && !event.defaultPrevented) setPreviewPlayback(undefined);
    const target = event.target as Element;
    if (mode !== "design" || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setSearch(""); }
    }
    if (target.closest("input,textarea,select,[contenteditable=true],[role=menu],[role=combobox],[role=listbox]")) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey); }
      if (event.key.toLowerCase() === "y") { event.preventDefault(); undo(true); }
      if (!canvasLocked && event.key.toLowerCase() === "d" && node && node.kind !== "main") { event.preventDefault(); cloneNode(node); }
      if (event.key.toLowerCase() === "c" && target.closest(".wf-canvas") && node?.kind !== "main" && node) {
        event.preventDefault(); copyNode(node.id);
      }
    }
    if (!canvasLocked && (event.key === "Delete" || event.key === "Backspace") && target.closest(".wf-canvas")) {
      if (selectedEdge && edge) { event.preventDefault(); unlink(selectedEdge); }
      else if (node && node.id !== definition.entry) { event.preventDefault(); deleteNode(node.id); }
    }
  }}>
    <div className="wf-page-header" data-replay={mode === "run" && sequence !== undefined}>
      <div className="wf-title-block">{inspection && run ? <>
        <div className="wf-inspection-status" data-status={run.status}><i aria-hidden/>{statusLabels[run.status]}</div>
        <h2 className="wf-inspection-title">{run.definition.name || "流程执行"}</h2>
      </> : <>
        {mode === "design" && <><button className="wf-icon-button" type="button" aria-label={libraryCollapsed ? "展开流程库" : "收起流程库"} aria-expanded={!libraryCollapsed} aria-controls="wf-library" title={libraryCollapsed ? "展开流程库" : "收起流程库"} onClick={toggleLibrary}>
          {libraryCollapsed ? <PanelLeftOpen size={15}/> : <PanelLeftClose size={15}/>}
        </button><i className="wf-toolbar-divider" aria-hidden/></>}
        <input className="wf-title-input" aria-label="流程名称" title="点击编辑流程名称" size={Math.min(26, Math.max(10, (definition.name?.length ?? 8) * 2))} value={definition.name || ""} readOnly={mode === "run" || canvasLocked} onChange={event => change(next => { next.definition.name = event.target.value; })}/>
        {mode === "design" && <><span className="wf-header-stat">{definition.nodes.length} 节点 · {definition.edges.length} 连线</span><button type="button" className="wf-health"
          data-tone={blockingIssues.length ? "error" : issues.length ? "warning" : "ok"}
          title={issues.length ? "点击定位第一条诊断问题" : "查看流程概览"}
          onClick={() => {
            const first = blockingIssues[0] ?? issues[0];
            if (first?.nodeId) showIssue(first);
            else selectNode("");
          }}>
          <i aria-hidden/>{blockingIssues.length ? `${blockingIssues.length} 项错误` : issues.length ? `${issues.length} 项提醒` : "校验通过"}
        </button></>}
      </>}</div>
      <StageActivityPill key={runId} activity={executing ? {
        id: liveRun.id, startedAt: liveRun.createdAt,
        label: runningNode ? nodeLabel(runningNode) + (runningNodes.length > 1 ? ` 等 ${runningNodes.length} 个节点` : "") : statusLabels[liveRun.status]
      } : undefined} completed={liveRun?.status === "completed" ? [liveRun.id] : undefined} />
      <div className="wf-header-actions">
        {mode === "run" && inspection && !!run?.messages.length && <button type="button" onClick={() => setMessagesOpen(true)}><BellRing size={13}/><span>会话消息</span><small>{run.messages.length}</small></button>}
        {mode === "run" && sequence !== undefined && <button type="button" onClick={() => { setSequence(undefined); setFollowing(true); setReplaying(false); }}>退出回放</button>}
        {mode === "run" && run?.parentRunId && <button onClick={() => inspectRun(run.parentRunId!)}><ArrowLeft size={14}/>父流程</button>}
        {mode === "run" && !inspection && <button onClick={() => { setMode("design"); setParams(templateId ? { template: templateId } : {}); }}><ArrowLeft size={14}/>返回画板</button>}
        {mode === "design" && <button onClick={() => setRunHistoryOpen(true)}><Activity size={14}/>运行记录{summaries.length > 0 && <small>{summaries.length}</small>}</button>}
        {!inspection && <button onClick={() => { setJsonText(JSON.stringify(definition, null, 2)); setJsonError(""); setJsonOpen(true); }}><Braces size={15}/><span>流程定义</span></button>}
        {mode === "design" && <button type="button" className="wf-preview-button" aria-pressed={previewPlaying} disabled={!definition.edges.length || busy}
          onClick={() => setPreviewPlayback(previewPlaying ? undefined : { definition, frames: buildWorkflowMotionPreview(definition), index: 0 })}>
          {previewPlaying ? <Square size={13}/> : <Play size={13}/>}<span>{previewPlaying ? "停止预览" : "预览动线"}</span>
        </button>}
        {mode === "design" ? <button className="wf-primary wf-save-button" data-dirty={dirty} disabled={busy} onClick={() => void save()}>{dirty && <i aria-label="有未保存的改动"/>}{saved && !dirty ? "已保存" : "保存"}</button> : active && sequence === undefined ? <>
          {run.status === "finalizing" ? <span className="wf-status">{run.workspace?.stage === "waiting_merge" ? "等待合并" : statusLabels[run.status]}</span> : <button disabled={busy} onClick={() => void control(run.status === "paused" ? "resume" : "pause")}>{run.status === "paused" ? <Play size={13}/> : <Pause size={13}/>} {run.status === "paused" ? "恢复调度" : "暂停调度"}</button>}
          <button disabled={busy} aria-label="停止流程" onClick={() => void control("cancel")}><Square size={13}/></button></> : !inspection && <span className="wf-status">{run && statusLabels[run.status]}</span>}
      </div>
    </div>
    {(error || runError) && <div role="alert" className="wf-error">{error || runError}<button aria-label="收起错误" onClick={() => { setError(""); setRunError(""); }}><X size={14}/></button></div>}
    {mode === "run" && sequence === undefined && run?.approvalId && <div className="wf-error" role="status">团队配置要求在派发前由你确认这次流程。<button className="wf-primary" disabled={busy} onClick={() => void control("approve")}>批准执行</button><button disabled={busy} onClick={() => void control("reject")}>拒绝</button></div>}
    {mode === "run" && run && sequence === undefined && !inspection && <WorkflowWorkspace run={run} interactive={true} busy={busy} onControl={control}/>}
    {!!pendingNodes.length && <div className="wf-pending-verifications"><span>{pendingNodes.length} 个节点等待验收命令批准</span>{pendingNodes.map(instance => <button key={instance.id} onClick={() => { selectNode(instance.nodeId); setInstanceId(instance.id); }}>{nodeLabel(definition.nodes.find(node => node.id === instance.nodeId)!)}<span>查看 →</span></button>)}</div>}
    <div className={mode === "design" ? "wf-editor-grid" : "wf-run-grid"} style={{ "--wf-inspector-width": inspectorWidth + "px" } as React.CSSProperties} data-library-collapsed={mode === "design" && libraryCollapsed} data-library-transition={libraryToggled.current}>
    {mode === "design" && <WorkflowLibrary templates={templates} activeId={templateId} ready={ready} showDraft={!templateId || hasLocalDraft} draftActive={!templateId} busy={busy}
      collapsed={libraryCollapsed} onClone={duplicateTemplate} onExport={template => exportDefinition(template.definition)}
      onArchive={setArchiveTarget} onImport={() => importFile.current?.click()}
      onNew={() => openFromLibrary(undefined, true)} onOpen={template => openFromLibrary(template)} onDraft={() => openFromLibrary()}/>}
    <section className="wf-stage" aria-label={mode === "design" ? "流程画布" : "执行现场"}>
      {mode === "run" && !inspection && <div className="wf-stage-bar"><span><Workflow size={14}/>执行现场<small>{sequence === undefined ? "实时" : "历史回放"}</small></span>
        <div className="wf-stage-controls">
          {!!run?.messages.length && <button onClick={() => setMessagesOpen(true)}><BellRing size={14}/>会话消息 {run.messages.length}</button>}
          <WorkflowSelect label="查看流程运行" value={runId} options={runOptions}
            onChange={id => setParams({ ...(templateId ? { template: templateId } : {}), run: id })} />
        </div>
      </div>}
      <WorkflowCanvas key={mode === "run" ? runId : definition.id} definition={definition} layout={layout} selected={selected} editing={mode === "design"} instances={projection.instances} events={projection.events} onSelect={selectNode} issues={issues}
        assignments={inspection && mode === "run" ? run?.assignments : undefined}
        locked={canvasLocked} onLockChange={setCanvasLocked} hoveredOutlet={hoveredOutlet}
        motionPlaying={mode === "design" || sequence === undefined || replaying} motionLive={sequence === undefined} motionReduced={motionReduced}
        preview={preview} previewPlaying={previewPlaying} libraryCollapsed={mode === "design" && libraryCollapsed} onMoveEnd={rememberMove} locate={mode === "design" ? locate : undefined}
        onMove={(id, x, y) => { const previous = draftRef.current; moveStart.current ??= previous; const next = { ...previous, layout: { ...previous.layout, nodes: { ...previous.layout.nodes, [id]: { x, y } } } }; draftRef.current = next; setDraft(next); }}
        editor={mode === "design" ? { edge: selectedEdge, canPaste: !!clipboard, selectEdge, connect, add: addNode, moveWire, unlink, removeOutlet: deleteOutlet, removeNode: deleteNode, copyNode, pasteNode,
          renameNode: (id, name) => change(next => { next.definition.nodes.find(item => item.id === id)!.name = name; }),
          renameEdge: (edge, name) => change(next => { next.definition.nodes.find(item => item.id === edge.source)!.exits.find(port => port.id === edge.exit)!.name = name; }),
          cloneNode: id => cloneNode(definition.nodes.find(item => item.id === id)!), bypassNodes, removeNodes: deleteNodes, arrangeNodes, rewireSource, moveOutOfGroup,
          startFrom: kind => change(next => { next.definition = applyStarter(next.definition, kind); next.layout = initialLayout(next.definition); }) } : undefined}>
        {mode === "design" && <>
          <button type="button" disabled={canvasLocked || !history.current.length} aria-label="撤销" title="撤销 · Ctrl / ⌘ + Z" onClick={() => undo()}><Undo2 size={15}/><span className="wf-dock-tooltip">撤销<kbd>Ctrl+Z</kbd></span></button>
          <button type="button" disabled={canvasLocked || !future.current.length} aria-label="重做" title="重做 · Ctrl / ⌘ + Y" onClick={() => undo(true)}><Redo2 size={15}/><span className="wf-dock-tooltip">重做<kbd>Ctrl+Y</kbd></span></button>
          <i className="wf-toolbar-divider" aria-hidden/>
          <button type="button" aria-label="自动排列节点" title="自动排列节点" disabled={canvasLocked} onClick={arrangeLayout}><Scan size={15}/><span>整理</span></button>
          <button type="button" aria-label="查找节点" title="查找 · Ctrl / ⌘ + K" onClick={() => setSearch("")}><Search size={15}/><span className="wf-dock-tooltip">搜索画布<kbd>Ctrl+K</kbd></span></button>
          <i className="wf-toolbar-divider" aria-hidden/>
        </>}
      </WorkflowCanvas>
      {mode === "run" && run && <div className="wf-timeline" data-replay={sequence !== undefined}>
        <div className="wf-timeline-bar">
          <div className="wf-timeline-controls">
            <button className="wf-playback" type="button" aria-label="起始事件" title="起始事件" disabled={!run.events.length} onClick={() => seek(0)}><SkipBack size={12}/></button>
            <button className="wf-playback" type="button" aria-label="上一步" title="上一步" disabled={playbackIndex <= 0} onClick={() => seek(playbackIndex - 1)}><StepBack size={12}/></button>
            <button className="wf-playback" type="button" disabled={!run.events.length} aria-label={replaying ? "暂停回放" : "播放执行记录"} title={replaying ? "暂停回放" : "回放轨迹"} onClick={() => {
              if (!replaying && (sequence === undefined || playbackIndex >= run.events.length - 1)) seek(0);
              setFollowing(true); setReplaying(!replaying);
            }}>{replaying ? <Pause size={12}/> : <Play size={12}/>}</button>
            <button className="wf-playback" type="button" aria-label="下一步" title="下一步" disabled={playbackIndex >= run.events.length - 1} onClick={() => seek(playbackIndex + 1)}><StepForward size={12}/></button>
          </div>
          <span className="wf-timeline-status-pill" data-live={sequence === undefined || undefined}>
            <i aria-hidden/>{sequence === undefined ? "实时" : replaying ? "回放中" : "已暂停"}
          </span>
          <div className="wf-timeline-event-inline" title={latestEvent ? workflowEventText(latestEvent, definition) : undefined}>
            {latestEvent && <time>{new Date(latestEvent.timestamp).toLocaleTimeString()}</time>}
            <span>{latestEvent ? workflowEventText(latestEvent, definition) : "等待执行事件"}</span>
          </div>
          <output className="wf-timeline-counter">{projection.events.length} / {run.events.length}</output>
        </div>
        {sequence !== undefined && <div className="wf-replay-grains" aria-hidden>{Array.from({length:20}, (_, index) => <i key={index} data-done={index < Math.round(projection.events.length / Math.max(1,run.events.length) * 20)}/>)}</div>}
        <div className="wf-timeline-scrubber">
          <div className="wf-event-track">{run.events.map((event, index) => ({ event, index })).filter(({ event }) => ["node.activated","node.completed","node.reminded","workflow.needs_decision"].includes(event.type)).slice(-120).map(({event, index}) => <button key={event.sequence} aria-label={`定位事件 ${event.sequence} ${workflowEventText(event, definition)}`} title={workflowEventText(event, definition)} data-reminder={event.type === "node.reminded"} data-current={index <= playbackIndex} onClick={() => seek(index)} style={{ left: `${index / Math.max(1, run.events.length - 1) * 100}%` }}/>)}</div>
          <input aria-label="定位执行事件" type="range" min={1} max={Math.max(1, run.events.length)} value={playbackIndex + 1} onChange={event => seek(Number(event.target.value) - 1)}/>
        </div>
      </div>}
    </section>
    <section ref={inspector} className="wf-inspector" aria-label="节点详情">
      {mode === "run" ? (
        <WorkflowRunInspector
          run={run}
          definition={definition}
          node={node}
          selected={selected}
          targetName={targetName}
          latestInstance={latestInstance}
          nodeInstances={nodeInstances}
          assignment={assignment}
          taskPrompt={taskPrompt}
          inspectorNodeChoices={inspectorNodeChoices}
          sequence={sequence}
          busy={busy}
          onSelectNode={selectNode}
          onSelectInstance={setInstanceId}
          onOpenSession={openConversation}
          onInspectRun={inspectRun}
          onControl={control}
          onRetryInstance={setRetryInstance}
        />
      ) : <>
      <div className="wf-inspector-resize" role="separator" aria-label="属性栏宽度" aria-orientation="vertical" aria-valuemin={310} aria-valuemax={440} aria-valuenow={inspectorWidth} tabIndex={0}
        onKeyDown={event => { if (["ArrowLeft","ArrowRight"].includes(event.key)) { event.preventDefault(); setInspectorWidth(width => Math.min(440, Math.max(310, width + (event.key === "ArrowLeft" ? 10 : -10)))); } }}
        onPointerDown={event => { if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); } }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setInspectorWidth(Math.round(Math.max(310, Math.min(440, inspector.current!.getBoundingClientRect().right - event.clientX)))); }}/>
      {node ? <header className="wf-node-heading" data-tone={nodeTone(node)}>
        <div className="wf-node-identity">
          <WorkflowSelect label="选择节点" value={node.id} options={inspectorNodeChoices} onChange={selectNode}>
            <div className="wf-node-name-editor">
              <Menu.Label>节点名称</Menu.Label>
              <Menu.Item asChild disabled={canvasLocked}>
                <input className="wf-node-name" aria-label="节点名称" disabled={canvasLocked} value={nodeLabel(node)}
                  onChange={event => editNode(node => { node.name = event.target.value; })}
                  onClick={event => { if (event.detail > 0) event.preventDefault(); }}
                  onKeyDown={event => {
                    if (event.nativeEvent.isComposing || !["Enter", "Escape", "ArrowUp", "ArrowDown", "Tab"].includes(event.key)) event.stopPropagation();
                  }}/>
              </Menu.Item>
            </div>
          </WorkflowSelect>
          <span className="wf-node-role" title={node.role || "控制节点"}>{node.role || "控制节点"}</span>
          <div className="wf-node-heading-actions">
            <button className="wf-icon-button" type="button" title="定位居中" aria-label="定位居中" disabled={canvasLocked} onClick={() => locateNode(node.id)}><Scan size={14}/></button>
            {node.kind !== "main" && <>
              <button className="wf-icon-button" type="button" aria-label="克隆节点" title="克隆节点" disabled={canvasLocked} onClick={() => cloneNode(node)}><Copy size={14}/></button>
              <button className="wf-icon-button wf-delete-outlet" type="button" aria-label="删除节点" title="删除节点" disabled={canvasLocked} onClick={() => deleteNode(node.id)}><Trash2 size={14}/></button>
            </>}
          </div>
        </div>
        {node.kind === "agent" && <fieldset className="wf-inspector-tabs" disabled={canvasLocked}>
          <WorkflowSegments<InspectorTab> label="Agent 节点属性" value={inspectorTab} onChange={setInspectorTab}
            options={[{ value: "instructions", label: "指令与角色", warning: issues.some(issue => issue.nodeId === node.id && issue.path.includes("prompt")) },
              { value: "output", label: "输出与流转", count: Object.keys(node.outputs ?? {}).length },
              { value: "environment", label: "环境与容错", warning: !!node.workspace?.allowedPaths?.length || (node.maxAttempts ?? 1) > 1 }]}/>
        </fieldset>}
      </header> : <header>
        <strong>{edge ? "连线属性" : "流程概览"}</strong>
        {!edge && <WorkflowSelect label="选择节点" placeholder="选择节点" value={selected || undefined} options={inspectorNodeChoices} onChange={selectNode}/>}
      </header>}
      {edge && selectedEdge && mode === "design" ? <fieldset className="wf-edge-inspector" disabled={canvasLocked}>
        <div className="wf-inspector-object"><span><Link size={15}/></span><div><h2>{outlet?.name || "连线"}</h2><small>{selectedEdge.limit ? "达到循环上限时" : "命名出口"}</small></div></div>
        <div className="wf-edge-flow"><span>{targetName(edge.from[0])}</span><ChevronRight size={14}/><span>{targetName(selectedEdge.limit ? edge.onLimit : edge.to)}</span>
          {!selectedEdge.limit && !edge.maxTraversals && sourceNode?.kind !== "main" && !edge.to.startsWith("$") && <button type="button" aria-label="反转连线" title="反转连线" onClick={() => {
            let updated: EdgeSelection | undefined;
            change(next => {
              const target = next.definition.nodes.find(node => node.id === edge.to)!;
              const free = target.exits.find(port => !findEdge(next.definition, { source: target.id, exit: port.id }));
              updated = connectNodes(next.definition, { source: target.id, exit: free?.id }, edge.from[0]);
              if (updated) removeLink(next.definition, selectedEdge);
            });
            if (updated) selectEdge(updated);
          }}><ArrowDownUp size={13}/></button>}
        </div>
        {outlet && <label className="wf-json-field">出口名称<input aria-label="连线出口名称" value={outlet.name} onChange={event => change(next => {
          const port = next.definition.nodes.find(node => node.id === selectedEdge.source)?.exits.find(port => port.id === outlet.id);
          if (port) port.name = event.target.value;
        })}/></label>}
        {sourceNode?.kind === "condition" && <WorkflowFields node={sourceNode} definition={definition} templates={templates} readOnly={false} exitId={selectedEdge.exit}
          onEdit={edit => change(next => edit(next.definition.nodes.find(node => node.id === sourceNode.id)!))}/>}
        {(edge.maxTraversals !== undefined || loop.has(definition.edges.indexOf(edge))) && <div className="wf-loop-policy">
          <div className="wf-field-title">回环熔断</div>
          <div className="wf-inline-field">最大回环轮次<Stepper label="最大回环轮次" value={edge.maxTraversals ?? 2} min={1} max={Math.max(10, edge.maxTraversals ?? 0)} onChange={value => change(next => {
            const item = findEdge(next.definition, selectedEdge)!;
            item.maxTraversals = value;
            item.onLimit ??= "$return_needs_decision";
          })}/></div>
          {!edge.maxTraversals && <button type="button" className="wf-add-exit" onClick={() => change(next => {
            const item = findEdge(next.definition, selectedEdge)!;
            item.maxTraversals = 2; item.onLimit = "$return_needs_decision";
          })}>启用默认 2 轮上限</button>}
          {edge.maxTraversals && <div className="wf-inline-field">超限后去向<WorkflowSelect label="超限后去向" value={edge.onLimit} options={targetChoices.filter(item => item.value && item.value !== edge.from[0])}
            onChange={value => change(next => { findEdge(next.definition, selectedEdge)!.onLimit = value; })}/></div>}
        </div>}
        <div className="wf-edge-actions">
          {layout.edgeRoutes?.[edgeKey(selectedEdge)] && <button type="button" onClick={() => moveWire(selectedEdge)}>重置走向</button>}
          <button type="button" onClick={() => unlink(selectedEdge)}><Trash2 size={13}/>删除连线</button>
        </div>
      </fieldset> :
      mode === "design" && !node && !returnSelected ? <div className="wf-overview">
        <section>
          <h2>{definition.name || "未命名流程"}</h2>
          <label className="wf-json-field">流程描述<textarea aria-label="流程描述" readOnly={canvasLocked} value={definition.description ?? ""} onChange={event => change(next => { next.definition.description = event.target.value; })} placeholder="说明这个流程适合处理什么任务"/></label>
          <div className="wf-overview-reference"><span><Workflow size={13}/>@{definition.name || "未命名流程"}</span>
            <button title="复制流程引用" type="button" onClick={() => void navigator.clipboard.writeText("@" + (definition.name || "未命名流程")).then(() => toast.success("已复制流程引用"))}><Copy size={13}/>复制</button>
          </div>
        </section>
        <section>
          <h3>拓扑概览</h3>
          <div className="wf-overview-kpis">
            <div className="wf-overview-kpi">
              <small>节点</small>
              <strong>{definition.nodes.length}</strong>
            </div>
            <div className="wf-overview-kpi">
              <small>连线</small>
              <strong>{definition.edges.length}{loop.size > 0 && <span>/ {loop.size}环</span>}</strong>
            </div>
            <div className="wf-overview-kpi">
              <small>产出字段</small>
              <strong>{definition.nodes.reduce((total, node) => total + Object.keys(node.outputs ?? {}).length, 0)}</strong>
            </div>
          </div>
          <div className="wf-field-title">节点健康度</div>
          <div className="wf-overview-health-pills">
            {definition.nodes.map(item => {
              const alerts = issues.filter(issue => issue.nodeId === item.id);
              const pillTone = alerts.some(issue => !issue.warning) ? "error" : alerts.length ? "warning" : "ok";
              return <button type="button" key={item.id} className="wf-health-pill" data-tone={pillTone} title={"点击定位 " + nodeLabel(item)} aria-label={"定位 " + nodeLabel(item)} onClick={() => { selectNode(item.id); locateNode(item.id); }}>
                <i aria-hidden/><span>{nodeLabel(item)}</span>
              </button>;
            })}
          </div>
          <p className="wf-field-help">最多并行 {definition.limits?.maxParallel ?? 8} 个任务 · 超时 {Math.round((definition.limits?.timeoutMs ?? 3600000) / 60000)} 分钟</p>
        </section>
        <section>
          <h3>图谱与变量体检</h3>
          {!issues.length && <span className="wf-health-pass">拓扑就绪</span>}
          <ul className="wf-overview-issues" aria-label="待检查的问题">{issues.map(issue => <li key={issue.path + issue.message} data-warning={issue.warning}>
            {issue.nodeId ? <button type="button" onClick={() => showIssue(issue)}>
              <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}><CircleAlert size={13}/><span>{issue.message}</span></span>
              <span className="wf-issue-jump" aria-hidden>定位 →</span>
            </button> : <span style={{ display: "block", padding: "9px 11px" }}>{issue.message}</span>}
          </li>)}</ul>
        </section>
      </div> :
      <fieldset className="wf-inspector-grid" disabled={canvasLocked}>{!node && <div>
        <h2>{targetName(selected)}</h2><small>控制节点</small>
      </div>}
      <div>{node?.kind === "agent" ? <>
        {inspectorTab === "instructions" && <div role="tabpanel" aria-label="指令与角色">
          <section className="wf-inspector-section">
            <div className="wf-field-title">基础配置</div>
            <div className="wf-inline-field wf-agent-field">角色<WorkflowSelect label="角色" value={node.role && Object.hasOwn(roles, node.role) ? node.role : "custom"}
              options={workflowChoices(roles)} onChange={value => editNode(node => { node.role = value === "custom" ? "" : value; })}/></div>
            {(!node.role || !Object.hasOwn(roles, node.role)) && <label className="wf-inline-field">自定义角色<input aria-label="自定义角色" value={node.role || ""} onChange={event => editNode(node => { node.role = event.target.value; })}/></label>}
            <div className="wf-inline-field">会话复用<WorkflowSegments label="会话复用" value={node.session || "fresh"} options={[{value:"fresh",label:"每次新建"},{value:"reuse",label:"复用会话"}]}
              onChange={value => editNode(node => { node.session = value; })}/></div>
            <p className="wf-field-help">{node.session === "reuse" ? "回环回到这个节点时继续原子会话。" : "每次运行此节点时使用独立子会话。"}</p>
          </section>
          <section className="wf-inspector-section">
            <WorkflowPrompt key={node.id} definition={definition} node={node} onChange={text => editNode(node => { node.prompt = text; })}/>
          </section>
        </div>}
      </> : node?.kind === "main" ? <p className="wf-control-description">从当前会话发起流程，同时派发已连接的出口。所有 Agent 节点的任务提示词将在启动前验证。</p> : node?.kind === "dispatch" ? <p className="wf-control-description">将输入同时发送给所有已连接的出口，由引擎自动推进。</p> : null}
      {issues.filter(issue => issue.nodeId === node?.id && !issue.exitId && !!issue.nodeId).map(issue =>
        <p key={issue.path + issue.message} className="wf-field-error">{issue.message}</p>
      )}
      {node && <WorkflowFields key={node.id} node={node} definition={definition} templates={templates} verificationTemplates={verificationTemplates} readOnly={false} tab={inspectorTab} onEdit={editNode}
        onInsertField={name => { editNode(node => { node.prompt = [node.prompt, name].filter(Boolean).join(" "); }); setInspectorTab("instructions"); }}/>}
      </div>
      {node && (node.kind !== "agent" || inspectorTab === "output") && (node.exits.length > 0 || node.kind !== "join") && <div className="wf-exits">
        <div className="wf-field-title">出口与路由{node.kind === "agent" && <WorkflowSegments label="出口选择" value={node.exitMode || "one"}
          options={[{value:"one",label:"单选"},{value:"some",label:"多选"}]} onChange={value => editNode(node => { node.exitMode = value; })}/>}</div>
        {node.exits.map(exit => {
        const connection = findEdge(definition, { source: node.id, exit: exit.id });
        const issue = issues.find(issue => issue.nodeId === node.id && issue.exitId === exit.id && !issue.warning);
        if (node.kind === "agent") return <details className="wf-outlet-field" key={exit.id} data-issue={!!issue}
          onPointerEnter={() => setHoveredOutlet({ source: node.id, exit: exit.id })} onPointerLeave={() => setHoveredOutlet(undefined)}>
          <summary><span className="wf-outlet-name" title={exit.name}>{exit.name}</span><span className="wf-outlet-destination"><span title={targetName(connection?.to)}>{targetName(connection?.to)}</span>{connection?.maxTraversals ? <span className="wf-outlet-limit">· ≤{connection.maxTraversals}轮</span> : null}</span></summary>
          <label className="wf-inline-field">出口名称<input value={exit.name} onChange={event => editNode(item => { item.exits.find(port => port.id === exit.id)!.name = event.target.value; })}/></label>
          <div className="wf-inline-field">连接到<WorkflowSelect label={exit.name + "的目标"} value={connection?.to || ""} options={targetChoices} onChange={value => change(next => {
            if (value) connectNodes(next.definition, { source: node.id, exit: exit.id }, value);
            else removeLink(next.definition, { source: node.id, exit: exit.id });
          })}/></div>
          <div className="wf-edge-actions">{connection && <button type="button" onClick={() => { selectEdge({ source: node.id, exit: exit.id }); locateNode(node.id); }}><ArrowUpRight size={13}/>查看连线</button>}
            {canRemoveOutlet(node, exit.id) && <button type="button" onClick={() => deleteOutlet(node.id, exit.id)}><Trash2 size={13}/>删除出口</button>}</div>
        </details>;
        return <div className="wf-outlet-field" key={exit.id} data-issue={!!issue} onPointerEnter={() => setHoveredOutlet({ source: node.id, exit: exit.id })} onPointerLeave={() => setHoveredOutlet(undefined)}>
          <div className="wf-exit-row"><span className="wf-port-dot"/><input aria-label={exit.name + "的出口名称"} value={exit.name} onChange={event => editNode(n => { n.exits.find(p => p.id === exit.id)!.name = event.target.value; })}/>
            {canRemoveOutlet(node, exit.id) && <button type="button" className="wf-icon-button wf-delete-outlet" aria-label={"删除出口 " + exit.name} title="删除出口" onClick={() => deleteOutlet(node.id, exit.id)}><Trash2 size={13}/></button>}
          </div>
          <div className="wf-exit-target"><ChevronRight size={13}/>
            <WorkflowSelect label={exit.name + "的目标"} value={connection?.to || ""} options={targetChoices} onChange={value => {
              if (value) connect({ source: node.id, exit: exit.id }, value);
              else unlink({ source: node.id, exit: exit.id });
            }}/>
          </div>
          {issue && <button type="button" className="wf-outlet-issue" onClick={() => showIssue(issue)}><CircleAlert size={12}/>{issue.message}</button>}
        </div>;
      })}{node.kind === "agent" && !definition.edges.some(edge => edge.from[0] === node.id) && <button className="wf-add-exit" onClick={() => addNode("agent", undefined, { source: node.id, exit: node.exits[0]?.id })}><Plus size={13}/>添加下游节点</button>}
        {(node.kind !== "join" || !node.exits.length) && <button className="wf-add-exit" onClick={() => editNode(node => { appendOutlet(node); })}><Plus size={13}/>添加出口</button>}</div>}
      </fieldset>}</>}
    </section>
    </div>
    {inspection && run && sequence === undefined && <WorkflowWorkspace run={run} interactive={true} busy={busy} onControl={control}/>}
    {mode === "design" && <input hidden ref={importFile} type="file" accept=".json,application/json" onChange={event => {
      const file = event.target.files?.[0];
      if (file) void importDefinition(file);
      event.target.value = "";
    }}/>}
    <Dialog open={!!archiveTarget} onOpenChange={open => { if (!open) setArchiveTarget(undefined); }} title="从流程库移除"
      description={`「${archiveTarget?.name ?? ""}」会从列表中移除。历史运行和已引用的版本仍可打开。`}>
      <div className="wf-dialog-actions"><button type="button" onClick={() => setArchiveTarget(undefined)}>取消</button>
        <button className="wf-danger-action" type="button" disabled={busy} onClick={() => { if (archiveTarget) void archiveTemplate(archiveTarget); }}>确认移除</button></div>
    </Dialog>
    <Dialog open={search !== undefined} onOpenChange={open => { if (!open) setSearch(undefined); }} title="查找画布节点">
      <input className="wf-search-input" aria-label="搜节点、角色或结果字段" autoFocus placeholder="搜节点、角色或结果字段" value={search ?? ""} onChange={event => setSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          if (searchResults[0]) selectSearchResult(searchResults[0].id);
          else if (searchEdges[0]) selectSearchResult(searchEdges[0].source, searchEdges[0].exit);
        }}/>
      <div className="wf-search-results">{searchResults.map(item => <button key={item.id} type="button" onClick={() => selectSearchResult(item.id)}><span>{nodeLabel(item)}</span><small>{item.role || nodeKinds[item.kind]}</small></button>)}
        {searchEdges.map(item => <button key={edgeKey(item)} type="button" onClick={() => selectSearchResult(item.source, item.exit)}><span>{item.name}</span><small>连线</small></button>)}
        {!searchResults.length && !searchEdges.length && <p>没有匹配项</p>}</div>
    </Dialog>
    <Dialog open={runHistoryOpen} onOpenChange={setRunHistoryOpen} title="运行记录">
      <div className="wf-search-results">{summaries.map(item => <button key={item.id} type="button" onClick={() => { setRunHistoryOpen(false); setParams({ ...(templateId ? { template: templateId } : {}), run: item.id }); }}><span>{item.name || "未命名流程"}</span><small>{statusLabels[item.status]} · {new Date(item.createdAt).toLocaleString()}</small></button>)}{!summaries.length && <p>暂无运行记录</p>}</div>
    </Dialog>
    <Dialog open={!!retryInstance} onOpenChange={open => { if (!open) setRetryInstance(undefined); }} title="重试节点" description="引擎会复用此节点的会话和工作区。确认上次执行的改动可以安全保留，再开始新一次尝试。">
      <div className="wf-dialog-actions"><button onClick={() => setRetryInstance(undefined)}>取消</button><button className="wf-primary" disabled={busy} onClick={() => { void control("retry_node", retryInstance); setRetryInstance(undefined); }}>确认重试</button></div>
    </Dialog>
    <Dialog open={jsonOpen} onOpenChange={setJsonOpen} title="流程定义" presentation="workspace" widthClass="wf-json-drawer"
      description="画布和 Agent 使用同一份结构。导入后先验证，再应用到草稿。">
      <div className="wf-json-code">
        <pre ref={jsonPreview} aria-hidden>{jsonText.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?)/g).map((part, index) =>
          index % 2 ? <span key={index} data-token={part[0] !== '"' ? "literal" : part.endsWith(":") ? "key" : "string"}>{part}</span> : part)}{" "}</pre>
        <textarea className="wf-json-editor" aria-label="工作流 JSON" readOnly={mode === "run" || canvasLocked} spellCheck={false} value={jsonText} onChange={event => setJsonText(event.target.value)}
          onScroll={event => { if (jsonPreview.current) { jsonPreview.current.scrollTop = event.currentTarget.scrollTop; jsonPreview.current.scrollLeft = event.currentTarget.scrollLeft; } }}/>
      </div>
      {jsonError && <p role="alert">{jsonError}</p>}
      <div className="wf-dialog-actions"><button onClick={() => void navigator.clipboard.writeText(jsonText).then(() => toast.success("已复制")).catch(error => setJsonError(String(error)))}><Copy size={14}/>复制</button><button onClick={() => exportDefinition(definition, jsonText)}><Download size={14}/>导出</button>
        {mode === "design" && <button className="wf-primary" disabled={canvasLocked} onClick={() => { void (async () => { try { const definition = JSON.parse(jsonText) as WorkflowDefinition; const checked = await requestCore<{ valid: boolean; issues: Array<{ message: string }> }>("workflow.validate", { definition }); if (!checked.valid) throw new Error(checked.issues.map(i => i.message).join("\n")); change(next => { next.definition = definition; next.layout = initialLayout(definition); }); setSelected(definition.entry); setJsonOpen(false); } catch (error) { setJsonError(String(error)); } })(); }}>应用到画布</button>}
      </div>
    </Dialog>
    <Dialog open={messagesOpen} onOpenChange={setMessagesOpen} title="引擎推送的会话消息">
      <div className="wf-messages">{run?.messages.map(message => <article key={message.id}><header><BellRing size={14}/><strong>引擎 → {message.recipient === "main" ? "主 Agent" : "原子 Agent"}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time></header><p>{message.text}</p><small>{({ queued: "等待送达", delivering: "发送中", delivered: "已送达", resolved: "已补交", uncertain: "需要核对" } as Record<string, string>)[message.status]}</small></article>)}</div>
    </Dialog>
  </div>;
}
