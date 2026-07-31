import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const renderer = join(import.meta.dirname, "../src/renderer/src");

test("renderer business stores use Core Daemon instead of seeded data", () => {
  const expectations = [
    ["stores/projects.ts", ["project.list", "project.add", "project.scan", "project.remove", "project.upsert"]],
    ["stores/agents.ts", ["agent.list", "agent.upsert", "provider.detect", "credential.status", "credential.set"]],
    ["stores/teams.ts", ["team.list", "team.upsert", "team.remove"]],
    ["lib/orchestration-runtime.ts", [
      "session.list",
      "session.get",
      "orchestration.start",
      "orchestration.resolveMerge",
      "artifact.list",
      "verification.list",
      "event.replay"
    ]],
    ["features/settings/RuntimeOperationsCard.tsx", [
      "metrics.get",
      "recovery.list",
      "orchestration.recover",
      "audit.list",
      "policy.list",
      "approval.list",
      "diagnostics.export"
    ]]
  ];
  for (const [relativePath, methods] of expectations) {
    const source = readFileSync(join(renderer, relativePath), "utf8");
    for (const method of methods) assert.match(source, new RegExp(`['\"]${method.replace(".", "\\.")}['\"]`));
    assert.doesNotMatch(source, /mock-data|mock-run|seedProjects|seedInstances|seedTeams|seedSessionData/);
  }
  assert.equal(existsSync(join(renderer, "lib/mock-data.ts")), false);
  assert.equal(existsSync(join(renderer, "lib/mock-run.ts")), false);
  const timeline = readFileSync(join(renderer, "features/timeline/Timeline.tsx"), "utf8");
  assert.match(timeline, /"once", "run", "task", "project", "global"/);
  assert.match(timeline, /resolveWorkbenchApproval\(event\.sessionId, approval\.id, true, scope\)/);
});

test("project workspace mode lets users choose direct editing or Git isolation", () => {
  const projectStore = readFileSync(join(renderer, "stores/projects.ts"), "utf8");
  const modeCard = readFileSync(join(renderer, "features/projects/WorkspaceModeCard.tsx"), "utf8");
  const projectDetail = readFileSync(join(renderer, "features/projects/ProjectDetailPage.tsx"), "utf8");
  const mappers = readFileSync(join(renderer, "lib/core-mappers.ts"), "utf8");
  assert.match(projectStore, /setWorkspaceMode/);
  assert.match(projectStore, /"project\.upsert"/);
  assert.match(modeCard, /value: "direct"/);
  assert.match(modeCard, /value: "git_isolated"/);
  assert.match(projectDetail, /<WorkspaceModeCard project=\{project\}/);
  assert.match(mappers, /project\.workspaceMode \?\? "direct"/);
});

