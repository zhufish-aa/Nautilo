import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {execFile} from "node:child_process";
const require=createRequire(import.meta.url),desktop=fileURLToPath(new URL("..",import.meta.url));
test("live Baidu to Bilibili through Nautilo MCP",{skip:process.env.NAUTILO_BROWSER_LIVE !== "1",timeout:200000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"nautilo-browser-live-")),entry=join(root,"main.cjs");
  await createRequire(require.resolve("vite/package.json"))("esbuild").build({entryPoints:[join(desktop,"test/helpers/browser-live-fixture.ts")],outfile:entry,bundle:true,platform:"node",format:"cjs",external:["electron"],logLevel:"silent"});
  const env={...process.env,APPDATA:root,LOCALAPPDATA:root};delete env.ELECTRON_RUN_AS_NODE;
  try{await promisify(execFile)(require("electron"),["--user-data-dir="+root,"--disable-breakpad",entry],{env,windowsHide:true,timeout:195000});}
  catch{const report=await readFile(join(root,"live-result.json"),"utf8");console.log(report);throw Error("Live acceptance did not finish: "+root);}
  const report=JSON.parse(await readFile(join(root,"live-result.json"),"utf8"));assert.equal(report.completed,true);assert.ok(report.steps.length<=10);console.log(JSON.stringify(report));
});
