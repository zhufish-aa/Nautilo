import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));

test(
  "embedded browser preserves tabs, reads live content, drives pages and moves between windows",
  {
    timeout: 95000,
    skip:
      process.platform === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-browser-test-"));
    const entry = join(root, "main.cjs");
    const bundle = createRequire(require.resolve("vite/package.json"))(
      "esbuild",
    );
    await bundle.build({
      entryPoints: [join(desktop, "test/helpers/browser-fixture.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
    });
    await writeFile(
      join(root, "preload.cjs"),
      'const {ipcRenderer,contextBridge}=require("electron");contextBridge.exposeInMainWorld("panel",(id,cmd,value)=>ipcRenderer.invoke("browser:panel",id,cmd,value));contextBridge.exposeInMainWorld("panels",{open:(t,f)=>ipcRenderer.invoke("panels:open",t,f),dock:()=>ipcRenderer.invoke("panels:dock"),onDock:fn=>{ipcRenderer.on("panels:docked",(e,t)=>fn(t));}});',
    );
    const env = {
      ...process.env,
      APPDATA: root,
      LOCALAPPDATA: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = promisify(execFile);
    try {
      await run(
        require("electron"),
        [
          "--user-data-dir=" + root,
          "--disable-breakpad",
          "--disable-background-networking",
          entry,
        ],
        { env, windowsHide: true, timeout: 90000 },
      );
    } catch (error) {
      const phase = await readFile(join(root, "phase.txt"), "utf8").catch(
        () => "startup",
      );
      throw Error(
        phase +
          " — " +
          (await readFile(join(root, "error.txt"), "utf8").catch(() =>
            String(error),
          )),
      );
    }
    const report = JSON.parse(
      await readFile(join(root, "result.json"), "utf8"),
    );
    assert.equal(report.succeeded, report.runs);
    console.log("Embedded browser", report);
  },
);

test(
  "browser authentication cookies survive restart and logout remains effective",
  {
    timeout: 60000,
    skip:
      process.platform === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-browser-cookie-test-"));
    const bundle = createRequire(require.resolve("vite/package.json"))(
      "esbuild",
    );
    const entry = join(root, "cookie-main.cjs");
    await bundle.build({
      entryPoints: [join(desktop, "test/helpers/browser-cookie-fixture.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
    });
    const env = {
      ...process.env,
      APPDATA: root,
      LOCALAPPDATA: root,
      NAUTILO_COOKIE_PROFILE: root,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const phase of ["write", "verify", "logout", "verify-logout"]) {
      try {
        await promisify(execFile)(
          require("electron"),
          [
            "--user-data-dir=" + root,
            "--disable-breakpad",
            "--disable-background-networking",
            entry,
          ],
          {
            env: { ...env, NAUTILO_COOKIE_PHASE: phase },
            windowsHide: true,
            timeout: 14000,
          },
        );
      } catch (error) {
        throw Error(
          phase +
            " — " +
            (await readFile(join(root, "cookie-error.txt"), "utf8").catch(() =>
              String(error),
            )),
        );
      }
    }
  },
);

test(
  "browser workspaces restore across processes and deleted conversations stay deleted",
  {
    timeout: 95000,
    skip:
      process.platform === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY,
  },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "nautilo-browser-workspace-test-"),
    );
    const bundle = createRequire(require.resolve("vite/package.json"))(
      "esbuild",
    );
    const entry = join(root, "workspace-main.cjs");
    await bundle.build({
      entryPoints: [join(desktop, "test/helpers/browser-workspace-fixture.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      logLevel: "silent",
    });
    const site = createServer((_req, res) =>
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          '<!doctype html><label>Query<input></label><div style="height:2000px"></div><h2 id="tail">Saved position</h2>',
        ),
    );
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    const env = {
      ...process.env,
      APPDATA: root,
      LOCALAPPDATA: root,
      NAUTILO_WORKSPACE_PROFILE: root,
      NAUTILO_WORKSPACE_SITE: "http://127.0.0.1:" + site.address().port,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      for (const phase of ["write", "verify", "delete", "verify-delete"]) {
        try {
          await promisify(execFile)(
            require("electron"),
            [
              "--user-data-dir=" + root,
              "--disable-breakpad",
              "--disable-background-networking",
              entry,
            ],
            {
              env: { ...env, NAUTILO_WORKSPACE_PHASE: phase },
              windowsHide: true,
              timeout: 22000,
            },
          );
        } catch (error) {
          throw Error(
            phase +
              " — " +
              (await readFile(join(root, "workspace-error.txt"), "utf8").catch(
                () => String(error),
              )),
          );
        }
      }
    } finally {
      await new Promise((resolve) => site.close(resolve));
    }
  },
);
