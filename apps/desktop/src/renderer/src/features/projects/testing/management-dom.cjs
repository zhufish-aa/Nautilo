/** DOM integration only, not a native desktop or pixel test.
 * NAUTILO_JSDOM_PATH=/path/to/node_modules/jsdom node <this file>
 * All Core calls are replaced with a test transport. No files or CLIs are changed.
 */
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH || "jsdom");
const desktop = path.resolve(__dirname, "../../../../../..");
const fromVite = createRequire(require.resolve("vite/package.json", { paths: [desktop] }));
const esbuild = fromVite("esbuild");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const errors = [],
  warnings = [],
  passed = [],
  failures = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (error) => errors.push(error.message));
vc.on("error", (...x) => errors.push(x.join(" ")));
vc.on("warn", (...x) => warnings.push(x.join(" ")));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://unit.test/#/projects",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: vc
});
const w = dom.window,
  d = w.document;
w.matchMedia = (q) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {}
});
w.ResizeObserver = w.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
w.HTMLElement.prototype.scrollTo = w.HTMLElement.prototype.scrollIntoView = function () {};
w.URL.createObjectURL = () => "blob:unit";
w.URL.revokeObjectURL = () => {};
w.DOMMatrix = class {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const route = async (hash) => {
  w.location.hash = hash;
  await sleep(100);
};
const text = () => d.body.textContent;
const buttons = (root = d) => [...root.querySelectorAll("button,a")];
const find = (label, root = d) => buttons(root).find((e) => e.textContent.trim() === label);
const click = async (label, root = d) => {
  const e = find(label, root);
  assert(e, `Missing button: ${label}`);
  e.click();
  await sleep(120);
};
const input = async (id, value) => {
  const e = d.getElementById(id);
  assert(e, `Missing field: ${id}`);
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(e, value);
  e.dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(30);
};
const dialog = () => d.querySelector('[role="dialog"][data-state="open"]');
const check = async (name, fn) => {
  try {
    await fn();
    passed.push(name);
    console.log("PASS", name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL", name, error.message);
  }
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-management-"));
(async () => {
  const output = path.join(scratch, "bundle.js");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "management-entry.tsx")],
    outfile: output,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty", ".png": "dataurl", ".ttf": "dataurl" },
    nodePaths: [path.join(desktop, "node_modules")],
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [
      {
        name: "qa-bridge",
        setup(build) {
          build.onResolve({ filter: /(?:^|\/)lib\/bridge(?:\.ts)?$/ }, (args) => ({
            path: args.path,
            namespace: "qa-bridge"
          }));
          build.onLoad({ filter: /.*/, namespace: "qa-bridge" }, () => ({
            contents:
              'export const getBridge=()=>undefined; export const isElectron=false; export const requestCore=async(method)=>{ if(method === "policy.list") return [{id:"default",name:"常规权限"}]; if(method === "provider.models") return {models:[]}; throw Error("Test bridge: " + method); };'
          }));
          build.onResolve({ filter: /\?worker/ }, (args) => ({
            path: args.path,
            namespace: "qa-worker"
          }));
          build.onLoad({ filter: /.*/, namespace: "qa-worker" }, () => ({
            contents: "export default class Worker { postMessage() {} terminate() {} }"
          }));
        }
      }
    ]
  });
  w.eval(fs.readFileSync(output, "utf8"));
  await sleep(150);
  const qa = w.managementQa,
    now = "2026-11-03T02:00:00Z";
  const project = {
    id: "p",
    name: "Nautilo",
    rootPath: "/test/nautilo",
    repositoryType: "git",
    workspaceMode: "direct",
    scanning: false,
    verificationTemplates: [],
    addedAt: now,
    scan: {
      scannedAt: now,
      git: {
        isRepo: true,
        branch: "main",
        defaultBranch: "main",
        remote: "https://example.test/repo",
        dirtyFiles: 3
      },
      stacks: [{ name: "TypeScript", confidence: 90 }],
      frontendPaths: ["src"],
      backendPaths: [],
      risks: []
    }
  };
  const role = {
    id: "role",
    name: "工程师",
    description: "负责界面实现",
    responsibilities: ["界面实现"],
    strengths: { React: 4 },
    limitations: [],
    systemInstructions: "遵循项目约定",
    permissionPolicyId: "default"
  };
  const member = {
    id: "m",
    displayName: "前端工程师",
    agentInstanceId: "a",
    role,
    allowedTaskTypes: ["code"],
    maxConcurrentTasks: 1,
    enabled: true
  };
  const team = {
    id: "team",
    name: "产品研发团队",
    delegationPolicy: "autonomous",
    members: [member],
    createdAt: now,
    updatedAt: now
  };
  qa.projects.setState({ projects: [project] });
  qa.teams.setState({ teams: [team] });
  qa.agents.setState({
    instances: [
      {
        id: "a",
        displayName: "Codex",
        providerId: "codex",
        enabled: true,
        status: "available",
        executable: "test",
        baseArgs: [],
        envPolicyId: "default",
        createdAt: now,
        updatedAt: now
      }
    ],
    modelCatalogs: { a: { models: [], source: "provider_cli" } }
  });
  await sleep(100);
  await check("project list uses one real route and shows ready status", () => {
    assert(d.querySelector('a[href="#/projects/p"]'));
    assert(text().includes("就绪"));
  });
  await check("add project Cancel is inert", async () => {
    await click("添加项目");
    assert(dialog());
    await input("project-path", "/test/new");
    await click("取消", dialog());
    await sleep(200);
    assert.equal(qa.projects.getState().projects.length, 1);
    assert(!dialog());
  });
  await check("autofocused form Cancel restores its opener on every open", async () => {
    const opener = find("添加项目");
    for (let index = 0; index < 2; index++) {
      opener.focus();
      opener.click();
      await sleep(150);
      assert.equal(d.activeElement.id, "project-path");
      await click("取消", dialog());
      await sleep(200);
      assert.equal(d.activeElement, opener);
    }
  });
  await check("add project failure remains retryable and prevents repeated sends", async () => {
    let calls = 0,
      reject;
    qa.projects.setState({
      addProject: () => {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      }
    });
    await click("添加项目");
    await input("project-path", "/test/new");
    const add = find("添加", dialog());
    assert(add);
    add.click();
    add.click();
    await sleep(30);
    assert.equal(calls, 1);
    reject(new Error("扫描连接失败"));
    await sleep(100);
    assert(dialog());
    assert(text().includes("扫描连接失败"));
    assert(!find("添加", dialog()).disabled);
    await click("取消", dialog());
    await sleep(200);
  });
  await check("a project added before scan failure has an explicit recovery path", async () => {
    qa.projects.setState({
      addProject: async () => {
        qa.projects.setState({
          projects: [
            ...qa.projects.getState().projects,
            {
              ...project,
              id: "partial",
              name: "扫描待完成",
              rootPath: "/test/partial",
              scan: undefined
            }
          ]
        });
        throw Error("扫描未完成");
      }
    });
    await sleep(50);
    await click("添加项目");
    await input("project-path", "/test/partial");
    await click("添加", dialog());
    assert(dialog());
    assert(find("添加", dialog()).disabled);
    assert(text().includes("项目已添加，但扫描未完成"));
    await click("查看项目", dialog());
    assert.equal(w.location.hash, "#/projects/partial");
    assert.equal(
      qa.projects.getState().projects.filter((item) => item.rootPath === "/test/partial").length,
      1
    );
    qa.projects.setState({ projects: [project] });
  });
  await route("/projects/p");
  await check(
    "project details preserve Git, paths and new-project conversation destination",
    async () => {
      assert(text().includes("main"));
      assert(text().includes("TypeScript"));
      assert(text().includes("src"));
      await click("开始会话");
      assert.equal(w.location.hash, "#/sessions?new=1&project=p");
      await route("/projects/p");
    }
  );
  await check("scan failure shows an error and can retry", async () => {
    qa.projects.setState({
      rescanProject: async () => {
        throw Error("扫描失败，请重试");
      }
    });
    await sleep(50);
    await click("重新扫描");
    assert(text().includes("扫描失败，请重试"));
    qa.projects.setState({ rescanProject: async () => {} });
    await sleep(50);
    await click("重新扫描");
    assert(!text().includes("扫描失败，请重试"));
  });
  await check("workspace mode failure leaves stored mode unchanged", async () => {
    qa.projects.setState({
      setWorkspaceMode: async () => {
        throw Error("工作区保存失败");
      }
    });
    await sleep(50);
    const option = buttons().find((e) => e.getAttribute("aria-pressed") === "false");
    assert(option);
    option.click();
    await sleep(100);
    assert(text().includes("工作区保存失败"));
    assert.equal(qa.projects.getState().projects[0].workspaceMode, "direct");
  });
  await check("verification template creation is explicit and supports edit/cancel", async () => {
    qa.projects.setState({
      setVerificationTemplates: async (id, verificationTemplates) =>
        qa.projects.setState({
          projects: [{ ...qa.projects.getState().projects[0], verificationTemplates }]
        })
    });
    await click("新增模板");
    await input("verification-name", "类型检查");
    await input("verification-command", "pnpm");
    await click("保存", dialog());
    await sleep(200);
    assert.equal(qa.projects.getState().projects[0].verificationTemplates.length, 1);
    d.querySelector('[aria-label="编辑 类型检查"]').click();
    await sleep(100);
    assert.equal(d.getElementById("verification-command").value, "pnpm");
    await click("取消", dialog());
    await sleep(200);
  });
  await check("project remove Cancel and Escape restore the external remove button", async () => {
    const opener = find("移除项目");
    opener.focus();
    opener.click();
    await sleep(120);
    assert(dialog().contains(d.activeElement));
    await click("取消", dialog());
    await sleep(200);
    assert.equal(d.activeElement, opener);
    opener.click();
    await sleep(120);
    d.activeElement.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await sleep(320);
    assert(!dialog());
    assert.equal(d.activeElement, opener);
  });
  await check("quickly reopening during exit keeps focus within the active dialog", async () => {
    const opener = find("移除项目");
    opener.focus();
    opener.click();
    await sleep(120);
    find("取消", dialog()).click();
    await sleep(20);
    opener.focus();
    opener.click();
    await sleep(220);
    assert(dialog());
    assert(dialog().contains(d.activeElement));
    await click("取消", dialog());
    await sleep(200);
    assert.equal(d.activeElement, opener);
  });
  await check("closing an unmounted dialog does not steal the next route's focus", async () => {
    const opener = find("移除项目");
    opener.focus();
    opener.click();
    await sleep(120);
    await route("/projects");
    const nextTarget = find("添加项目");
    nextTarget.focus();
    await sleep(220);
    assert(!opener.isConnected);
    assert.equal(d.activeElement, nextTarget);
    await route("/projects/p");
  });
  await check("project remove failure stays in confirmation", async () => {
    qa.projects.setState({
      removeProject: async () => {
        throw Error("移除失败");
      }
    });
    await click("移除项目");
    await click("移除项目", dialog());
    assert(dialog());
    assert(text().includes("移除失败"));
    assert.equal(qa.projects.getState().projects.length, 1);
    await click("取消", dialog());
    await sleep(200);
  });
  await route("/teams");
  await check("create team asks for a name before making a request", async () => {
    let calls = 0;
    qa.teams.setState({
      createTeam: async () => {
        calls++;
        throw Error("创建失败");
      }
    });
    await click("新建团队");
    assert.equal(calls, 0);
    assert(find("创建", dialog()).disabled);
    await input("new-team-name", "新团队");
    await click("创建", dialog());
    assert.equal(calls, 1);
    assert(dialog());
    assert(text().includes("创建失败"));
    await click("取消", dialog());
    await sleep(200);
  });
  await route("/teams/team");
  await check(
    "team edit saves once instead of one request per keystroke; failure rolls back",
    async () => {
      let calls = 0;
      qa.teams.setState({
        updateTeam: async (id, patch) => {
          calls++;
          qa.teams.setState({ teams: qa.teams.getState().teams.map((t) => ({ ...t, ...patch })) });
          throw Error("团队保存失败");
        }
      });
      await click("编辑");
      await input("team-name", "更新名称");
      assert.equal(calls, 0);
      await click("保存", dialog());
      assert.equal(calls, 1);
      assert(dialog());
      assert(text().includes("团队保存失败"));
      assert.equal(qa.teams.getState().teams[0].name, "产品研发团队");
      await click("取消", dialog());
      await sleep(200);
    }
  );
  await check(
    "member dialog retains form on failure and model/role fields stay accessible",
    async () => {
      qa.teams.setState({
        updateMember: async () => {
          throw Error("成员保存失败");
        }
      });
      d.querySelector('[aria-label="编辑 前端工程师"]').click();
      await sleep(150);
      assert(dialog());
      assert(d.getElementById("member-model"));
      assert(d.getElementById("role-desc"));
      await input("member-name", "工程师更新");
      await click("保存", dialog());
      assert(dialog());
      assert(text().includes("成员保存失败"));
      assert.equal(d.getElementById("member-name").value, "工程师更新");
      const roleTab = d.querySelector('[role="tab"][aria-selected="false"]');
      assert(roleTab);
      roleTab.click();
      await sleep(80);
      assert(d.getElementById("role-instructions"));
      await click("取消", dialog());
      await sleep(200);
    }
  );
  await check("remove member Cancel is inert", async () => {
    d.querySelector('[aria-label="移除成员 前端工程师"]').click();
    await sleep(100);
    assert(dialog());
    await click("取消", dialog());
    await sleep(200);
    assert.equal(qa.teams.getState().teams[0].members.length, 1);
  });
  await check("member removal failure rolls back and the confirmation can be retried", async () => {
    qa.teams.setState({
      removeMember: async (id, memberId) => {
        qa.teams.setState({
          teams: qa.teams.getState().teams.map((item) => ({
            ...item,
            members: item.members.filter((member) => member.id !== memberId)
          }))
        });
        throw Error("成员移除失败");
      }
    });
    await sleep(50);
    d.querySelector('[aria-label="移除成员 前端工程师"]').click();
    await sleep(100);
    await click("移除成员", dialog());
    assert(dialog());
    assert(text().includes("成员移除失败"));
    assert.equal(qa.teams.getState().teams[0].members.length, 1);
    qa.teams.setState({
      removeMember: async (id, memberId) => {
        qa.teams.setState({
          teams: qa.teams.getState().teams.map((item) => ({
            ...item,
            members: item.members.filter((member) => member.id !== memberId)
          }))
        });
      }
    });
    await sleep(50);
    await click("移除成员", dialog());
    await sleep(200);
    assert(!dialog());
    assert.equal(qa.teams.getState().teams[0].members.length, 0);
    qa.teams.setState({ teams: [team] });
  });
  await check("team deletion is explicit and navigates only after success", async () => {
    qa.teams.setState({
      deleteTeam: async (id) =>
        qa.teams.setState({ teams: qa.teams.getState().teams.filter((item) => item.id !== id) })
    });
    await sleep(50);
    await click("删除团队");
    await click("取消", dialog());
    await sleep(200);
    assert.equal(qa.teams.getState().teams.length, 1);
    await click("删除团队");
    await click("删除团队", dialog());
    await sleep(200);
    assert.equal(w.location.hash, "#/teams");
    assert.equal(qa.teams.getState().teams.length, 0);
    qa.teams.setState({ teams: [team] });
  });
  const sessions = [
    {
      id: "parent",
      projectId: "p",
      title: "优化构建流程",
      target: { type: "agent", instanceId: "a" },
      status: "idle",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "child&a",
      projectId: "p",
      title: "实现任务",
      parentSessionId: "parent",
      taskId: "task1",
      mode: "work",
      target: { type: "agent", instanceId: "a" },
      status: "idle",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now
    }
  ];
  qa.sessions.setState({
    sessions,
    tasks: {
      parent: [
        {
          id: "task1",
          title: "实现任务",
          memberName: "前端工程师",
          status: "running",
          dependencies: []
        },
        {
          id: "task2",
          title: "检查结果",
          memberName: "验证员",
          status: "queued",
          dependencies: ["task1"]
        }
      ]
    }
  });
  await route("/tasks");
  await check(
    "DAG and task list navigate legacy work children to canonical encoded URLs",
    async () => {
      assert(d.querySelector('[role="region"]'));
      assert.equal(d.querySelectorAll('[role="region"] button').length, 2);
      d.querySelector('[role="region"] button').click();
      await sleep(100);
      assert.equal(w.location.hash, "#/sessions?session=child%26a");
      assert.equal(qa.sessions.getState().activeSessionId, "child&a");
    }
  );
  await check("runs retain waiting, running and unread groups without duplicate rows", async () => {
    qa.sessions.setState({
      sessions: [
        sessions[0],
        { ...sessions[1], id: "active", parentSessionId: undefined, taskId: undefined },
        { ...sessions[0], id: "unread", title: "未读会话", unreadCount: 2 }
      ],
      foreground: { active: { status: "running" } },
      running: {}
    });
    qa.interactions.setState({ bySession: { parent: [{ status: "pending" }] } });
    await route("/runs");
    assert.equal(d.querySelectorAll("section").length, 3);
    assert.equal(d.querySelectorAll("section button").length, 3);
    assert(text().includes("未读会话"));
  });
  await check("all empty lists and missing detail routes remain actionable", async () => {
    const projects = qa.projects.getState().projects;
    const teams = qa.teams.getState().teams;
    const sessions = qa.sessions.getState().sessions;
    qa.projects.setState({ projects: [] });
    qa.teams.setState({ teams: [] });
    qa.sessions.setState({ sessions: [] });
    await route("/projects");
    assert(find("添加项目"));
    await route("/projects/missing");
    assert(text().includes("项目不存在"));
    await route("/teams");
    assert(find("新建团队"));
    await route("/teams/missing");
    assert(text().includes("团队不存在"));
    await route("/tasks");
    assert(!d.querySelector('[role="region"]'));
    await route("/runs");
    assert.equal(d.querySelectorAll("section").length, 3);
    assert.equal(d.querySelectorAll("section button").length, 0);
    qa.projects.setState({ projects });
    qa.teams.setState({ teams });
    qa.sessions.setState({ sessions });
  });
  await check("onboarding has three steps, Escape dismisses, and replay resets", async () => {
    qa.settings.setState({ onboardingCompleted: false });
    await sleep(150);
    assert(dialog());
    assert(text().includes("1 / 3"));
    await click("下一步", dialog());
    assert(text().includes("2 / 3"));
    d.activeElement.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await sleep(120);
    assert.equal(qa.settings.getState().onboardingCompleted, true);
    qa.settings.setState({ onboardingCompleted: false });
    await sleep(120);
    assert(text().includes("1 / 3"));
    await click("跳过", dialog());
    await sleep(100);
  });
  await check("no React/runtime errors", () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed, failures, errors, warnings }, null, 2));
  if (failures.length) process.exitCode = 1;
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    dom.window.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
