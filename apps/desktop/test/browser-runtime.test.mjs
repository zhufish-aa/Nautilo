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

test("browser MCP contracts, files, dialogs, login import and last-window stop",{
  timeout:95000,
  skip:process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),"nautilo-browser-contract-")),entry=join(root,"main.cjs");
  await createRequire(require.resolve("vite/package.json"))("esbuild").build({entryPoints:[join(desktop,"test/helpers/browser-contract-fixture.ts")],outfile:entry,bundle:true,platform:"node",format:"cjs",external:["electron"],logLevel:"silent"});
  const env={...process.env,APPDATA:root,LOCALAPPDATA:root};delete env.ELECTRON_RUN_AS_NODE;
  try {await promisify(execFile)(require("electron"),["--user-data-dir="+root,"--disable-breakpad","--disable-background-networking",entry],{env,windowsHide:true,timeout:90000});}
  catch(error){throw Error(await readFile(join(root,"contract-error.txt"),"utf8").catch(()=>String(error)));}
  const report=JSON.parse(await readFile(join(root,"contract-results.json"),"utf8"));
  const schema=JSON.parse(await readFile(new URL("../../../docs/browser/schemas/receipt-v2.schema.json",import.meta.url),"utf8"));
  function validate(value,spec,path="$") {
    if(spec.$ref)return validate(value,spec.$ref.split("/").slice(1).reduce((item,key)=>item[key],schema),path);
    if(spec.const !== undefined)assert.deepEqual(value,spec.const,path);
    if(spec.enum)assert.ok(spec.enum.includes(value),path);
    if(spec.type === "object") {
      assert.ok(value && typeof value === "object" && !Array.isArray(value),path);
      for(const key of spec.required ?? [])assert.ok(Object.hasOwn(value,key),path+" requires "+key);
      for(const [key,item] of Object.entries(value)){if(spec.additionalProperties === false)assert.ok(Object.hasOwn(spec.properties,key),path+" unknown "+key);if(spec.properties?.[key])validate(item,spec.properties[key],path+"."+key);}
    }
    if(spec.type === "array"){assert.ok(Array.isArray(value),path);value.forEach((item,index)=>validate(item,spec.items,path+"["+index+"]"));}
    if(spec.type === "integer")assert.ok(Number.isInteger(value),path);
    if(spec.type === "string"){assert.equal(typeof value,"string",path);if(spec.pattern)assert.match(value,new RegExp(spec.pattern),path);}
    if(spec.type === "boolean")assert.equal(typeof value,"boolean",path);
    if(spec.minimum !== undefined)assert.ok(value>=spec.minimum,path);
  }
  validate(report.strict,schema);validate(report.strictFailure,schema);
});

test("one browser host preserves independent tabs and restores through the overview", {
  timeout:65000,
  skip:process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async () => {
  const root = await mkdtemp(join(tmpdir(),"nautilo-browser-spaces-"));
  const entry = join(root,"main.cjs");
  await createRequire(require.resolve("vite/package.json"))("esbuild").build({entryPoints:[join(desktop,"test/helpers/browser-spaces-fixture.ts")],outfile:entry,bundle:true,platform:"node",format:"cjs",external:["electron"],logLevel:"silent"});
  await writeFile(join(root,"preload.cjs"),'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("fixture",{panel:(...a)=>ipcRenderer.invoke("browser:panel",...a),spaces:(...a)=>ipcRenderer.invoke("browser:spaces",...a),open:(...a)=>ipcRenderer.invoke("panels:open",...a)});');
  const server = createServer((req,res) => res.writeHead(200,{"content-type":"text/html"}).end('<title>'+req.url+'</title><label>Query<input></label><p>Window '+req.url+'</p>'));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const env = {...process.env,APPDATA:root,LOCALAPPDATA:root,NAUTILO_SPACES_SITE:"http://127.0.0.1:"+server.address().port};
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const phase of ["write","restore"]) {
      try { await promisify(execFile)(require("electron"),["--user-data-dir="+root,"--disable-breakpad","--disable-background-networking",entry],{env:{...env,NAUTILO_SPACES_PHASE:phase},windowsHide:true,timeout:28000}); }
      catch (error) { throw Error(phase+" — "+await readFile(join(root,"spaces-phase.txt"),"utf8").catch(()=>"startup")+" — "+await readFile(join(root,"spaces-error.txt"),"utf8").catch(()=>String(error))); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

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
