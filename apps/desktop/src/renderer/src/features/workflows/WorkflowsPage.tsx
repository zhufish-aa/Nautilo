import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, ArrowLeft, BellRing, Braces, ChevronRight, CircleAlert, Copy, Download, Link, Pause, Play, Plus, Redo2, Save, Scan, Square, Trash2, Undo2, Workflow, X } from "lucide-react";
import type { WorkflowDefinition, WorkflowLayout, WorkflowNode, WorkflowRun, WorkflowTemplate, WorkflowValidation, WorkflowIssue } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { requestCore } from "../../lib/bridge";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { useSessionsStore } from "../../stores/sessions";
import { useWorkflowsStore } from "../../stores/workflows";
import { useProjectsStore } from "../../stores/projects";
import { toast } from "../../stores/toast";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { WorkflowFields } from "./WorkflowFields";
import { WorkflowWorkspace, type WorkspaceAction } from "./WorkflowAcceptance";
import { WorkflowIncoming } from "./WorkflowDispatchCard";
import { addableKinds, appendOutlet, blankWorkflow, canRemoveOutlet, cleanLayout, connectNodes, createNode, graphIssues, removeLink, type AddableKind } from "./workflow-editing";
import { edgeKey, findEdge, type Connection, type EdgeSelection, type Point } from "./workflow-geometry";
import { eventProjection, initialLayout, nodeKinds, nodeLabel, nodeSize, statusLabels, workflowEventText } from "./workflow-model";
import { buildWorkflowMotionPreview, type WorkflowMotionPreviewFrame } from "./workflow-motion-preview";
import "./workflows.css";
import "./workflow-motion.css";

