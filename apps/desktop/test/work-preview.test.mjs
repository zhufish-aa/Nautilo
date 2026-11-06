import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const libDir = new URL("../src/renderer/src/lib/", import.meta.url);
const rendererDir = new URL("../src/renderer/src/", import.meta.url);

const moduleCache = new Map();
const moduleUrlCache = new Map();

/**
 * Transpiles a lib module standalone and loads it as a data: URL. Relative
 * imports between lib modules are rewritten to inlined data: URLs so the
 * single-file test harness keeps working across module boundaries.
 */
async function loadLibModule(name) {
  const cached = moduleCache.get(name);
  if (cached) return cached;
  const promise = (async () => {
    const source = await readFile(new URL(`${name}.ts`, libDir), "utf8");
    let transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText;
    for (const match of transpiled.matchAll(/from\s+["']\.\/([\w-]+)["']/g)) {
      await loadLibModule(match[1]); // loads the dependency and registers its data: URL
      const depUrl = moduleUrlCache.get(match[1]);
      if (depUrl) transpiled = transpiled.replace(match[0], `from ${JSON.stringify(depUrl)}`);
    }
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`;
    moduleUrlCache.set(name, url);
    return import(url);
  })();
  moduleCache.set(name, promise);
  return promise;
}

const loadPreview = () => loadLibModule("work-preview");
const loadFileReferences = () => loadLibModule("file-references");

async function readRendererSource(relativePath) {
  return readFile(new URL(relativePath, rendererDir), "utf8");
}

test("previewKind maps office extensions to their renderers", async () => {
  const { previewKind } = await loadPreview();
  assert.equal(previewKind("report.docx"), "docx");
  assert.equal(previewKind("data.XLSX"), "xlsx");
  assert.equal(previewKind("legacy.xls"), "xlsx");
  assert.equal(previewKind("deck.pptx"), "pptx");
  assert.equal(previewKind("slides.pdf"), "pdf");
  assert.equal(previewKind("notes.md"), "markdown");
  assert.equal(previewKind("page.html"), "html");
  assert.equal(previewKind("table.csv"), "csv");
  assert.equal(previewKind("chart.png"), "image");
  assert.equal(previewKind("output.txt"), "text");
  assert.equal(previewKind("archive.zip"), "binary");
});

test("code files (incl. .py) resolve to the text preview", async () => {
  const { previewKind, resolvePreview } = await loadPreview();
  assert.equal(previewKind("deepseek_v4_flash_deck.py"), "text");
  assert.equal(previewKind("src/main.ts"), "text");
  assert.equal(previewKind("README.md"), "markdown");
  assert.equal(resolvePreview("script.unknown", "text/plain"), "text");
});

test("legacy .doc/.ppt resolve to the explicit legacy-office state", async () => {
  const { previewKind } = await loadPreview();
  assert.equal(previewKind("old.doc"), "legacy-office");
  assert.equal(previewKind("older.PPT"), "legacy-office");
});

test("resolvePreview falls back to MIME when the extension is unknown", async () => {
  const { resolvePreview } = await loadPreview();
  assert.equal(resolvePreview("noext", "application/pdf"), "pdf");
  assert.equal(resolvePreview("blob.bin", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(resolvePreview("blob.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "xlsx");
  assert.equal(resolvePreview("blob.bin", "application/vnd.ms-excel"), "xlsx");
  assert.equal(resolvePreview("blob.bin", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), "pptx");
  assert.equal(resolvePreview("blob.bin", "application/msword"), "legacy-office");
  assert.equal(resolvePreview("blob.bin", "application/vnd.ms-powerpoint"), "legacy-office");
  assert.equal(resolvePreview("image.unknown", "image/webp"), "image");
  assert.equal(resolvePreview("file.bin", "application/octet-stream"), "binary");
  assert.equal(resolvePreview("file.bin"), "binary");
});

test("resolvePreview is case-insensitive and extension wins over MIME", async () => {
  const { resolvePreview } = await loadPreview();
  assert.equal(resolvePreview("REPORT.PDF", "APPLICATION/PDF"), "pdf");
  // A misleading MIME type must not reroute a known extension.
  assert.equal(resolvePreview("deck.pptx", "application/pdf"), "pptx");
});

test("registry entries all declare extensions or MIME types", async () => {
  const { PREVIEW_REGISTRY } = await loadPreview();
  assert.ok(PREVIEW_REGISTRY.length >= 8);
  for (const def of PREVIEW_REGISTRY) {
    assert.ok(def.extensions.length > 0 || def.mimeTypes.length > 0, def.kind);
    for (const ext of def.extensions) assert.equal(ext, ext.toLowerCase());
    for (const mime of def.mimeTypes) assert.equal(mime, mime.toLowerCase());
  }
});

test("classifyPreviewError maps parser failures to user-facing reasons", async () => {
  const { classifyPreviewError } = await loadPreview();
  assert.equal(classifyPreviewError("PasswordException"), "encrypted");
  assert.equal(classifyPreviewError("InvalidPDFException"), "corrupted");
  assert.equal(classifyPreviewError("ZipError"), "corrupted");
  assert.equal(classifyPreviewError("ParseError"), "corrupted");
  assert.equal(classifyPreviewError("ModuleLoadError"), "engine-load");
  assert.equal(classifyPreviewError("SomethingElse"), "unknown");
});

test("LRU cache evicts the oldest entry and refreshes recency on hit", async () => {
  const { createLruCache } = await loadPreview();
  const cache = createLruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // a is now most-recent
  cache.set("c", 3); // evicts b, not a
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("previewCacheKey pins project, path and file version", async () => {
  const { previewCacheKey } = await loadPreview();
  assert.equal(previewCacheKey("p1", "out/a.docx", "2026-01-01"), "p1:out/a.docx:2026-01-01");
  assert.notEqual(
    previewCacheKey("p1", "out/a.docx", "v1"),
    previewCacheKey("p1", "out/a.docx", "v2")
  );
});

test("planVisibleRange chunks large sheets and reports truncation", async () => {
  const { planVisibleRange } = await loadPreview();
  assert.deepEqual(planVisibleRange(0, 0, 200), { start: 0, end: 0, truncated: false });
  assert.deepEqual(planVisibleRange(50, 0, 200), { start: 0, end: 50, truncated: false });
  assert.deepEqual(planVisibleRange(1000, 0, 200), { start: 0, end: 200, truncated: true });
  assert.deepEqual(planVisibleRange(1000, 400, 200), { start: 0, end: 400, truncated: true });
  assert.deepEqual(planVisibleRange(300, 400, 200), { start: 0, end: 300, truncated: false });
});

test("mergeDeliverableTabs prepends a chat-requested file exactly once", async () => {
  const { mergeDeliverableTabs } = await loadPreview();
  const deliverables = ["outputs/a.py", "outputs/b.md"];
  // Not among deliverables → becomes the first tab, order preserved.
  assert.deepEqual(mergeDeliverableTabs(deliverables, "C:\\work\\deck.pptx"), ["C:\\work\\deck.pptx", "outputs/a.py", "outputs/b.md"]);
  // Already present (case/separator-insensitive) → no duplicate tab.
  assert.deepEqual(mergeDeliverableTabs(deliverables, "outputs\\A.PY"), deliverables);
  assert.deepEqual(mergeDeliverableTabs(deliverables, "outputs/a.py"), deliverables);
  assert.deepEqual(mergeDeliverableTabs(deliverables, undefined), deliverables);
});

test("resolveRequestedTab prefers the existing deliverable's exact path form", async () => {
  const { resolveRequestedTab } = await loadPreview();
  const deliverables = ["outputs/Deck.pptx", "outputs/a.py"];
  assert.equal(resolveRequestedTab(deliverables, "outputs\\deck.pptx"), "outputs/Deck.pptx");
  assert.equal(resolveRequestedTab(deliverables, "C:\\work\\new.pdf"), "C:\\work\\new.pdf");
});

test("classifyLocalHref routes local paths to the preview and keeps externals", async () => {
  const { classifyLocalHref } = await loadFileReferences();
  // Absolute Windows paths, UNC, file:// URLs and relative project paths.
  assert.deepEqual(classifyLocalHref("C:\\work\\deck.pptx"), { kind: "local", path: "C:\\work\\deck.pptx" });
  assert.deepEqual(classifyLocalHref("C:/work/deck.pptx"), { kind: "local", path: "C:/work/deck.pptx" });
  assert.deepEqual(classifyLocalHref("\\\\server\\share\\deck.pptx"), { kind: "local", path: "\\\\server\\share\\deck.pptx" });
  assert.deepEqual(classifyLocalHref("file:///C:/work/deck.pptx"), { kind: "local", path: "C:/work/deck.pptx" });
  assert.deepEqual(classifyLocalHref("outputs/deck.pptx"), { kind: "local", path: "outputs/deck.pptx" });
  // URL-encoded spaces decode safely; malformed encoding never throws.
  assert.deepEqual(classifyLocalHref("C:/work/my%20deck%20v2.pptx"), { kind: "local", path: "C:/work/my deck v2.pptx" });
  assert.deepEqual(classifyLocalHref("outputs/中文%20目录/deck.pptx"), { kind: "local", path: "outputs/中文 目录/deck.pptx" });
  assert.equal(classifyLocalHref("outputs/100%zz.pptx").kind, "local");
  // External schemes keep the target=_blank behavior.
  assert.equal(classifyLocalHref("https://example.com/deck.pptx").kind, "external");
  assert.equal(classifyLocalHref("http://example.com").kind, "external");
  assert.equal(classifyLocalHref("mailto:a@b.c").kind, "external");
  assert.equal(classifyLocalHref("data:text/plain;base64,QQ==").kind, "external");
  assert.equal(classifyLocalHref("blob:https://x/y").kind, "external");
  // Anchors, empty and junk are inert.
  assert.equal(classifyLocalHref("#section").kind, "none");
  assert.equal(classifyLocalHref("").kind, "none");
  assert.equal(classifyLocalHref(undefined).kind, "none");
  assert.equal(classifyLocalHref("just some words").kind, "none");
});

test("raw Windows Markdown image links survive ReactMarkdown URL sanitizing", async () => {
  const { normalizeMarkdownLocalLinks, classifyLocalHref, parseFileReference, isImagePath } = await loadFileReferences();
  const path = String.raw`C:\Users\admin\Documents\Codex\2026-07-20\new-chat\output\imagegen\bunny-drinking-water.png`;
  const normalized = normalizeMarkdownLocalLinks(`[preview](${path})`);
  const href = normalized.slice(normalized.indexOf("(") + 1, -1);

  assert.match(normalized, /\?agenthub-local-path=C%3A%5CUsers%5Cadmin/);
  assert.deepEqual(classifyLocalHref(href), { kind: "local", path });
  assert.deepEqual(parseFileReference(path), { path, line: undefined });
  assert.equal(isImagePath(path), true);
});

test("resolveFileOpenTarget: Work routes previewables to the pane, legacy stays external", async () => {
  const { resolveFileOpenTarget, isLegacyOfficePath } = await loadFileReferences();
  // Work mode (handler present): PDF/Office/text/images → local preview.
  for (const path of ["deck.pptx", "doc.docx", "sheet.xlsx", "old.xls", "slides.pdf", "script.py", "photo.png"]) {
    assert.equal(resolveFileOpenTarget(path, true), "local-preview", path);
  }
  // Legacy Office never previews inline, even in Work mode.
  assert.equal(resolveFileOpenTarget("old.doc", true), "external");
  assert.equal(resolveFileOpenTarget("older.ppt", true), "external");
  assert.ok(isLegacyOfficePath("old.doc") && isLegacyOfficePath("x.ppt") && !isLegacyOfficePath("x.pptx"));
  // Code mode (no handler): Office → system app, everything else → drawer.
  assert.equal(resolveFileOpenTarget("deck.pptx", false), "external");
  assert.equal(resolveFileOpenTarget("doc.docx", false), "external");
  assert.equal(resolveFileOpenTarget("script.py", false), "drawer");
  assert.equal(resolveFileOpenTarget("notes.md", false), "drawer");
});

test("PPTX links preserve local routing across absolute, relative and encoded paths", async () => {
  const { classifyLocalHref, resolveFileOpenTarget } = await loadFileReferences();
  const cases = [
    ["C:/work/deck.pptx", "C:/work/deck.pptx"],
    ["outputs/deck.pptx", "outputs/deck.pptx"],
    ["outputs/my%20deck.pptx", "outputs/my deck.pptx"]
  ];
  for (const [href, expectedPath] of cases) {
    const classification = classifyLocalHref(href);
    assert.deepEqual(classification, { kind: "local", path: expectedPath }, href);
    assert.equal(resolveFileOpenTarget(classification.path, true), "local-preview", href);
  }
  assert.equal(classifyLocalHref("https://example.com/outputs/deck.pptx").kind, "external");
});

test("unified workspace click wiring reaches the preview pane and office renderer", async () => {
  const [workPage, workspacePreview, sessionWorkbench, timeline, markdown, fileRefChip, previewPane, documentPreview] = await Promise.all([
    readRendererSource("features/sessions/SessionsPage.tsx"),
    readRendererSource("features/sessions/WorkspacePreview.tsx"),
    readRendererSource("features/sessions/SessionWorkbench.tsx"),
    readRendererSource("features/timeline/Timeline.tsx"),
    readRendererSource("features/timeline/MarkdownContent.tsx"),
    readRendererSource("features/timeline/FileRefChip.tsx"),
    readRendererSource("features/work/WorkPreviewPane.tsx"),
    readRendererSource("features/work/preview/DocumentPreview.tsx")
  ]);

  assert.match(workPage, /setPreview\(\{ sessionId: session.id, path \}\)/);
  assert.match(workPage, /onOpenLocalFile=\{openPreview\}/);
  assert.match(workPage, /requestedWorkspaceFile\(preview, session\?\.id\)/);
  assert.match(workspacePreview, /requestedPath=\{path\}/);

  assert.match(sessionWorkbench, /timelineActions = \{[^}]*onOpenLocalFile \}/);
  assert.match(sessionWorkbench, /ConversationTurnView[^>]*\{\.\.\.timelineActions\}/);
  assert.match(timeline, /<MarkdownContent[\s\S]*onOpenLocalFile=\{onOpenLocalFile\}/);
  assert.match(timeline, /openTimelineFile\(attachment\.path, t, onOpenLocalFile/);
  assert.match(timeline, /openTimelineFile\(path, t, onOpenLocalFile/);
  assert.match(timeline, /openTimelineFile\(file\.path, t, onOpenLocalFile/);
  assert.match(fileRefChip, /resolveFileOpenTarget\(reference\.path, onOpenLocalFile !== undefined\)/);

  assert.match(markdown, /event\.preventDefault\(\)/);
  assert.match(markdown, /event\.stopPropagation\(\)/);
  assert.match(markdown, /popupFileMenu\(path, t\)/);
  assert.match(markdown, /popupImageMenu\(/);
  assert.match(markdown, /target: "_blank"/);

  assert.match(previewPane, /mergeDeliverableTabs\(deliverables, requestedPath\)/);
  assert.match(previewPane, /selected \? resolveRequestedTab\(deliverables, selected\)/);
  assert.match(previewPane, /requestedWorkspaceFile\(selection, sessionId\)/);
  assert.match(previewPane, /setSelection\(\{ sessionId, path: requestedPath \}\);[\s\S]*\}, \[requestedPath, sessionId\]\)/);
  assert.doesNotMatch(previewPane, /\[requestedPath, deliverables\]/);
  assert.match(previewPane, /"artifact\.read"/);
  assert.match(previewPane, /<DocumentPreview/);
  assert.match(documentPreview, /case "pptx":\s*return <PptxPreview/);
});

test("context preview width constraints preserve conversation space and support narrow windows", async () => {
  const { constrainWorkspacePreview } = await loadLibModule("workspace-state");
  assert.equal(constrainWorkspacePreview(900, 1200), 860);
  assert.equal(constrainWorkspacePreview(100, 1200), 300);
  assert.equal(constrainWorkspacePreview(900, 480), 480);
  assert.equal(constrainWorkspacePreview(460, 1200), 460);
});

test("requested files never leak between sessions of either legacy mode", async () => {
  const { requestedWorkspaceFile, resolveWorkspaceSession } = await loadLibModule("workspace-state");
  const sessions = [{ id: "a", mode: "code" }, { id: "b", mode: "work" }];
  assert.equal(resolveWorkspaceSession(sessions, "?session=b", "a"), sessions[1]);
  assert.equal(resolveWorkspaceSession(sessions, "?session=a", "b"), sessions[0]);
  assert.equal(resolveWorkspaceSession(sessions, "?new=1", "b"), undefined);
  assert.equal(resolveWorkspaceSession(sessions, "?session=missing", "b"), undefined);
  assert.equal(resolveWorkspaceSession(sessions, "", "b"), sessions[1]);
  assert.equal(requestedWorkspaceFile({ sessionId: "a", path: "report.pdf" }, "b"), undefined);
  assert.equal(requestedWorkspaceFile({ sessionId: "a", path: "report.pdf" }, "a"), "report.pdf");
  assert.deepEqual(sessions, [{ id: "a", mode: "code" }, { id: "b", mode: "work" }]);
});

test("Office/PDF timeline clicks are resolver-routed; external fallback stays localized", async () => {
  const [timeline, fileRefChip, previewPane] = await Promise.all([
    readRendererSource("features/timeline/Timeline.tsx"),
    readRendererSource("features/timeline/FileRefChip.tsx"),
    readRendererSource("features/work/WorkPreviewPane.tsx")
  ]);
  const helperStart = timeline.indexOf("function openTimelineFile");
  const helperEnd = timeline.indexOf("function CardShell", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "timeline resolver helper should exist");
  const helper = timeline.slice(helperStart, helperEnd);
  assert.match(helper, /resolveFileOpenTarget\(path, true\)/);
  assert.match(helper, /onOpenLocalFile\(path\)/);
  assert.equal((timeline.slice(0, helperStart) + timeline.slice(helperEnd)).match(/openFileWithToast\(/g)?.length ?? 0, 0);
  assert.match(fileRefChip, /resolveFileOpenTarget\(reference\.path, onOpenLocalFile !== undefined\)/);
  assert.match(previewPane, /status === "error"/);
  assert.match(previewPane, /status === "unsupported"/);
  assert.match(previewPane, /openFileWithToast\(activePath, t\)/);
});

test("nested tool-group file_change rows retain the Work local-file callback", async () => {
  const timeline = await readRendererSource("features/timeline/Timeline.tsx");
  const eventViewStart = timeline.indexOf("function TimelineEventViewImpl");
  assert.ok(eventViewStart >= 0, "TimelineEventViewImpl should exist");
  const eventView = timeline.slice(eventViewStart);
  const groupStart = eventView.indexOf('case "tool_group":');
  const groupEnd = eventView.indexOf('case "usage":', groupStart);
  const group = eventView.slice(groupStart, groupEnd);
  assert.match(group, /data\.items\.map/);
  assert.match(group, /<TimelineEventView[^>]*onOpenLocalFile=\{onOpenLocalFile\}/);
  assert.match(eventView, /<FileChangeCard[^>]*onOpenLocalFile=\{onOpenLocalFile\}/);

});

test("formatFileSize picks sensible units", async () => {
  const { formatFileSize } = await loadPreview();
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(3 * 1024 * 1024), "3.0 MB");
});

test("base64 helpers round-trip utf-8 text", async () => {
  const { base64ToText, base64ToBytes } = await loadPreview();
  const encoded = Buffer.from("# 标题", "utf8").toString("base64");
  assert.equal(base64ToText(encoded), "# 标题");
  assert.deepEqual([...base64ToBytes("QQ==")], [65]);
});
