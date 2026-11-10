import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
const require=createRequire(import.meta.url),desktop=fileURLToPath(new URL("..",import.meta.url));
test("browser events across harness namespaces render action summaries and a dedicated icon",async()=>{
  const root=await mkdtemp(join(tmpdir(),"nautilo-browser-display-")),output=join(root,"display.cjs");
  await createRequire(require.resolve("vite/package.json"))("esbuild").build({stdin:{contents:'export * from "./src/renderer/src/lib/browser-display";export * from "./src/renderer/src/features/timeline/BrowserActivity";',resolveDir:desktop,loader:"tsx"},outfile:output,bundle:true,platform:"node",format:"cjs",jsx:"automatic",external:["react","react-dom/server"],logLevel:"silent"});
  // Resolve React from this package; the isolated bundle itself has no dependency directory.
  const code=await readFile(output,"utf8");
  const Module=require("node:module");const loaded=new Module(output);loaded.filename=output;loaded.paths=Module._nodeModulePaths(desktop);loaded._compile(code,output);
  const {isBrowserTool,browserActivity,browserStepLabel,BrowserActivity}=loaded.exports;
  for(const name of ["browser_run","mcp__nautilo_0__browser_run","functions.mcp__nautilo_1__browser_eval","mcp.nautilo.browser_read"])assert.equal(isBrowserTool(name),true,name);
  assert.equal(isBrowserTool("mcp__firecrawl_scrape"),false);
  const input=JSON.stringify({steps:[{action:"goto",url:"https://www.baidu.com"},{action:"click",target:{name:"bilibili"}}]});
  const outputText=JSON.stringify({steps:[{status:"completed"},{status:"failed",error:{message:"Target missing"}}]});
  const info=browserActivity("mcp__nautilo_0__browser_run",input,outputText);
  assert.match(browserStepLabel(info.steps[0],true),/打开网页.*baidu/);
  const html=require("react-dom/server").renderToStaticMarkup(require("react").createElement(BrowserActivity,{name:"mcp__nautilo_0__browser_run",status:"failed",input,output:outputText,zh:true}));
  assert.match(html,/<svg/);assert.match(html,/点击元素/);assert.doesNotMatch(html,/mcp__nautilo/);
});
