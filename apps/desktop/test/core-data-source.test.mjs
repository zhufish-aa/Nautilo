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
  assert.match(memberEditor, /reasoningEffort: form\.reasoningEffort \|\| undefined/);
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
  assert.match(timeline, /function ToolActivityCard/);
  assert.match(timeline, /agenthub-artifact:\/\/local\/\?path=/);
  assert.match(timeline, /推理中/);
  assert.match(timeline, /推理完成/);
  assert.doesNotMatch(runtime, /event\.type === ["']run\.started["']\) return \{ kind: ["']activity["']/);
  assert.match(runtime, /mergeStandaloneEvents\(sessionId, update\.events\)/);
  assert.match(runtime, /latestReasoning\.set\(runId, key\)/);
  assert.match(runtime, /data: \{ \.\.\.current, text: event\.payload\.text \|\| current\.text, streaming: false \}/);
  assert.match(runtime, /retryableCommands/);
  assert.match(runtime, /normalizeCommandForRetry/);
  assert.match(runtime, /_replaceContextUsage\(sessionId, latestContextUsage\(events\)\)/);

  const contextUsage = readFileSync(join(renderer, "features/sessions/ContextUsageIndicator.tsx"), "utf8");
  assert.match(contextUsage, /state\.contextUsage\[sessionId\]/);
  assert.doesNotMatch(contextUsage, /state\.events\[sessionId\]/);

  const composer = readFileSync(join(renderer, "features/sessions/Composer.tsx"), "utf8");
  assert.match(composer, /rounded-\[22px\]/);
  assert.match(composer, /<SessionModelControl/);
  assert.match(composer, /<ContextUsageIndicator/);
  assert.match(composer, /<ArrowUp/);

  assert.equal(existsSync(join(renderer, "features/sessions/RunActivityIndicator.tsx")), true);
  const activityIndicator = readFileSync(join(renderer, "features/sessions/RunActivityIndicator.tsx"), "utf8");
  assert.match(activityIndicator, /latest && latest\.data\.kind !== "activity"/);
});

test("main timeline compacts delegation internals into one task card", () => {
  const policy = readFileSync(join(renderer, "lib/orchestration-timeline-policy.ts"), "utf8");
  assert.match(policy, /message\.kind === "planner_decision" \|\| message\.kind === "delegation"/);
  assert.match(policy, /event\.data\.kind === "planner_decision" \|\| event\.data\.kind === "handoff"/);
  assert.match(policy, /taskRows\.get\(event\.data\.taskId\)/);
  assert.match(policy, /event\.data\.run\.status === "running"/);
});

test("delegated child work does not lock the main chat composer", () => {
  const page = readFileSync(join(renderer, "features/sessions/SessionsPage.tsx"), "utf8");
  const runtime = readFileSync(join(renderer, "lib/orchestration-runtime.ts"), "utf8");
  const store = readFileSync(join(renderer, "stores/sessions.ts"), "utf8");
  assert.match(page, /state\.foreground\[sessionId\]/);
  assert.match(page, /running=\{foregroundRunning\}/);
  assert.match(page, /RunActivityIndicator lifecycle=\{foregroundLifecycle\}/);
  assert.match(runtime, /activeProjectRunId === session\.projectRunId/);
  assert.match(runtime, /status: session\.status/);
  assert.match(runtime, /"session\.send"/);
  assert.match(runtime, /_setForeground\(session\.id, activeRun/);
  assert.match(store, /foreground: Record<string, RunLifecycle \| undefined>/);
  const runningSetter = store.slice(store.indexOf("_setRunning:"), store.indexOf("_setForeground:"));
  assert.doesNotMatch(runningSetter, /sessions:/);
  assert.match(runtime, /const projectRun = await hydrateProjectRun\(projectRunId\)/);
  assert.doesNotMatch(runtime, /await hydrateProjectRun\(projectRunId\);\s*const \{ projectRun \} = await requestCore/);
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
