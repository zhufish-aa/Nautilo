import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDaemon } from "../dist/index.js";
import { CapabilityService } from "../dist/application/capability-service.js";
import { BUILTIN_OFFICE_SKILLS, materializeBuiltinSkillResources, seedBuiltinCapabilities } from "../dist/application/builtin-capabilities.js";
import { V2_BODIES, V3_BODIES, V4_BODIES } from "../dist/application/builtin-skill-legacy.js";

function serviceWithStubbedSync(daemon) {
  const syncs = [];
  const stub = { sync: (capability) => syncs.push(capability.id), removeAll: () => {} };
  return { service: new CapabilityService(daemon.database, stub), syncs };
}

test("built-in office skill pack seeds with script-first instructions", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const { service, syncs } = serviceWithStubbedSync(daemon);

  const first = seedBuiltinCapabilities(service);
  assert.equal(first.seeded, BUILTIN_OFFICE_SKILLS.length);
  assert.deepEqual([...syncs].sort(), BUILTIN_OFFICE_SKILLS.map((skill) => skill.id).sort());

  const stored = service.list().filter((capability) => capability.tags.includes("builtin"));
  assert.equal(stored.length, 4);
  for (const capability of stored) {
    assert.equal(capability.kind, "skill");
    assert.equal(capability.enabled, true);
    assert.equal(capability.skill.source, "Built-in");
    assert.ok(capability.tags.includes("builtin-v5"));
    assert.deepEqual(capability.providerIds, ["kimi-code", "claude-code", "codex"]);
    assert.match(capability.skill.instructions, /scripts\/render_verify\.py/);
  }
  assert.match(stored.find((c) => c.id === "builtin-office-documents").skill.instructions, /office_scaffold\.py/);
  assert.match(stored.find((c) => c.id === "builtin-office-spreadsheets").skill.instructions, /xlsx_build\.py/);
  await daemon.stop();
});

test("seeding materializes the bundled toolchain and points resourceDir at it", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const { service } = serviceWithStubbedSync(daemon);
  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    seedBuiltinCapabilities(service, root);
    const documents = service.list().find((c) => c.id === "builtin-office-documents");
    const resourceDir = documents.skill.resourceDir;
    assert.ok(resourceDir.startsWith(root));
    for (const script of ["scripts/render_verify.py", "scripts/office_scaffold.py"]) {
      const path = join(resourceDir, script);
      assert.equal(existsSync(path), true, path);
      assert.match(readFileSync(path, "utf8"), /Missing dependency/);
    }
    const sheets = service.list().find((c) => c.id === "builtin-office-spreadsheets");
    assert.equal(existsSync(join(sheets.skill.resourceDir, "scripts/xlsx_build.py")), true);

    // Second run: refresh in place, no duplicates, user toggles preserved.
    service.upsert({ ...documents, enabled: false });
    const again = seedBuiltinCapabilities(service, root);
    assert.equal(again.seeded, 0);
    assert.equal(service.list().filter((c) => c.tags.includes("builtin")).length, 4);
    assert.equal(service.list().find((c) => c.id === "builtin-office-documents").enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await daemon.stop();
  }
});

test("untouched v1 installs upgrade in place; user-edited ones survive", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const { service } = serviceWithStubbedSync(daemon);
  const v1 = {
    id: "builtin-office-documents", kind: "skill", name: "Office Documents",
    description: "v1", tags: ["office", "builtin"], enabled: true,
    providerIds: ["kimi-code"],
    skill: { instructions: "# Office Documents (.docx)\n\nProduce professional Word documents with python-docx.\n\nold body", source: "Built-in" },
    createdAt: "", updatedAt: ""
  };
  const v1Edited = {
    ...v1,
    id: "builtin-office-spreadsheets",
    skill: { instructions: "# Office Spreadsheets (.xlsx)\n\nMY CUSTOM EDITS", source: "Built-in" }
  };
  service.upsert(v1);
  service.upsert(v1Edited);

  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    const result = seedBuiltinCapabilities(service, root);
    assert.equal(result.seeded, 2); // presentations + research
    assert.equal(result.upgraded, 1); // only the untouched v1
    const upgraded = service.list().find((c) => c.id === "builtin-office-documents");
    assert.ok(upgraded.tags.includes("builtin-v5"));
    assert.deepEqual(upgraded.providerIds, ["kimi-code"]); // user narrowing preserved
    assert.ok(upgraded.skill.resourceDir);
    const edited = service.list().find((c) => c.id === "builtin-office-spreadsheets");
    assert.match(edited.skill.instructions, /MY CUSTOM EDITS/);
    assert.equal(edited.tags.includes("builtin-v5"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await daemon.stop();
  }
});

