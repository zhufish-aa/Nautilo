import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadTypeScript(relative, replace = (value) => value) {
  const source = replace(await readFile(new URL(relative, import.meta.url), "utf8"));
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(output)}`);
}

test("task DAG supports long chains without the previous 16-stage cutoff", async () => {
  const { layoutDag } = await loadTypeScript("../tasks/task-layout.ts");
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    dependencies: index ? [String(index - 1)] : []
  }));
  const positions = layoutDag(tasks);
  assert.equal(positions.length, 100);
  assert.deepEqual(
    positions.map((position) => position.level),
    tasks.map((_, index) => index)
  );
});

test("task DAG tolerates missing, duplicate, self and cyclic dependencies", async () => {
  const { layoutDag } = await loadTypeScript("../tasks/task-layout.ts");
  const positions = layoutDag([
    { id: "a", dependencies: ["missing", "a"] },
    { id: "b", dependencies: ["a", "a"] },
    { id: "c", dependencies: ["d"] },
    { id: "d", dependencies: ["c"] }
  ]);
  assert.deepEqual(
    positions.map((position) => position.level),
    [0, 1, 0, 0]
  );
  assert(positions.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.equal(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size, 4);
});

test("task DAG centers branch parents and remains deterministic", async () => {
  const { layoutDag } = await loadTypeScript("../tasks/task-layout.ts");
  const tasks = [
    { id: "a", dependencies: [] },
    { id: "b", dependencies: ["a"] },
    { id: "c", dependencies: ["a"] },
    { id: "d", dependencies: ["b", "c"] }
  ];
  const positions = layoutDag(tasks);
  assert.equal(positions[0].y, (positions[1].y + positions[2].y) / 2);
  assert.equal(positions[3].y, positions[0].y);
  assert.deepEqual(layoutDag(tasks), positions);
  assert.deepEqual(layoutDag([]), []);
});

async function mutationHarness() {
  return loadTypeScript("../teams/team-mutations.ts", (source) =>
    source.replace(
      'import { useTeamsStore } from "../../stores/teams";',
      `
    let state = { teams: [] };
    export const useTeamsStore = { getState: () => state, setState: (next) => { state = typeof next === "function" ? { ...state, ...next(state) } : { ...state, ...next }; } };
  `
    )
  );
}

test("team mutation restores only its failed optimistic update", async () => {
  const { persistTeamChange, useTeamsStore } = await mutationHarness();
  const before = { id: "team", name: "Before" };
  const unrelated = { id: "other", name: "Other" };
  useTeamsStore.setState({ teams: [before, unrelated] });
  await assert.rejects(
    persistTeamChange("team", async () => {
      useTeamsStore.setState({ teams: [{ ...before, name: "After" }, unrelated] });
      throw new Error("Persistence failed");
    }),
    /Persistence failed/
  );
  assert.equal(useTeamsStore.getState().teams[0], before);
  assert.equal(useTeamsStore.getState().teams[1], unrelated);
});

test("failed team save cannot roll back a newer mutation", async () => {
  const { persistTeamChange, useTeamsStore } = await mutationHarness();
  const before = { id: "team", name: "Before" };
  const newer = { id: "team", name: "Newer" };
  useTeamsStore.setState({ teams: [before] });
  let reject;
  const pending = persistTeamChange("team", () => {
    useTeamsStore.setState({ teams: [{ ...before, name: "Pending" }] });
    return new Promise((_, fail) => {
      reject = fail;
    });
  });
  useTeamsStore.setState({ teams: [newer] });
  reject(new Error("Failed"));
  await assert.rejects(pending, /Failed/);
  assert.equal(useTeamsStore.getState().teams[0], newer);
});

test("management pages retain low-noise visuals and real conversation destinations", async () => {
  const paths = [
    "ProjectsPage.tsx",
    "ProjectDetailPage.tsx",
    "VerificationTemplatesCard.tsx",
    "WorkspaceModeCard.tsx",
    "../teams/TeamsPage.tsx",
    "../teams/TeamEditorPage.tsx",
    "../tasks/TasksPage.tsx",
    "../runs/RunsPage.tsx"
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /bg-gradient|linearGradient|radial-gradient|shadow-glow|ProgressRing|StaggerGroup/
    );
  }
  for (const path of ["../tasks/TasksPage.tsx", "../runs/RunsPage.tsx"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /sessionLocation\(/);
  }
});

test("member dialog waits for persistence and keeps failures visible", async () => {
  const source = await readFile(
    new URL("../teams/MemberEditorDialog.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /await onSave\(/);
  assert.match(source, /setSaveError\(cause instanceof Error/);
  assert.match(source, /if \(inFlight.current\) return/);
  assert.match(source, /disabled=\{saving\}/);
});
