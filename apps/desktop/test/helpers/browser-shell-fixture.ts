import assert from "node:assert/strict";
import { app, BrowserWindow, nativeImage } from "electron";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { TaskBrowser } from "../../src/main/task-browser";
import { registerPanelWindows } from "../../src/main/panel-windows";

app.setPath("userData",__dirname);
app.setPath("sessionData",__dirname);
const phase = (value:string) => writeFileSync(join(__dirname,"phase.txt"),value);
const eventually = async (check:()=>Promise<unknown>) => {
  for (let attempt=0;attempt<45;attempt++) {
    if (await check()) return;
    await wait(50);
  }
  throw Error("Browser condition timed out");
};

void app.whenReady().then(async () => {
  const server = createServer((request,response) => {
    if (request.url === "/disconnect") {
      request.socket.destroy();
      return;
    }
    if (request.url === "/failed") {
      setTimeout(() => response.writeHead(503).end("Unavailable"),30);
      return;
    }
    response.writeHead(200,{"Content-Type":"text/html"}).end(request.url==="/quiet" ? "<title>Quiet</title>" :
      '<title>Shell QA</title><style>#sample{width:180px;height:80px;background:teal}</style><div id="sample">Inspectable element</div><script>function showWarning(){console.warn("fixture warning")}function reportInner(){console.error("fixture error")}function reportOuter(){reportInner()}function raiseInner(){throw new Error("fixture exception")}function raiseOuter(){raiseInner()}showWarning();reportOuter();setTimeout(raiseOuter,0);fetch("/failed");fetch("/disconnect").catch(()=>{});</script>');
  });
  await new Promise<void>((resolve,reject) => server.listen(4173,"127.0.0.1",resolve).once("error",reject));
  const browser = new TaskBrowser();
  await browser.start(() => "shell-fixture");
  browser.register();
  const options = {show:false,webPreferences:{sandbox:true,preload:join(__dirname,"preload.cjs")}};
  const owner = new BrowserWindow(options);
  browser.attachWindow(owner);
  await owner.loadURL("data:text/html,<title>Workbench</title>");
  let host:BrowserWindow|undefined;
  const panels = registerPanelWindows(()=>owner,()=>{
    host=new BrowserWindow(options);
    browser.attachBrowserHost(host);
    return host;
  },win=>win.loadURL("data:text/html,<title>Browser</title>"),(win,target,userInitiated)=>browser.selectBrowserSpace(win,target.sessionId,userInitiated));
  browser.setWindowSpaceCloser(panels.closeBrowserSpace);
  const invoke = (win:BrowserWindow,method:string,...args:unknown[]) => win.webContents.executeJavaScript(`window.bridgeTest.${method}(...${JSON.stringify(args)})`);
  const open = (spaceId:string) => invoke(owner,"open",{kind:"browser",sessionId:spaceId});
  const leases = {x:0,y:0,width:670,height:530};
  const spaceId = "browser-shell-session";
  const base = "http://127.0.0.1:4173";
  phase("loopback probe and thumbnail-free blank window");
  await invoke(owner,"open",{kind:"browser-spaces"});
  const blankId = (await invoke(host!,"spaces","create")).createdId;
  const omnibox = await invoke(host!,"shell","omnibox",{probe:true});
  assert.ok(omnibox.ports.includes(4173));
  const blank = (await invoke(host!,"spaces","list",{previews:true,ids:[blankId]})).spaces.find((space:any)=>space.id===blankId);
  assert.equal(blank.loaded,false);
  assert.equal(blank.preview,undefined);
  await open(spaceId);
  const tabId = (await invoke(host!,"panel",spaceId,"state")).tabId;
  const target = {spaceId,tabId};
  const shell = (command:string,input={}) => invoke(host!,"shell",command,{...target,...input});
  const panel = (command:string,input={}) => invoke(host!,"panel",spaceId,command,{tabId,...input});

  phase("native diagnostics, live read state and overview metadata");
  await panel("open",{url:base});
  await panel("layout",leases);
  await eventually(async () => {
    const {issues} = await shell("state");
    return issues.some((issue:any)=>issue.status===503)
      && issues.some((issue:any)=>issue.kind==="network" && issue.source?.endsWith("/disconnect") && issue.message.startsWith("net::ERR_"));
  });
  let state = await shell("state");
  assert.ok(state.issues.some((issue:any)=>issue.warning && issue.message==="fixture warning"));
  assert.match(state.issues.find((issue:any)=>issue.message==="fixture error")?.stack ?? "",/reportInner[\s\S]+reportOuter/);
  assert.match(state.issues.find((issue:any)=>issue.message.includes("fixture exception"))?.stack ?? "",/raiseInner[\s\S]+raiseOuter/);
  assert.ok(state.issues.some((issue:any)=>issue.status===503 && issue.method==="GET" && issue.duration>=0));
  assert.ok(state.issues.every((issue:any)=>issue.status===undefined || issue.status>=400));
  assert.equal(state.tabs[tabId].loading,false);
  assert.equal(state.tabs[tabId].progress,1);
  assert.ok(state.tabs[tabId].unread>0);
  const cards = (await invoke(host!,"spaces","list")).spaces;
  assert.ok(cards.find((space:any)=>space.id===spaceId && space.loaded && space.errors>0));
  const recent = await invoke(host!,"shell","omnibox",{probe:false});
  assert.ok(recent.tabs.some((tab:any)=>tab.spaceId===spaceId && tab.tabId===tabId));
  assert.ok(recent.history.some((entry:any)=>entry.url===base+"/"));
  await shell("clear",{remove:false});
  assert.equal((await shell("state")).tabs[tabId].unread,0);

  phase("draft routing, viewport PNG and clipped element selection");
  const messageCount = () => owner.webContents.executeJavaScript("window.drafts.size()");
  const latest = () => owner.webContents.executeJavaScript("window.drafts.last()");
  assert.equal(await shell("draft",{issueIds:state.issues.map((issue:any)=>issue.id)}),true);
  await eventually(async()=>await messageCount()===1);
  assert.equal((await latest()).sessionId,spaceId);
  assert.match((await latest()).text,/503/);
  assert.match((await latest()).text,/reportInner[\s\S]+reportOuter/);
  const page = browser["groups"].get(spaceId)!.tabs.get(tabId)!.view.webContents;
  assert.equal(await shell("capture"),true);
  await eventually(async()=>await messageCount()===2);
  const full = (await latest()).attachment.path;
  assert.ok(existsSync(full));
  const size = nativeImage.createFromPath(full).getSize();
  assert.ok(size.width>500);
  const selection = shell("pick",{mode:"element"});
  await eventually(()=>page.executeJavaScript('!!document.querySelector("[data-nautilo-pointer=picker]")'));
  page.sendInputEvent({type:"mouseMove",x:40,y:30});
  page.sendInputEvent({type:"mouseDown",x:40,y:30,button:"left",clickCount:1});
  page.sendInputEvent({type:"mouseUp",x:40,y:30,button:"left",clickCount:1});
  assert.equal(await selection,true);
  await eventually(async()=>await messageCount()===3);
  const picked = await latest();
  assert.match(picked.element.selector,/#sample/);
  assert.equal(picked.element.dimensions,"180 × 80");
  assert.equal(picked.element.screenshotPath,picked.attachment.path);
  assert.ok(nativeImage.createFromPath(picked.attachment.path).getSize().width<size.width);
  assert.equal(await page.executeJavaScript('!!document.querySelector("[data-nautilo-pointer=picker]")'),false);
  const captureRegion = shell("pick",{mode:"region"});
  await eventually(()=>page.executeJavaScript('!!document.querySelector("[data-nautilo-pointer=picker]")'));
  page.sendInputEvent({type:"mouseDown",x:20,y:25,button:"left",clickCount:1});
  page.sendInputEvent({type:"mouseMove",x:145,y:110});
  page.sendInputEvent({type:"mouseUp",x:145,y:110,button:"left",clickCount:1});
  assert.equal(await captureRegion,true);
  await eventually(async()=>await messageCount()===4);
  assert.ok(nativeImage.createFromPath((await latest()).attachment.path).getSize().width<size.width);
  const cancelled = shell("pick",{mode:"element"});
  await eventually(()=>page.executeJavaScript('!!document.querySelector("[data-nautilo-pointer=picker]")'));
  page.sendInputEvent({type:"keyDown",keyCode:"Escape"});
  assert.equal(await cancelled,false);
  assert.equal(await messageCount(),4);

  phase("real device size, pin, refresh, diagnostics reset and cleanup");
  const originalWidth = await page.executeJavaScript("innerWidth");
  await shell("viewport",{device:{width:390,height:844,scale:.6}});
  assert.equal(await page.executeJavaScript("innerWidth"),390);
  assert.equal(await page.executeJavaScript("innerHeight"),844);
  await shell("viewport",{device:null});
  await eventually(async()=>await page.executeJavaScript("innerWidth")===originalWidth);
  await shell("pin",{pinned:true});
  await eventually(async()=>host!.isAlwaysOnTop());
  await shell("pin",{pinned:false});
  assert.equal(host!.isAlwaysOnTop(),false);
  const navigation = new Promise<void>(resolve=>page.once("did-finish-load",()=>resolve()));
  await shell("reload",{mode:"hard"});
  await navigation;
  await eventually(async()=> (await shell("state")).issues.some((issue:any)=>issue.status===503));
  // The bounded log drops older rows and keeps new ones in chronological order.
  await page.executeJavaScript('for (let i=0; i<56; i++) console.warn("numbered "+i)');
  await eventually(async()=>{
    state=await shell("state");
    return state.issues.length===50 && state.issues.at(-1).message==="numbered 55";
  });
  await panel("open",{url:base+"/quiet"});
  const afterNavigation = (await shell("state")).issues;
  assert.ok(afterNavigation.every((issue:any)=>!issue.message.startsWith("numbered ")),JSON.stringify(afterNavigation));
  const blankContent = browser["groups"].get(blankId)!.tabs.values().next().value!.view.webContents;
  assert.deepEqual(await shell("close",{ids:[spaceId,blankId],blankOnly:true}),[blankId]);
  assert.ok(blankContent.isDestroyed());
  assert.equal(page.isDestroyed(),false);
  await shell("locate");
  await eventually(async()=>await messageCount()===5);
  assert.deepEqual(await latest(),{sessionId:spaceId});
  phase("open and close the native DevTools frontend");
  await shell("devtools");
  await eventually(async()=>!!page.devToolsWebContents?.getURL().startsWith("devtools://"));
  const devTools = page.devToolsWebContents!;
  await eventually(async()=>!!BrowserWindow.fromWebContents(devTools)?.isVisible());
  await shell("devtools");
  await eventually(async()=>devTools.isDestroyed());
  assert.deepEqual(await shell("close",{ids:[spaceId]}),[spaceId]);
  assert.ok(page.isDestroyed());
  await browser.close();
  server.close();
  app.exit(0);
}).catch(error=> {
  writeFileSync(join(__dirname,"shell-error.txt"),error.stack ?? String(error));
  app.exit(1);
});
