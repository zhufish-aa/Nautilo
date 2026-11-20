import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rustEnvironment, run, workspace } from "./rust-build.mjs";
import { prepareRustSources } from "./prepare-rust-sources.mjs";

// One command checks actual Rust transitions and the native execution pipeline,
// then feeds its snapshots through the published schema and production renderer.
const manager=process.env.npm_execpath;
if(!manager)throw new Error("Run through pnpm test:workflows so the workspace package manager is known.");
const directory=await mkdtemp(join(tmpdir(),"nautilo-workflow-check-"));
const state=process.env.NAUTILO_WORKFLOW_QA_STATE || join(directory,"engine-state.json");
const env={...rustEnvironment(),NAUTILO_WORKFLOW_QA_STATE:state,NAUTILO_WORKFLOW_TEST_ROOT:directory};
let server;
const previousState=process.env.NAUTILO_WORKFLOW_QA_STATE;
try {
  await run(process.execPath,[manager,"-r","--filter","@agenthub/core-daemon...","build"],{cwd:workspace,env});
  await prepareRustSources();
  await run("cargo",["test","-p","nautilo-core","workflow_","--offline","--","--nocapture"],{cwd:join(workspace,"rust"),env});
  await run(process.execPath,[join(workspace,"tests/contract/workflows.test.mjs")],{cwd:workspace,env});
  if(process.argv.includes("--browser")) {
    process.env.NAUTILO_WORKFLOW_QA_STATE=state;
    const require=createRequire(join(workspace,"apps/desktop/package.json"));
    const {createServer}=await import(pathToFileURL(require.resolve("vite/package.json").replace(/package\.json$/,"dist/node/index.js")));
    // Keep this check's cache separate from the live Electron app and every
    // other QA server. Write outputs in Node for hosts that restrict esbuild's
    // helper process from opening cache files directly.
    const writer={name:"workflow-qa-cache",setup(build){build.onEnd(async result=>{if(!build.initialOptions.outdir||!result.outputFiles)return;await Promise.all(result.outputFiles.map(async file=>{await mkdir(dirname(file.path),{recursive:true});await writeFile(file.path,file.contents);}));});}};
    server=await createServer({configFile:join(workspace,"apps/desktop/test/ui/workflow-visual.vite.config.mts"),cacheDir:join(directory,"vite-cache"),optimizeDeps:{esbuildOptions:{write:false,plugins:[writer]}},server:{host:"127.0.0.1",port:0,strictPort:false}});
    await server.listen();
    const url=server.resolvedUrls.local[0]+"workflow-visual.html";
    await run(process.execPath,[join(workspace,"apps/desktop/test/ui/workflow-browser.mjs")],{cwd:workspace,env:{...env,NAUTILO_WORKFLOW_QA_URL:url}});
  }
} finally {
  await server?.close();
  if(previousState===undefined)delete process.env.NAUTILO_WORKFLOW_QA_STATE;else process.env.NAUTILO_WORKFLOW_QA_STATE=previousState;
  const target=resolve(directory),base=resolve(tmpdir())+sep;
  if(target.startsWith(base)&&basename(target).startsWith("nautilo-workflow-check-"))await rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:200});
}
