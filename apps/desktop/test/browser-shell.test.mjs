import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url), desktop = fileURLToPath(new URL("..",import.meta.url));
test("browser shell captures real diagnostics, selections and attachments without using automation commands",{
  timeout:50000,skip:process.platform==="linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),"nautilo-browser-shell-")), entry=join(root,"main.cjs");
  const bundle=createRequire(require.resolve("vite/package.json"))("esbuild");
  await bundle.build({entryPoints:[join(desktop,"test/helpers/browser-shell-fixture.ts")],outfile:entry,bundle:true,platform:"node",format:"cjs",external:["electron"]});
  await writeFile(join(root,"preload.cjs"),`
    const { contextBridge, ipcRenderer } = require("electron");
    const drafts = [];
    ipcRenderer.on("browser:draft", (_event,draft) => drafts.push(draft));
    contextBridge.exposeInMainWorld("bridgeTest", {
      panel:(...args)=>ipcRenderer.invoke("browser:panel",...args),
      spaces:(...args)=>ipcRenderer.invoke("browser:spaces",...args),
      shell:(...args)=>ipcRenderer.invoke("browser:shell",...args),
      open:(...args)=>ipcRenderer.invoke("panels:open",...args)
    });
    contextBridge.exposeInMainWorld("drafts", { size:()=>drafts.length, last:()=>drafts.at(-1) });
  `);
  const env={...process.env,APPDATA:root,LOCALAPPDATA:root};
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await promisify(execFile)(require("electron"),["--user-data-dir="+root,"--disable-breakpad","--disable-background-networking",entry],{env,windowsHide:true,timeout:45000});
  } catch(error) {
    const phase=await readFile(join(root,"phase.txt"),"utf8").catch(()=>"startup");
    throw Error(phase+" — "+await readFile(join(root,"shell-error.txt"),"utf8").catch(()=>String(error)));
  }
});