test("session model control keeps compact effort slider and advanced details mutually exclusive", () => {
  const source = readFileSync(join(renderer, "features/sessions/SessionModelControl.tsx"), "utf8");
  assert.match(source, /!advancedDetails/);
  assert.match(source, /session-effort-range/);
  assert.match(source, /setAdvancedDetails\(true\)/);
  assert.match(source, /setAdvancedDetails\(false\)/);
  assert.match(source, /sessions\.composer\.speed/);
  assert.match(source, /configureWorkbenchSession\(sessionId, \{ serviceTier:/);
});

test("CLI instances own connectivity while team members own delegated model defaults", () => {
  const agentEditor = readFileSync(join(renderer, "features/agents/AgentEditorDialog.tsx"), "utf8");
  const memberEditor = readFileSync(join(renderer, "features/teams/MemberEditorDialog.tsx"), "utf8");
  const newSession = readFileSync(join(renderer, "features/sessions/NewSessionDialog.tsx"), "utf8");
  const modelControl = readFileSync(join(renderer, "features/sessions/SessionModelControl.tsx"), "utf8");
  assert.doesNotMatch(agentEditor, /modelCatalogs|ComboboxInput|form\.reasoningEffort/);
  assert.match(memberEditor, /modelCatalogs\[selectedInstance\.id\]/);
  assert.match(memberEditor, /model: form\.model\.trim\(\) \|\| undefined/);
  assert.match(memberEditor, /reasoningEffort: form\.reasoningEffort\.trim\(\) \|\| undefined/);
  assert.doesNotMatch(newSession, /selectedInstance\.(model|reasoningEffort)/);
  assert.match(modelControl, /catalogs\[instance\.id\]/);
  assert.doesNotMatch(modelControl, /instance\.(model|reasoningEffort)/);
});

test("chat workbench exposes live provider deltas, tools, and reasoning state", () => {
  const runtime = readFileSync(join(renderer, "lib/orchestration-runtime.ts"), "utf8");
  for (const eventType of [
    "agent.status",
    "agent.message_delta",
    "agent.thinking_delta",
    "agent.thinking_summary",
    "tool.started",
    "tool.finished",
    "usage.updated",
    "run.completed"
  ]) {
    assert.match(runtime, new RegExp(`event\\.type === ["']${eventType.replace(".", "\\.")}["']`));
  }

  const timeline = readFileSync(join(renderer, "features/timeline/Timeline.tsx"), "utf8");
  assert.match(timeline, /function ReasoningCard/);
  assert.match(timeline, /function ReasoningCard[\s\S]*const \[open, setOpen\] = useState\(false\)/);
  assert.doesNotMatch(timeline, /if \(!event\.data\.streaming\) setOpen\(false\)/);
  assert.match(timeline, /function ToolActivityCard/);
  assert.match(timeline, /<ToolFileDiffView/);
  assert.match(timeline, /toolInputFileDiff\(toolName, input\)/);
  assert.match(timeline, /agenthub-artifact:\/\/local\/\?path=/);
  assert.match(timeline, /推理中/);
  assert.match(timeline, /推理完成/);
  assert.doesNotMatch(runtime, /event\.type === ["']run\.started["']\) return \{ kind: ["']activity["']/);
  assert.match(runtime, /mergeStandaloneEvents\(sessionId, update\.events\)/);
  assert.match(runtime, /latestReasoning\.set\(runId, key\)/);
  assert.match(runtime, /reasoningGeneration\.get\(runId\)/);
  assert.match(runtime, /event\.type === "tool\.started"\) reasoningGeneration\.set/);
  assert.match(runtime, /runningReasoningRows/);
  assert.match(runtime, /finishLatestReasoning\(runId\)/);
  assert.match(runtime, /if \(!event\.payload\.text\.trim\(\)\) continue/);
  assert.match(runtime, /data: \{ \.\.\.current, text: current\.text \|\| event\.payload\.text, streaming: false \}/);
  assert.match(runtime, /retryableCommands/);
  assert.match(runtime, /normalizeCommandForRetry/);
  assert.match(runtime, /event\.type === "run\.failed" \? "failed"/);
  assert.match(runtime, /status: terminalStatus/);
  assert.match(runtime, /_replaceContextUsage\(sessionId, latestContextUsage\(events\)\)/);

  const contextUsage = readFileSync(join(renderer, "features/sessions/ContextUsageIndicator.tsx"), "utf8");
  assert.match(contextUsage, /state\.contextUsage\[sessionId\]/);
  assert.doesNotMatch(contextUsage, /state\.events\[sessionId\]/);

  const composer = readFileSync(join(renderer, "features/sessions/Composer.tsx"), "utf8");
  assert.match(composer, /rounded-2xl/);
  assert.match(composer, /<SessionModelControl/);
  assert.match(composer, /<ContextUsageIndicator/);
  assert.match(composer, /<ArrowUp/);
  assert.match(composer, /shrink-0 border-t/);

  const sessionsPage = readFileSync(join(renderer, "features/sessions/SessionsPage.tsx"), "utf8");
  const workbench = readFileSync(join(renderer, "features/sessions/SessionWorkbench.tsx"), "utf8");
  assert.match(sessionsPage, /h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden/);
  assert.match(workbench, /relative flex shrink-0 items-center/);

  assert.equal(existsSync(join(renderer, "features/sessions/RunActivityIndicator.tsx")), true);
  const activityIndicator = readFileSync(join(renderer, "features/sessions/RunActivityIndicator.tsx"), "utf8");
  assert.match(activityIndicator, /latest && latest\.data\.kind !== "activity"/);
});

test("chat timeline groups consecutive tool work while preserving full details", () => {
  const grouping = readFileSync(join(renderer, "lib/tool-timeline-groups.ts"), "utf8");
  const runtime = readFileSync(join(renderer, "lib/orchestration-runtime.ts"), "utf8");
  const timeline = readFileSync(join(renderer, "features/timeline/Timeline.tsx"), "utf8");
  const styles = readFileSync(join(renderer, "styles/global.css"), "utf8");

  assert.match(grouping, /GROUPABLE_KINDS.*reasoning.*tool_activity.*command.*file_change.*verification/s);
  assert.match(grouping, /stepCount < 2/);
  assert.match(grouping, /stepCount,/);
  assert.match(grouping, /items: pending/);
  assert.match(grouping, /running: pending\.some\(isRunningStep\)/);
  assert.match(grouping, /event\.data\.kind === "reasoning"[\s\S]*event\.data\.streaming/);
  assert.match(runtime, /groupToolTimeline/);
  assert.match(timeline, /function ToolGroupCard/);
  assert.match(timeline, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(timeline, /const preview = items\.at\(-1\)/);
  assert.match(timeline, /latestReasoningSummary\(preview\.data\.text\)/);
  assert.match(timeline, /function LatestActivityLabel/);
  assert.match(timeline, /element\.scrollLeft = followTail \? element\.scrollWidth : 0/);
  assert.match(timeline, /followTail=\{preview\.data\.kind === "reasoning"\}/);
  assert.match(timeline, /hasSupportingSteps/);
  assert.match(timeline, /处理了 \$\{stepCount\} 个步骤/);
  assert.match(timeline, /运行了/);
  assert.match(timeline, /items\.map/);
  assert.match(timeline, /item\.data\.kind === "file_change"/);
  assert.match(timeline, /item\.data\.kind === "verification"/);
  assert.match(styles, /@keyframes beam-slide[\s\S]*from[\s\S]*translate3d\(-130%, 0, 0\)[\s\S]*to[\s\S]*translate3d\(340%, 0, 0\)/);
  assert.match(styles, /animation: beam-slide 2\.8s linear infinite/);
  assert.doesNotMatch(styles, /@keyframes beam-slide[\s\S]*60%,[\s\S]*100%/);
  assert.match(timeline, /"run-border-active border-accent\/30/);
  assert.match(timeline, /cn\("run-beam", flowRunning && "run-beam-active"\)/);
  assert.match(timeline, /const streamingReasoning = items\.some/);
  assert.match(timeline, /const flowRunning = running \|\| streamingReasoning/);
  assert.match(styles, /\.run-border\.run-border-active::before[\s\S]*opacity: 0\.82/);
  assert.match(styles, /\.run-beam::after[\s\S]*animation-delay: -1\.4s/);
  assert.match(styles, /var\(--accent\) 0deg[\s\S]*var\(--info\) 90deg[\s\S]*var\(--accent-2\) 180deg[\s\S]*var\(--accent\) 360deg/);
});

test("file change cards accept provider diffs and hydrated run diff artifacts", () => {
  const runtime = readFileSync(join(renderer, "lib/orchestration-runtime.ts"), "utf8");
  assert.match(runtime, /artifacts\.flatMap\(parseDiffArtifact\)/);
  assert.match(runtime, /additions: event\.payload\.additions \?\? 0/);
  assert.match(runtime, /deletions: event\.payload\.deletions \?\? 0/);
  assert.match(runtime, /diff: event\.payload\.diff/);
});

test("main timeline compacts delegation internals into one task card", () => {
  const policy = readFileSync(join(renderer, "lib/orchestration-timeline-policy.ts"), "utf8");
  assert.match(policy, /message\.kind === "planner_decision" \|\| message\.kind === "delegation"/);
  assert.match(policy, /event\.data\.kind === "planner_decision" \|\| event\.data\.kind === "handoff"/);
  assert.match(policy, /taskRows\.get\(event\.data\.taskId\)/);
  assert.match(policy, /event\.data\.run\.status === "running"/);
});

test("delegated child work keeps the orchestration visibly running until stopped or completed", () => {
  const page = readFileSync(join(renderer, "features/sessions/SessionWorkbench.tsx"), "utf8");
  const indicator = readFileSync(join(renderer, "features/sessions/RunActivityIndicator.tsx"), "utf8");
  const sessionList = readFileSync(join(renderer, "features/sessions/SessionListPanel.tsx"), "utf8");
  const agentPanel = readFileSync(join(renderer, "features/sessions/AgentPanel.tsx"), "utf8");
  const lifecycle = readFileSync(join(renderer, "lib/session-lifecycle.ts"), "utf8");
  const runtime = readFileSync(join(renderer, "lib/orchestration-runtime.ts"), "utf8");
  const store = readFileSync(join(renderer, "stores/sessions.ts"), "utf8");
  assert.match(page, /state\.foreground\[sessionId\]/);
  assert.match(page, /state\.running\[sessionId\]/);
  assert.match(page, /waitingForDelegates = orchestrationRunning && !foregroundRunning && hasRunningDelegatedTask\(tasks\)/);
  assert.match(page, /workbenchRunning = foregroundRunning \|\| waitingForDelegates \|\| waitingForApproval \|\| verifyingInBackground/);
  assert.doesNotMatch(page, /workbenchRunning = foregroundRunning \|\| orchestrationRunning/);
  assert.match(page, /running=\{workbenchRunning\}/);
  assert.match(page, /RunActivityIndicator lifecycle=\{visibleLifecycle\}/);
  assert.match(indicator, /子 Agent 正在运行，完成后会通知主 Agent/);
  assert.match(sessionList, /visibleSessionStatus\(session\.status, orchestrationLifecycle\)/);
  assert.match(agentPanel, /visibleSessionStatus\(session\.status, orchestrationLifecycle\)/);
  assert.match(lifecycle, /orchestration\?\.status === "running"/);
  assert.match(lifecycle, /RUNNING_DELEGATED_TASK_STATUSES/);
  assert.match(lifecycle, /"queued"[\s\S]*"running"[\s\S]*"verifying"/);
  assert.match(lifecycle, /hasRunningDelegatedTask/);
  assert.match(runtime, /session\.projectRunId && !session\.parentSessionId/);
  assert.match(runtime, /"orchestration\.cancel"/);
  assert.match(runtime, /activeProjectRunId === session\.projectRunId/);
  assert.match(runtime, /status: session\.status/);
  assert.match(runtime, /"session\.send"/);
  assert.match(runtime, /_setForeground\(session\.id, activeRun/);
  assert.match(runtime, /const latestRun = runs\.find\(\(run\) => run\.sessionId === session\.id\)/);
  assert.match(runtime, /latestRun && shouldPollAgentRun\(latestRun\)/);
  assert.match(store, /foreground: Record<string, RunLifecycle \| undefined>/);
  const runningSetter = store.slice(store.indexOf("_setRunning:"), store.indexOf("_setForeground:"));
  assert.doesNotMatch(runningSetter, /sessions:/);
  assert.match(runtime, /const projectRun = await hydrateProjectRun\(projectRunId\)/);
  assert.doesNotMatch(runtime, /await hydrateProjectRun\(projectRunId\);\s*const \{ projectRun \} = await requestCore/);
});

test("a foreground Agent turn keeps syncing after its orchestration enters review", () => {
  const runtime = readFileSync(join(renderer, "lib/orchestration-runtime.ts"), "utf8");
  assert.match(runtime, /function shouldPollProjectRun\(projectRun: ProjectRun\)/);
  assert.match(runtime, /activeAgentRunIds\[mainSessionId\]/);
  assert.match(runtime, /Boolean\(activeAgentRunId\) \|\| shouldPoll\(projectRun\)/);
  assert.match(runtime, /if \(!shouldPollProjectRun\(projectRun\)/);
  assert.match(runtime, /if \(shouldPollProjectRun\(hydrated\)\) schedulePoll/);
});

test("generated images use a restricted streaming protocol instead of base64 IPC", () => {
  const main = join(import.meta.dirname, "../src/main");
  const protocol = readFileSync(join(main, "artifact-protocol.ts"), "utf8");
  assert.match(protocol, /\.codex", "generated_images/);
  assert.match(protocol, /isWithin\(root, candidate\)/);
  assert.match(protocol, /net\.fetch\(pathToFileURL\(candidate\)\.toString\(\)\)/);
  assert.doesNotMatch(protocol, /readFileSync/);
});

test("composer exposes provider slash commands and structured result selection", () => {
  const composer = readFileSync(join(renderer, "features/sessions/Composer.tsx"), "utf8");
  const hook = readFileSync(join(renderer, "features/sessions/slash-commands/useSlashCommands.ts"), "utf8");
  const menu = readFileSync(join(renderer, "features/sessions/slash-commands/SlashCommandMenu.tsx"), "utf8");
  const result = readFileSync(join(renderer, "features/sessions/slash-commands/CommandResultDialog.tsx"), "utf8");
  assert.match(composer, /slashCommandQuery/);
  assert.match(composer, /<SlashCommandMenu/);
  assert.match(composer, /<CommandResultDialog/);
  assert.match(hook, /"slashCommand\.list"/);
  assert.match(hook, /"slashCommand\.execute"/);
  assert.match(hook, /"slashCommand\.continue"/);
  assert.match(menu, /role="listbox"/);
  assert.match(result, /selection\.mode === "single"/);
  assert.match(result, /selectedOptionIds/);
});

test("chat messages expose copy and edit actions and the composer imports attachments", () => {
  const timeline = readFileSync(join(renderer, "features/timeline/Timeline.tsx"), "utf8");
  const composer = readFileSync(join(renderer, "features/sessions/Composer.tsx"), "utf8");
  const preload = readFileSync(join(import.meta.dirname, "../src/preload/index.ts"), "utf8");
  const main = readFileSync(join(import.meta.dirname, "../src/main/index.ts"), "utf8");
  assert.match(timeline, /navigator\.clipboard\.writeText/);
  assert.match(timeline, /onEditMessage/);
  assert.match(timeline, /<Copy/);
  assert.match(timeline, /<Pencil/);
  assert.match(composer, /onPaste=\{onPaste\}/);
  assert.match(composer, /dialog\.pickFiles/);
  assert.match(composer, /attachments\.importClipboard/);
  assert.match(preload, /webUtils\.getPathForFile/);
  assert.match(main, /dialog:pick-files/);
  assert.match(main, /attachment:import-clipboard/);
});