test("materialize is idempotent and covers every built-in skill", () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    const first = materializeBuiltinSkillResources(root);
    const second = materializeBuiltinSkillResources(root);
    assert.deepEqual([...first.keys()].sort(), [...second.keys()].sort());
    assert.equal(first.size, BUILTIN_OFFICE_SKILLS.length);
    for (const dir of first.values()) {
      assert.equal(existsSync(join(dir, "scripts", "render_verify.py")), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untouched v2 installs upgrade in place; edited v2 survives", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const { service } = serviceWithStubbedSync(daemon);
  const base = {
    kind: "skill", name: "Office Presentations", description: "v2",
    tags: ["office", "builtin", "builtin-v2"], enabled: true,
    providerIds: ["kimi-code", "claude-code", "codex"],
    createdAt: "", updatedAt: ""
  };
  service.upsert({
    ...base,
    id: "builtin-office-presentations",
    enabled: false, // user toggle must survive the upgrade
    skill: { instructions: V2_BODIES["builtin-office-presentations"], source: "Built-in" }
  });
  service.upsert({
    ...base,
    id: "builtin-office-documents",
    skill: { instructions: V2_BODIES["builtin-office-documents"] + "\nuser note", source: "Built-in" }
  });

  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    const result = seedBuiltinCapabilities(service, root);
    assert.equal(result.seeded, 2); // spreadsheets + research
    assert.equal(result.upgraded, 1); // only the untouched v2
    const upgraded = service.list().find((c) => c.id === "builtin-office-presentations");
    assert.ok(upgraded.tags.includes("builtin-v5"));
    assert.equal(upgraded.enabled, false); // toggle preserved
    assert.match(upgraded.skill.instructions, /add_chart_slide/);
    const edited = service.list().find((c) => c.id === "builtin-office-documents");
    assert.match(edited.skill.instructions, /user note/);
    assert.equal(edited.tags.includes("builtin-v5"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await daemon.stop();
  }
});

test("v3 toolchain ships the layout library and xlsx build commands", () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    const dirs = materializeBuiltinSkillResources(root);
    const scaffold = readFileSync(join(dirs.get("builtin-office-presentations"), "scripts/office_scaffold.py"), "utf8");
    for (const helper of ["add_agenda_slide", "add_two_column_slide", "add_cards_slide", "add_stats_slide", "add_table_slide", "add_image_slide", "add_chart_slide", "add_quote_slide", "add_closing_slide", "add_kicker", "add_footer", "set_speaker_notes", "make_glow_background", "set_style", "DEFAULT_STYLE", "--bg-to"]) {
      assert.ok(scaffold.includes(helper), helper);
    }
    const docxScaffold = readFileSync(join(dirs.get("builtin-office-documents"), "scripts/office_scaffold.py"), "utf8");
    for (const helper of ["add_toc", "add_table", "add_image", "add_callout", "add_code", "add_cover"]) {
      assert.ok(docxScaffold.includes("def " + helper), helper);
    }
    const xlsx = readFileSync(join(dirs.get("builtin-office-spreadsheets"), "scripts/xlsx_build.py"), "utf8");
    for (const marker of ["import-csv", "add-chart", "apply_formats", "add_databar", "NUMBER_FORMATS"]) {
      assert.ok(xlsx.includes(marker), marker);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untouched v3 installs upgrade to v5; edited v3 survives", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const { service } = serviceWithStubbedSync(daemon);
  const base = {
    kind: "skill", name: "Office Presentations", description: "v3",
    tags: ["office", "builtin", "builtin-v3"], enabled: true,
    providerIds: ["kimi-code", "claude-code", "codex"],
    createdAt: "", updatedAt: ""
  };
  service.upsert({
    ...base,
    id: "builtin-office-presentations",
    providerIds: ["codex"], // user narrowing must survive
    skill: { instructions: V3_BODIES["builtin-office-presentations"], source: "Built-in" }
  });
  service.upsert({
    ...base,
    id: "builtin-office-research",
    skill: { instructions: V3_BODIES["builtin-office-research"].replace("Markdown", "my custom format"), source: "Built-in" }
  });

  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    const result = seedBuiltinCapabilities(service, root);
    assert.equal(result.seeded, 2); // documents + spreadsheets
    assert.equal(result.upgraded, 1); // only the untouched v3
    const upgraded = service.list().find((c) => c.id === "builtin-office-presentations");
    assert.ok(upgraded.tags.includes("builtin-v5"));
    assert.deepEqual(upgraded.providerIds, ["codex"]);
    assert.match(upgraded.skill.instructions, /add_cards_slide/);
    const edited = service.list().find((c) => c.id === "builtin-office-research");
    assert.match(edited.skill.instructions, /my custom format/);
    assert.equal(edited.tags.includes("builtin-v5"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await daemon.stop();
  }
});

test("untouched v4 installs upgrade to v5; edited v4 survives", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const { service } = serviceWithStubbedSync(daemon);
  const base = {
    kind: "skill", name: "Office Presentations", description: "v4",
    tags: ["office", "builtin", "builtin-v4"], enabled: true,
    providerIds: ["kimi-code", "claude-code", "codex"],
    createdAt: "", updatedAt: ""
  };
  service.upsert({
    ...base,
    id: "builtin-office-presentations",
    enabled: false, // user toggle must survive
    skill: { instructions: V4_BODIES["builtin-office-presentations"], source: "Built-in" }
  });
  service.upsert({
    ...base,
    id: "builtin-office-spreadsheets",
    skill: { instructions: V4_BODIES["builtin-office-spreadsheets"] + "\ntweaked", source: "Built-in" }
  });

  const root = mkdtempSync(join(tmpdir(), "agenthub-builtin-"));
  try {
    const result = seedBuiltinCapabilities(service, root);
    assert.equal(result.seeded, 2); // documents + research
    assert.equal(result.upgraded, 1); // only the untouched v4
    const upgraded = service.list().find((c) => c.id === "builtin-office-presentations");
    assert.ok(upgraded.tags.includes("builtin-v5"));
    assert.equal(upgraded.enabled, false);
    assert.match(upgraded.skill.instructions, /set_style/);
    const edited = service.list().find((c) => c.id === "builtin-office-spreadsheets");
    assert.match(edited.skill.instructions, /tweaked/);
    assert.equal(edited.tags.includes("builtin-v5"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await daemon.stop();
  }
});