interface Draft { definition: WorkflowDefinition; layout: WorkflowLayout; revision: number }
interface DraftView { draft: Draft; selected: string; undo: Draft[]; redo: Draft[] }
interface PreviewPlayback { definition: WorkflowDefinition; frames: WorkflowMotionPreviewFrame[]; index: number }
const draftKey = (id?: string): string => "nautilo.workflow.draft." + (id && id !== "__new" ? id : "new");
const copy = <T,>(value: T): T => structuredClone(value);
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
  const [issueListOpen, setIssueListOpen] = useState(false);
  const [locate, setLocate] = useState<{ nodeId: string; exitId?: string; request: number; reveal?: boolean }>();
  const [clipboard, setClipboard] = useState<WorkflowNode>();
  const [hasLocalDraft, setHasLocalDraft] = useState(() => !!readDraft());
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
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
  const [messagesOpen, setMessagesOpen] = useState(false);
  const sessions = useSessionsStore(state => state.sessions);
  const projects = useProjectsStore(state => state.projects);
  const sessionId = run?.sessionId ?? params.get("session") ?? useSessionsStore.getState().activeSessionId;
  const [promptEditing, setPromptEditing] = useState(false);
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
    setSelectedEdge(undefined); setLocate(undefined); setIssueListOpen(false); setPromptEditing(false); setError("");
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
      const next = (value ?? 0) + 1;
      if (next >= run.events.length) { setReplaying(false); return run.events.length; }
      return next;
    }), 700);
    return () => window.clearInterval(timer);
  }, [replaying, run?.events.length]);
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
    const items = panel.querySelectorAll<HTMLElement>(".wf-inspector-grid > div:first-child, .wf-inspector-grid > div:nth-child(2) > :is(.wf-field-title, .wf-prompt-read, .wf-inline-field, .wf-control-fields, .wf-control-description, details), .wf-exits");
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
  const sourceNode = edge && definition.nodes.find(node => node.id === edge.from[0]);
  const outlet = sourceNode?.exits.find(port => port.id === edge?.from[1]);
  function targetName(id?: string): string {
    if (id === "$return") return "交回主会话";
    if (id === "$return_needs_decision") return "交回判断";
    const target = definition.nodes.find(node => node.id === id);
    return target ? nodeLabel(target) : "未连接";
  }
  const issues = useMemo(() => mode === "design" ? graphIssues(draft.definition, validation?.definition === draft.definition ? validation.result.issues : []) : [], [mode, draft.definition, validation]);
  const blockingIssues = issues.filter(issue => !issue.warning);
  const showIssueTools = issues.length > 0 && (issueListOpen || definition.nodes.length > 1 || definition.edges.length > 0);
  const nodeInstances = [...projection.instances.values()].filter(instance => instance.nodeId === selected);
  const latestInstance = nodeInstances.find(instance => instance.id === instanceId) || nodeInstances.at(-1);
  const activation = latestInstance && projection.events.find(event => event.type === "node.activated" && event.instanceId === latestInstance.id);
  const taskPrompt = latestInstance?.taskText ?? (activation?.data as { prompt?: string } | undefined)?.prompt ?? latestInstance?.prompt;
  const latestEvent = projection.events.at(-1);
  useEffect(() => { if (following && mode === "run" && latestEvent?.nodeId) setSelected(latestEvent.nodeId); }, [following, mode, latestEvent?.sequence]);
  const change = useCallback((edit: (next: Draft) => void): void => {
    const previous = draftRef.current, next = copy(previous); edit(next);
    if (JSON.stringify(previous.definition.edges) !== JSON.stringify(next.definition.edges)) {
      for (const node of next.definition.nodes.filter(node => node.kind === "join" && node.sources)) {
        node.sources = [...new Set(next.definition.edges.filter(edge => edge.to === node.id || edge.onLimit === node.id).map(edge => edge.from[0]))];
        if (!node.sources.length) delete node.sources;
      }
      cleanLayout(next.definition, next.layout);
    }
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    history.current.push(previous); history.current = history.current.slice(-60); future.current = [];
    draftRef.current = next; setDraft(next);
    setHistoryVersion(v => v + 1);
  }, []);
  const editNode = (edit: (node: WorkflowNode) => void): void => change(next => { const n = next.definition.nodes.find(n => n.id === selected); if (n) edit(n); });
  const rememberMove = (): void => {
    if (!moveStart.current) return;
    history.current.push(moveStart.current); history.current = history.current.slice(-60); future.current = []; moveStart.current = undefined; setHistoryVersion(v => v + 1);
  };
  useEffect(() => { window.addEventListener("pointerup", rememberMove); window.addEventListener("pointercancel", rememberMove); return () => { window.removeEventListener("pointerup", rememberMove); window.removeEventListener("pointercancel", rememberMove); }; }, []);
  const selectNode = (id: string): void => { setSelected(id); setSelectedEdge(undefined); setInstanceId(undefined); setPromptEditing(false); if (mode === "run") setFollowing(false); };
  const selectEdge = (selection: EdgeSelection): void => { setSelectedEdge(selection); setSelected(""); setPromptEditing(false); };
  function showIssue(issue: WorkflowIssue): void {
    if (!issue.nodeId) return;
    setIssueListOpen(false);
    selectNode(issue.nodeId);
    setLocate(current => ({ nodeId: issue.nodeId!, exitId: issue.exitId, request: (current?.request ?? 0) + 1 }));
  }
  function canSubmit(): boolean {
    if (!editorValid()) return false;
    const issue = blockingIssues[0];
    if (!issue) return true;
    setError(""); showIssue(issue); setIssueListOpen(true);
    return false;
  }
  const undo = (redo = false): void => {
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
        showIssue(checked); setIssueListOpen(true);
      }
      else setError(/revision|版本/i.test(String(failure)) ? "这个流程有更新的保存版本。重新打开后再保存。" : "流程未能保存。请检查连线和节点设置后重试。");
    } finally { setBusy(false); }
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
      next.definition.nodes.push(newNode);
      const origin = next.layout.nodes[selected || next.definition.entry] || { x: 80, y: 140 };
      const size = nodeSize(newNode);
      next.layout.nodes[id] = at ? { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2) }
        : { x: origin.x + 240, y: origin.y + Math.min(3, next.definition.nodes.length - 2) * 48 };
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
  function deleteNode(id: string): void {
    if (draftRef.current.definition.entry === id) return;
    change(next => {
      next.definition.nodes = next.definition.nodes.filter(node => node.id !== id);
      next.definition.edges = next.definition.edges.filter(edge => edge.from[0] !== id && edge.to !== id);
      for (const edge of next.definition.edges) if (edge.onLimit === id) { delete edge.onLimit; delete edge.maxTraversals; }
      delete next.layout.nodes[id];
    });
    selectNode("");
  }
  function connect(from: Connection, target: string): void {
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
    const node = { ...copy(clipboard), id: clipboard.kind + "-" + crypto.randomUUID().slice(0, 8), name: nodeLabel(clipboard) + " 副本" };
    change(next => {
      if (node.kind === "join") {
        delete node.sources;
        if (!next.definition.nodes.some(source => source.id === node.scope)) node.scope = next.definition.entry;
      }
      next.definition.nodes.push(node);
      next.layout.nodes[node.id] = { x: Math.round(point.x), y: Math.round(point.y - nodeSize(node).height / 2) };
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
  const verificationTemplates = projects.find(project => project.id === sessions.find(session => session.id === sessionId)?.projectId)?.verificationTemplates || [];
  const pendingNodes = mode === "run" && sequence === undefined && run ? run.instances.filter(instance => instance.workspace?.stage === "waiting_approval") : [];
  if (inspection && !run) return <div className="workflow-inspection-loading" role={runError ? "alert" : "status"}>
    <span>{runError ? "暂时无法打开执行记录" : "正在读取执行记录…"}</span>
    {runError && <button type="button" onClick={() => { setRunError(""); setRefreshKey(value => value + 1); }}>重试</button>}
  </div>;
  return <div className="workflow-studio" data-inspection={!!inspection || undefined} data-mode={mode} data-history={historyVersion} data-motion-reduced={motionReduced} onKeyDown={event => {
    if (event.key === "Escape" && preview && !event.defaultPrevented) setPreviewPlayback(undefined);
    const target = event.target as Element;
    if (mode !== "design" || target.closest("input,textarea,select,[contenteditable=true],[role=menu]")) return;
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey); }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      if (event.key.toLowerCase() === "c" && target.closest(".wf-canvas") && node?.kind !== "main" && node) {
        event.preventDefault(); copyNode(node.id);
      }
    }
    if (event.key === "Delete" && target.closest(".wf-canvas")) {
      if (selectedEdge && edge) { event.preventDefault(); unlink(selectedEdge); }
      else if (node && node.id !== definition.entry) { event.preventDefault(); deleteNode(node.id); }
    }
  }}>
    <div className="wf-page-header">
      <div className="wf-title-block">{inspection && run ? <>
        <div className="wf-inspection-status" data-status={run.status}><i aria-hidden/>{statusLabels[run.status]}</div>
        <h2 className="wf-inspection-title">{run.definition.name || "流程执行"}</h2>
      </> : <><div className="wf-breadcrumb"><Workflow size={13}/>工作流<ChevronRight size={11}/><span>{mode === "run" ? "运行记录" : templateId ? "编辑流程" : "草稿"}</span></div>
        <input className="wf-title-input" aria-label="流程名称" value={mode === "run" && run ? run.definition.name || "流程执行" : draft.definition.name || ""} readOnly={mode === "run"} onChange={event => change(next => { next.definition.name = event.target.value; })}/></>}</div>
      <div className="wf-header-actions">
        {mode === "run" && run?.parentRunId && <button onClick={() => inspectRun(run.parentRunId!)}><ArrowLeft size={14}/>父流程</button>}
        {mode === "run" && !inspection && <button onClick={() => { setMode("design"); setParams(templateId ? { template: templateId } : {}); }}><ArrowLeft size={14}/>返回画板</button>}
        {mode === "design" && summaries.length > 0 && <button onClick={() => setParams({ ...(templateId ? { template: templateId } : {}), run: summaries[0].id })}><Activity size={14}/>运行记录</button>}
        {!inspection && <button onClick={() => { setJsonText(JSON.stringify(definition, null, 2)); setJsonError(""); setJsonOpen(true); }}><Braces size={15}/><span>流程定义</span></button>}
        {mode === "design" && <button type="button" className="wf-preview-button" aria-pressed={previewPlaying} disabled={!definition.edges.length || busy}
          onClick={() => setPreviewPlayback(previewPlaying ? undefined : { definition, frames: buildWorkflowMotionPreview(definition), index: 0 })}>
          {previewPlaying ? <Square size={13}/> : <Play size={13}/>}<span>{previewPlaying ? "停止预览" : "预览流程动效"}</span>
        </button>}
        {mode === "design" ? <button className="wf-primary" disabled={busy} onClick={() => void save()}><Save size={14}/>保存</button> : active ? <>
          {run.status === "finalizing" ? <span className="wf-status">{run.workspace?.stage === "waiting_merge" ? "等待合并" : statusLabels[run.status]}</span> : <button disabled={busy} onClick={() => void control(run.status === "paused" ? "resume" : "pause")}>{run.status === "paused" ? <Play size={13}/> : <Pause size={13}/>} {run.status === "paused" ? "恢复调度" : "暂停调度"}</button>}
          <button disabled={busy} aria-label="停止流程" onClick={() => void control("cancel")}><Square size={13}/></button></> : !inspection && <span className="wf-status">{run && statusLabels[run.status]}</span>}
      </div>
    </div>
    {(error || runError) && <div role="alert" className="wf-error">{error || runError}<button aria-label="收起错误" onClick={() => { setError(""); setRunError(""); }}><X size={14}/></button></div>}
    {mode === "run" && run?.approvalId && <div className="wf-error" role="status">团队配置要求在派发前由你确认这次流程。<button className="wf-primary" disabled={busy} onClick={() => void control("approve")}>批准执行</button><button disabled={busy} onClick={() => void control("reject")}>拒绝</button></div>}
    {mode === "run" && run && sequence === undefined && !inspection && <WorkflowWorkspace run={run} interactive={true} busy={busy} onControl={control}/>}
    {!!pendingNodes.length && <div className="wf-pending-verifications"><span>{pendingNodes.length} 个节点等待验收命令批准</span>{pendingNodes.map(instance => <button key={instance.id} onClick={() => { selectNode(instance.nodeId); setInstanceId(instance.id); }}>{nodeLabel(definition.nodes.find(node => node.id === instance.nodeId)!)}<span>查看 →</span></button>)}</div>}
    <div className={mode === "design" ? "wf-editor-grid" : "wf-run-grid"} data-library-collapsed={mode === "design" && libraryCollapsed} data-library-transition={libraryToggled.current}>
    {mode === "design" && <WorkflowLibrary templates={templates} activeId={templateId} ready={ready} showDraft={!templateId || hasLocalDraft} draftActive={!templateId} busy={busy}
      collapsed={libraryCollapsed} onToggle={() => { libraryToggled.current = true; setLibraryCollapsed(collapsed => !collapsed); }}
      onNew={() => openFromLibrary(undefined, true)} onOpen={template => openFromLibrary(template)} onDraft={() => openFromLibrary()}/>}
    <section className="wf-stage" aria-label={mode === "design" ? "流程画布" : "执行现场"}>
      <div className="wf-stage-bar"><span><Workflow size={14}/>{mode === "design" ? "流程画布" : "执行现场"}<small>{mode === "design" ? `${definition.nodes.length} 个节点 · ${definition.edges.length} 条连线` : sequence === undefined ? "实时" : "历史回放"}</small>{preview && <span className="wf-preview-status" role="status">{previewPlaying ? "正在预览" : "预览完成"}</span>}</span>
        <div>{mode === "design" ? <><button disabled={!history.current.length} aria-label="撤销" onClick={() => undo()}><Undo2 size={14}/></button><button disabled={!future.current.length} aria-label="重做" onClick={() => undo(true)}><Redo2 size={14}/></button><button aria-label="自动排列节点" onClick={() => change(next => { next.layout = initialLayout(next.definition); })}><Scan size={14}/></button><select aria-label="添加节点" value="" onChange={event => { const kind = addableKinds.find(kind => kind === event.target.value); if (kind) addNode(kind); }}><option value="">＋ 添加节点</option>{addableKinds.map(kind => <option key={kind} value={kind}>{nodeKinds[kind]}</option>)}</select></> : <>{!!run?.messages.length && <button onClick={() => setMessagesOpen(true)}><BellRing size={14}/>会话消息 {run.messages.length}</button>}<select aria-label="查看流程运行" value={runId || ""} onChange={event => setParams({ ...(templateId ? { template: templateId } : {}), run: event.target.value })}>{summaries.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {statusLabels[item.status]}</option>)}{run && !summaries.some(item => item.id === run.id) && <option value={run.id}>本次运行</option>}</select></>}</div>
      </div>
      <WorkflowCanvas key={mode === "run" ? runId : definition.id} definition={definition} layout={layout} selected={selected} editing={mode === "design"} instances={projection.instances} events={projection.events} onSelect={selectNode} issues={issues}
        motionPlaying={mode === "design" || sequence === undefined || replaying} motionLive={sequence === undefined} motionReduced={motionReduced}
        preview={preview} previewPlaying={previewPlaying} libraryCollapsed={mode === "design" && libraryCollapsed} onMoveEnd={rememberMove} locate={mode === "design" ? locate : undefined}
        onMove={(id, x, y) => { const previous = draftRef.current; moveStart.current ??= previous; const next = { ...previous, layout: { ...previous.layout, nodes: { ...previous.layout.nodes, [id]: { x, y } } } }; draftRef.current = next; setDraft(next); }}
        editor={mode === "design" ? { edge: selectedEdge, canPaste: !!clipboard, selectEdge, connect, add: addNode, moveWire, unlink, removeOutlet: deleteOutlet, removeNode: deleteNode, copyNode, pasteNode } : undefined}/>
      {mode === "design" && showIssueTools && <div className="wf-issue-tools">
        <button type="button" className="wf-issue-toggle" data-blocking={blockingIssues.length > 0} aria-expanded={issueListOpen} onClick={() => setIssueListOpen(open => !open)}>
          <CircleAlert size={14}/>{issues.length} 项待检查
        </button>
        {issueListOpen && <section className="wf-issue-list" aria-label="待检查的问题">
          <header><strong>{blockingIssues.length ? "保存前请修正" : "流程检查"}</strong><button className="wf-icon-button" aria-label="收起问题列表" onClick={() => setIssueListOpen(false)}><X size={14}/></button></header>
          <ul>{issues.map(issue => <li key={issue.path + issue.message}>{issue.nodeId ? <button type="button" onClick={() => showIssue(issue)}><span>{issue.message}</span><ChevronRight size={14}/></button> : <span>{issue.message}</span>}</li>)}</ul>
        </section>}
      </div>}
      {mode === "run" && run && <div className="wf-timeline"><div><strong>执行轨迹</strong><button className="wf-playback" aria-label={replaying ? "暂停回放" : "播放执行记录"} onClick={() => { if (!replaying && (sequence === undefined || sequence >= run.events.length)) setSequence(1); setFollowing(true); setReplaying(value => !value); }}>{replaying ? <Pause size={12}/> : <Play size={12}/>}</button><span>{sequence === undefined ? "实时记录" : replaying ? "正在回放" : "回放已暂停"}</span><button onClick={() => { setSequence(undefined); setFollowing(true); setReplaying(false); }} aria-pressed={sequence === undefined}>跟随实时</button><output>{projection.events.length} / {run.events.length}</output></div>
        <div className="wf-event-track">{run.events.filter(event => ["node.activated","node.completed","node.reminded","workflow.needs_decision"].includes(event.type)).slice(-120).map(event => <button key={event.sequence} aria-label={`定位事件 ${event.sequence} ${workflowEventText(event, definition)}`} title={workflowEventText(event, definition)} data-reminder={event.type === "node.reminded"} data-current={event.sequence <= (sequence ?? run.events.length)} onClick={() => { setSequence(event.sequence); setReplaying(false); }} style={{ left: `${event.sequence / Math.max(1, run.events.length) * 100}%` }}/>)}</div>
        <input aria-label="定位执行事件" type="range" min={1} max={Math.max(1, run.events.length)} value={sequence || run.events.length || 1} onChange={event => { setSequence(Number(event.target.value)); setReplaying(false); }}/><p><time>{latestEvent && new Date(latestEvent.timestamp).toLocaleTimeString()}</time>{latestEvent ? workflowEventText(latestEvent, definition) : "等待执行事件"}</p></div>}
    </section>
    <section ref={inspector} className="wf-inspector" aria-label="节点详情">
      <header>
        <strong>{mode === "run" ? "本轮执行" : edge ? "连线属性" : "节点属性"}</strong>
        {!edge && <select aria-label="选择节点" value={selected && (node || returnSelected) ? selected : ""} onChange={event => selectNode(event.target.value)}><option value="" disabled>选择节点</option>{definition.nodes.map(node => <option key={node.id} value={node.id}>{nodeLabel(node)}</option>)}<option value="$return">交回主会话</option><option value="$return_needs_decision">交回判断</option></select>}
      </header>
      {edge && selectedEdge && mode === "design" ? <div className="wf-edge-inspector">
        <div className="wf-inspector-object"><span><Link size={15}/></span><div><h2>{outlet?.name || "连线"}</h2><small>{selectedEdge.limit ? "达到循环上限时" : "命名出口"}</small></div></div>
        <dl><dt>起点</dt><dd>{sourceNode ? nodeLabel(sourceNode) : "未找到节点"}</dd><dt>终点</dt><dd>{targetName(selectedEdge.limit ? edge.onLimit : edge.to)}</dd></dl>
        {outlet && <label className="wf-json-field">出口名称<input aria-label="连线出口名称" value={outlet.name} onChange={event => change(next => {
          const port = next.definition.nodes.find(node => node.id === selectedEdge.source)?.exits.find(port => port.id === outlet.id);
          if (port) port.name = event.target.value;
        })}/></label>}
        <div className="wf-edge-actions">
          {layout.edgeRoutes?.[edgeKey(selectedEdge)] && <button type="button" onClick={() => moveWire(selectedEdge)}>重置走向</button>}
          <button type="button" onClick={() => unlink(selectedEdge)}><Trash2 size={13}/>删除连线</button>
        </div>
      </div> :
      mode === "design" && !node && !returnSelected ? <div className="wf-inspector-empty">
        <span className="wf-overview-icon"><Workflow size={20} aria-hidden="true"/></span>
        <h2>当前工作流概览</h2>
        <p>选择节点或连线查看设置。</p>
      </div> :
      <div className="wf-inspector-grid"><div>{mode === "design" && node ? <input className="wf-node-name" aria-label="节点名称" value={nodeLabel(node)} onChange={event => editNode(node => { node.name = event.target.value; })}/> : <h2>{node ? nodeLabel(node) : targetName(selected)}</h2>}<small>{node?.role || "控制节点"}</small>{mode === "run" && latestInstance && <><p className="wf-node-detail-state">{statusLabels[latestInstance.status]} · 第 {latestInstance.iteration} 次</p>{nodeInstances.length > 1 && <select aria-label="选择节点执行实例" value={latestInstance.id} onChange={event => setInstanceId(event.target.value)}>{nodeInstances.map(instance => <option key={instance.id} value={instance.id}>第 {instance.iteration} 次 · {statusLabels[instance.status]}</option>)}</select>}{latestInstance.sessionId && <button className="wf-open-session" type="button" onClick={() => openConversation(latestInstance.sessionId!)}>打开子会话 ↗</button>}</>}
        {mode === "run" && latestInstance?.childRunId && <button onClick={() => inspectRun(latestInstance.childRunId!)}>展开子流程 ↗</button>}
        {mode === "run" && !node && run && <button className="wf-open-session" type="button" onClick={() => openConversation(run.sessionId)}>打开主会话 ↗</button>}
      </div>
      <div>{node?.kind === "agent" ? <>
        <div className="wf-field-title"><label htmlFor={mode === "design" ? "wf-prompt" : undefined}>{mode === "run" && latestInstance?.taskText ? "任务正文" : "任务提示词"}</label>{mode === "design" && <button type="button" onClick={() => setPromptEditing(!promptEditing)}>{promptEditing ? "完成" : "编辑"}</button>}</div>
        {mode === "design" && promptEditing
          ? <textarea id="wf-prompt" placeholder="填写任务提示词" value={node.prompt || ""} onChange={event => editNode(node => { node.prompt = event.target.value; })}/>
          : mode === "run"
            ? <div className="wf-prompt-read" tabIndex={0}><PromptText text={latestInstance ? taskPrompt : node.prompt}/></div>
            : <button id="wf-prompt" type="button" className="wf-prompt-read" onClick={() => setPromptEditing(true)}>
              {node.prompt ? <PromptText text={node.prompt}/> : <span className="wf-placeholder">填写任务提示词</span>}
            </button>}
        {mode === "run" && latestInstance?.prompt && latestInstance.prompt !== taskPrompt && <details className="wf-dispatch-prompt"><summary>完整派发内容</summary><pre>{latestInstance.prompt}</pre></details>}
        {mode === "run" && run && latestInstance && <WorkflowIncoming dispatch={{ run, instance: latestInstance }} zh />}
        {mode === "design" && <label className="wf-inline-field wf-agent-field">角色<input value={node.role || ""} onChange={event => editNode(node => { node.role = event.target.value; })}/></label>}
        {mode === "design" && <label className="wf-inline-field wf-agent-field">结果交付<select value={node.completion || "tool"} onChange={event => editNode(node => { node.completion = event.target.value as WorkflowNode["completion"]; })}><option value="tool">调用提交工具</option><option value="structured_final">最终回复提交 JSON</option></select></label>}
        {mode === "design" && <label className="wf-inline-field wf-agent-field">会话使用<select value={node.session || "fresh"} onChange={event => editNode(node => { node.session = event.target.value as WorkflowNode["session"]; })}><option value="fresh">每次新建会话</option><option value="reuse">复用本节点的会话</option></select></label>}
        {mode === "run" && latestInstance?.submissionError && <p className="wf-node-submission-error">{latestInstance.submissionError}</p>}
        {mode === "run" && !!Object.keys(latestInstance?.nativeWork?.children || {}).length && <div className="wf-native-work"><span>原生子 Agent</span>{Object.entries(latestInstance!.nativeWork!.children).map(([id, status]) => <div key={id}><code title={id}>{id}</code><small>{latestInstance!.nativeWork!.released ? "已停止" : latestInstance!.nativeWork!.detached ? "已交回原会话" : status === "running" ? "仍在执行，流程等待中" : status === "done" ? "已完成" : "执行失败"}</small></div>)}</div>}
        {mode === "run" && !latestInstance?.result && latestInstance?.lastOutput && <details><summary>本轮已产出的内容</summary><pre>{latestInstance.lastOutput}</pre></details>}
      </> : node?.kind === "main" ? <p className="wf-control-description">从当前会话发起流程，同时派发已连接的出口。所有 Agent 节点的任务提示词将在启动前验证。</p> : node?.kind === "dispatch" ? <p className="wf-control-description">将输入同时发送给所有已连接的出口，由引擎自动推进。</p> : null}
      {mode === "run" && run && latestInstance && <WorkflowWorkspace key={latestInstance.id} run={run} instance={latestInstance} interactive={sequence === undefined} busy={busy} onControl={control}/>}
      {mode === "run" && run?.status === "running" && sequence === undefined && latestInstance?.status === "waiting_retry" && <div className="wf-command-review">
        <p>{latestInstance.error || "此节点等待重试"}</p>
        <div className="wf-workspace-actions">
          <button disabled={busy} onClick={() => void control("decline_retry", latestInstance.id)}>按失败处理</button>
          <button disabled={busy} className="wf-primary" onClick={() => setRetryInstance(latestInstance.id)}>重试此节点</button>
        </div>
      </div>}
      {mode === "design" && issues.filter(issue => issue.nodeId === node?.id && !issue.exitId && !!issue.nodeId).map(issue =>
        <p key={issue.path + issue.message} className="wf-field-error">{issue.message}</p>
      )}
      {node && <WorkflowFields key={node.id} node={node} definition={definition} templates={templates} verificationTemplates={verificationTemplates} readOnly={mode === "run"} onEdit={editNode}/>}
      </div>
      {node && (node.exits.length > 0 || mode === "design" && node.kind !== "join") && <div className="wf-exits"><label className="wf-field-title">出口</label>{node.exits.map(exit => {
        const connection = findEdge(definition, { source: node.id, exit: exit.id });
        const issue = issues.find(issue => issue.nodeId === node.id && issue.exitId === exit.id && !issue.warning);
        return <div className="wf-outlet-field" key={exit.id} data-issue={!!issue}>
          <div className="wf-exit-row"><span className="wf-port-dot"/><input aria-label={exit.name + "的出口名称"} readOnly={mode === "run"} value={exit.name} onChange={event => editNode(n => { n.exits.find(p => p.id === exit.id)!.name = event.target.value; })}/>
            {mode === "design" && canRemoveOutlet(node, exit.id) && <button type="button" className="wf-icon-button wf-delete-outlet" aria-label={"删除出口 " + exit.name} title="删除出口" onClick={() => deleteOutlet(node.id, exit.id)}><Trash2 size={13}/></button>}
          </div>
          <div className="wf-exit-target"><ChevronRight size={13}/>
            <select aria-label={exit.name + "的目标"} disabled={mode === "run"} value={connection?.to || ""} onChange={event => {
              if (event.target.value) connect({ source: node.id, exit: exit.id }, event.target.value);
              else unlink({ source: node.id, exit: exit.id });
            }}><option value="">未连接</option>{definition.nodes.filter(target => target.id !== definition.entry).map(target => <option key={target.id} value={target.id}>{nodeLabel(target)}</option>)}<option value="$return">交回主会话</option><option value="$return_needs_decision">交回判断</option></select>
          </div>
          {issue && <button type="button" className="wf-outlet-issue" onClick={() => showIssue(issue)}><CircleAlert size={12}/>{issue.message}</button>}
        </div>;
      })}{mode === "design" && (node.kind !== "join" || !node.exits.length) && <button className="wf-add-exit" onClick={() => editNode(node => { appendOutlet(node); })}><Plus size={13}/>添加出口</button>}</div>}
      {mode === "run" && latestInstance?.result !== undefined && <div className="wf-result"><details><summary>提交结果</summary><pre>{JSON.stringify(latestInstance.result, null, 2)}</pre></details></div>}</div>}
    </section>
    </div>
    {inspection && run && sequence === undefined && <WorkflowWorkspace run={run} interactive={true} busy={busy} onControl={control}/>}
    <Dialog open={!!retryInstance} onOpenChange={open => { if (!open) setRetryInstance(undefined); }} title="重试节点" description="引擎会复用此节点的会话和工作区。确认上次执行的改动可以安全保留，再开始新一次尝试。">
      <div className="wf-dialog-actions"><button onClick={() => setRetryInstance(undefined)}>取消</button><button className="wf-primary" disabled={busy} onClick={() => { void control("retry_node", retryInstance); setRetryInstance(undefined); }}>确认重试</button></div>
    </Dialog>
    <Dialog open={jsonOpen} onOpenChange={setJsonOpen} title="流程定义" description="画布和 Agent 使用同一份结构。导入后先验证，再应用到草稿。">
      <textarea className="wf-json-editor" aria-label="工作流 JSON" readOnly={mode === "run"} spellCheck={false} value={jsonText} onChange={event => setJsonText(event.target.value)}/>
      {jsonError && <p role="alert">{jsonError}</p>}
      <div className="wf-dialog-actions"><button onClick={() => void navigator.clipboard.writeText(jsonText).then(() => toast.success("已复制")).catch(error => setJsonError(String(error)))}><Copy size={14}/>复制</button><button onClick={() => { const url = URL.createObjectURL(new Blob([jsonText], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = definition.id + ".json"; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={14}/>导出</button>
        {mode === "design" && <button className="wf-primary" onClick={() => { void (async () => { try { const definition = JSON.parse(jsonText) as WorkflowDefinition; const checked = await requestCore<{ valid: boolean; issues: Array<{ message: string }> }>("workflow.validate", { definition }); if (!checked.valid) throw new Error(checked.issues.map(i => i.message).join("\n")); change(next => { next.definition = definition; next.layout = initialLayout(definition); }); setSelected(definition.entry); setJsonOpen(false); } catch (error) { setJsonError(String(error)); } })(); }}>应用到画布</button>}
      </div>
    </Dialog>
    <Dialog open={messagesOpen} onOpenChange={setMessagesOpen} title="引擎推送的会话消息">
      <div className="wf-messages">{run?.messages.map(message => <article key={message.id}><header><BellRing size={14}/><strong>引擎 → {message.recipient === "main" ? "主 Agent" : "原子 Agent"}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time></header><p>{message.text}</p><small>{({ queued: "等待送达", delivering: "发送中", delivered: "已送达", resolved: "已补交", uncertain: "需要核对" } as Record<string, string>)[message.status]}</small></article>)}</div>
    </Dialog>
  </div>;
}
