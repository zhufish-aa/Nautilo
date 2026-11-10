import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,copyFile,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const require=createRequire(import.meta.url),desktop=fileURLToPath(new URL("..",import.meta.url));
test("local probe: file navigation, iframe input, drag, blob download and continuous explicit control",{timeout:65000,skip:process.platform==="linux"&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY},async()=>{
  const root=await mkdtemp(join(tmpdir(),"nautilo-browser-probe-")),entry=join(root,"main.cjs");
  await copyFile(join(desktop,"test/fixtures/browser-probe.html"),join(root,"本地探针.html"));
  await writeFile(join(root,"preload.cjs"),'const {ipcRenderer,contextBridge}=require("electron");contextBridge.exposeInMainWorld("panel",(...a)=>ipcRenderer.invoke("browser:panel",...a));');
  await createRequire(require.resolve("vite/package.json"))("esbuild").build({entryPoints:[join(desktop,"test/helpers/browser-probe-fixture.ts")],outfile:entry,bundle:true,platform:"node",format:"cjs",external:["electron"],logLevel:"silent"});
  const env={...process.env,APPDATA:root,LOCALAPPDATA:root};delete env.ELECTRON_RUN_AS_NODE;
  try {await promisify(execFile)(require("electron"),["--user-data-dir="+root,"--disable-breakpad",entry],{env,windowsHide:true,timeout:60000});}
  catch(error){throw Error(await readFile(join(root,"error.txt"),"utf8").catch(()=>String(error)));}
  const result=JSON.parse(await readFile(join(root,"result.json"),"utf8"));
  assert.equal(result.saved,"hello probe");assert.equal(result.drag,"dropped");assert.equal(result.frame,true);assert.equal(result.control,true);
});
