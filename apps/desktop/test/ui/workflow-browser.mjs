/** Real Chromium behavior checks against the isolated workflow Vite fixture.
 * Set CHROME_PATH if Chrome is installed elsewhere. No real daemon is used.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve, sep } from "node:path";
const origin=process.env.NAUTILO_WORKFLOW_QA_URL || "http://127.0.0.1:4186/workflow-visual.html";
if(!["127.0.0.1","localhost"].includes(new URL(origin).hostname)) throw new Error("Workflow fixture checks must run on localhost");
const profile=await mkdtemp(joinPath(tmpdir(),"nautilo-workflow-chrome-"));
const executable=[process.env.CHROME_PATH,"C:/Program Files/Google/Chrome/Application/chrome.exe","/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser","/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(file=>file&&existsSync(file));
if(!executable)throw new Error("Set CHROME_PATH to a local Chrome/Chromium executable for workflow UI checks");
const benchmark=process.env.NAUTILO_WORKFLOW_QA_PERF==="1";
const chrome=spawn(executable,["--headless=new",...(benchmark?[]:["--disable-gpu"]),"--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
let socket;const errors=[];
try {
  const endpoint=await new Promise((resolve,reject)=>{
    let stderr="";const timer=setTimeout(()=>reject(new Error("Chrome did not start")),15000);
    chrome.once("error",reject);chrome.stderr.on("data",data=>{stderr+=data;const match=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  let nextId=0;const pending=new Map();
  socket.addEventListener("message",event=>{
    const message=JSON.parse(event.data);
    if(message.id){const item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}}
    if(message.method==="Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
  const {targetId}=await send("Target.createTarget",{url:"about:blank"});const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
  const command=(method,params)=>send(method,params,sessionId);
  await command("Runtime.enable");await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride",{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  const evaluate=async expression=>{
    const result=await command("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const screenshot=async name=>{if(!process.env.NAUTILO_WORKFLOW_QA_SHOTS)return;await mkdir(process.env.NAUTILO_WORKFLOW_QA_SHOTS,{recursive:true});const layout=await evaluate(`(() => {const d=document.querySelector('[role="dialog"]');if(!d)return null;const r=d.getBoundingClientRect(),s=getComputedStyle(d);return {position:s.position,display:s.display,opacity:s.opacity,zIndex:s.zIndex,translate:s.translate,transform:s.transform,rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},center:document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2).slice(0,3).map(e=>({tag:e.tagName,className:e.className}))};})()`);await writeFile(joinPath(process.env.NAUTILO_WORKFLOW_QA_SHOTS,name+".layout.json"),JSON.stringify(layout,null,2));const {data}=await command("Page.captureScreenshot",{captureBeyondViewport:false});await writeFile(joinPath(process.env.NAUTILO_WORKFLOW_QA_SHOTS,name+".png"),Buffer.from(data,"base64"));};
  const until=async(expression,label)=>{
    for(let i=0;i<100;i++){if(await evaluate(`!!(${expression})`))return;await wait(50);}
    const visible=await evaluate("document.body.innerText.slice(0,800)");
    throw new Error(`Timed out waiting for ${label}\n${visible}\n${errors.slice(-2).join("\n")}`);
  };
  const navigate=async query=>{await command("Page.navigate",{url:origin+query});await until("document.querySelectorAll('.wf-node').length >= 3","workflow nodes");await wait(100);};
  const center=async selector=>{
    const point=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing target');element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    return point;
  };
  const clickAt=async(point,button="left")=>{
    await command("Input.dispatchMouseEvent",{type:"mousePressed",...point,button,clickCount:1});
    await command("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button,clickCount:1});
    await wait(40);
  };
  const click=async selector=>clickAt(await center(selector));
  const hover=async selector=>{
    await command("Input.dispatchMouseEvent",{type:"mouseMoved",...await center(selector)});
  };
  const isAnimating=(name)=>`document.getAnimations().some(animation => animation.animationName === ${JSON.stringify(name)} && animation.playState === 'running')`;
  const mediaMotion=async value=>command("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value}]});
  const drag=async(from,to)=>{
    await command("Input.dispatchMouseEvent",{type:"mousePressed",...from,button:"left",clickCount:1});
    for (const progress of [.25,.5,.75,1]) {
      await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x+(to.x-from.x)*progress,y:from.y+(to.y-from.y)*progress,button:"left",buttons:1});
    }
    await command("Input.dispatchMouseEvent",{type:"mouseReleased",...to,button:"left",clickCount:1});
    await wait(70);
  };
  const wireAt=async name=>evaluate(`(()=>{const wire=Array.from(document.querySelectorAll('.wf-wire-hit')).find(el=>el.getAttribute('aria-label')===${JSON.stringify("连线 "+name)});if(!wire)throw new Error('Missing wire '+${JSON.stringify(name)});const p=wire.getPointAtLength(wire.getTotalLength()*.5).matrixTransform(wire.getScreenCTM());return{x:p.x,y:p.y}})()`);
  const menuAction=async label=>{
    const point=await evaluate(`(()=>{const item=Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>el.querySelector('span').textContent===${JSON.stringify(label)});if(!item)throw new Error('Missing menu action '+${JSON.stringify(label)});const r=item.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await clickAt(point);
  };
  const insertNode=async(wire,kind)=>{
    await clickAt(await wireAt(wire),"right");
    await menuAction("插入节点");
    await menuAction(kind);
  };
  await navigate("?template=investigate");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.wf-header-actions button')).some(button=>button.textContent.trim()==='运行')"),false);
  const setValue=async(selector,value)=>{
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Missing field '+${JSON.stringify(selector)});input.focus();const prototype=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(String(value))});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);await wait(50);
  };
  const saveDraft=async()=>{await evaluate("Array.from(document.querySelectorAll('.wf-header-actions button')).find(button=>button.textContent.includes('保存')).click()");await wait(75);return evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.save').at(-1)?.input.definition");};
  const opener='[aria-label="打开流程 并行定位与交叉验证"]', second='[aria-label="打开流程 独立复核"]';
  await until("document.querySelectorAll('.wf-library-item').length===2","saved graphs");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.wf-library-item')).map(item=>item.querySelectorAll('.wf-thumbnail-wire').length)"),[9,2]);
  await setValue('[aria-label="流程名称"]','待保存的修改');
  await click(second);
  await until("document.querySelector('[data-node-id=\"child-review\"]')","library workflow switch");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(second)}).getAttribute('aria-current')`),"true");
  await click(opener);
  assert.equal(await evaluate("document.querySelector('.wf-title-input').value"),"待保存的修改");
  await setValue('[aria-label="流程名称"]','并行定位与交叉验证');
  await click('[aria-label="放大"]');
  const viewBeforeCollapse=await evaluate(`(() => {
    const canvas = document.querySelector('.wf-canvas');
    const world = new DOMMatrix(getComputedStyle(canvas.querySelector('.wf-world')).transform);
    return { width: canvas.clientWidth, zoom: world.a, x: (canvas.clientWidth / 2 - world.e) / world.a };
  })()`);
  await click('[aria-label="收起流程库"]');
  await until("document.querySelector('.wf-library-list').hidden && document.querySelector('.wf-canvas').clientWidth > "+viewBeforeCollapse.width,"expanded canvas");
  const viewAfterCollapse=await evaluate(`(() => {
    const canvas = document.querySelector('.wf-canvas');
    const world = new DOMMatrix(getComputedStyle(canvas.querySelector('.wf-world')).transform);
    return { zoom: world.a, x: (canvas.clientWidth / 2 - world.e) / world.a };
  })()`);
  assert.equal(viewAfterCollapse.zoom,viewBeforeCollapse.zoom);
  assert(Math.abs(viewAfterCollapse.x-viewBeforeCollapse.x)<1);
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"),"展开流程库");
  await click('[aria-label="展开流程库"]');
  await click('[aria-label="适应画布"]');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wf-canvas')).backgroundColor"),"rgb(248, 249, 251)");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wf-canvas')).backgroundSize"),"20px 20px");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-node-id=judge] .wf-node-plate')).backgroundColor"),"rgb(255, 255, 255)");
  assert.equal(await evaluate("document.querySelector('[data-node-id=judge]').dataset.selected"),"false");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-node-id=judge] .wf-port-new')).opacity"),"0");
  await hover('[data-node-id="join"] .wf-node-body');
  await until("getComputedStyle(document.querySelector('[data-node-id=join] .wf-node-plate')).translate === '0px -2px'","hover lift");
  assert.equal(await evaluate("document.querySelectorAll('.wf-wire-row[data-focus=near]').length"),3);
  await until("[...document.querySelectorAll('.wf-wire-row[data-focus=far], .wf-wire-caption[data-focus=far]')].every(row => getComputedStyle(row).opacity === '0.4')","path and caption focus");
  for (const id of ["main","judge"]) {
    const nodeSelector=`[data-node-id="${id}"]`;
    await hover(`${nodeSelector} .wf-node-body`);
    await until(`getComputedStyle(document.querySelector(${JSON.stringify(nodeSelector+" .wf-port-new")})).opacity === '1'`,"in-card add button");
    const safe=await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(nodeSelector)});
      const card = node.getBoundingClientRect();
      const button = node.querySelector('.wf-port-new').getBoundingClientRect();
      if (button.right >= card.right || button.top <= card.top || button.left <= card.left || button.bottom >= card.bottom) return false;
      const labels = [...document.querySelectorAll('.wf-edge-label')].map(label => label.getBoundingClientRect());
      if (labels.some(label => label.left < button.right && label.right > button.left && label.top < button.bottom && label.bottom > button.top)) return false;
      const paths = [...document.querySelectorAll('.wf-wire-row')].filter(row => JSON.parse(row.dataset.wireKey)[0] === node.dataset.nodeId).map(row => row.querySelector('.wf-wire'));
      return paths.every(path => {
        const length = path.getTotalLength();
        const matrix = path.getScreenCTM();
        return Array.from({length:97}, (_, index) => path.getPointAtLength(length * index / 96).matrixTransform(matrix)).every(p =>
          p.x < button.left || p.x > button.right || p.y < button.top || p.y > button.bottom);
      });
    })()`);
    assert.equal(safe,true,`${id} add button clears outgoing curves and labels`);
  }
  const labelsStayByCurves=await evaluate(`(() => {
    const wires = [...document.querySelectorAll('.wf-wire-row')].filter(row => JSON.parse(row.dataset.wireKey)[0] === 'main');
    return wires.every(row => {
      const path = row.querySelector('.wf-wire');
      const label = [...document.querySelectorAll('.wf-edge-label')].find(element => element.dataset.labelKey === row.dataset.wireKey);
      const rect = label.getBoundingClientRect();
      const matrix = path.getScreenCTM();
      const length = path.getTotalLength();
      const points = Array.from({length:65}, (_, index) => path.getPointAtLength(length * index / 64).matrixTransform(matrix));
      return points.some(point => Math.hypot(point.x - rect.left - rect.width / 2, point.y - rect.top - rect.height / 2) < 20);
    });
  })()`);
  assert.equal(labelsStayByCurves,true,"parallel outlet labels stay beside their curves");
  await hover('.wf-title-input');
  await evaluate("[...document.querySelectorAll('[data-node-id=judge] .wf-port')].at(-1).focus()");
  await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
  await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
  assert.equal(await evaluate("document.activeElement.classList.contains('wf-port-new')"),true);
  await until("getComputedStyle(document.activeElement).opacity === '1'","keyboard reveals the add button");
  assert.equal(await evaluate("document.querySelectorAll('.wf-wire-row[data-loop=true]').length"),3);
  const limitApproach=await evaluate(`(() => {
    const path = document.querySelector('.wf-wire-row[data-limit=true] .wf-wire');
    const length = path.getTotalLength();
    const end = path.getPointAtLength(length);
    const near = path.getPointAtLength(length - 4);
    const points = Array.from({length:161}, (_, index) => path.getPointAtLength(length * index / 160));
    return { tail: Math.max(...points.map(point => point.x)) - end.x, vertical: Math.abs(end.x - near.x) < .1 && near.y > end.y };
  })()`);
  assert(limitApproach.tail<.1 && limitApproach.vertical,"right-hand limit route arrives from below without a spur");
  await click('[data-node-id="judge"] .wf-node-body');
  assert.equal(await evaluate("document.querySelector('.wf-node-name').value"),"综合判断");
  const stagger=await evaluate("document.getAnimations().filter(a=>a.effect?.target?.closest('.wf-inspector') && a.effect.getKeyframes().some(frame=>frame.translate?.endsWith(' 5px'))).map(a=>a.effect.getTiming().delay)");
  assert(stagger.length>=3 && new Set(stagger).size>=3,"node properties enter with staggered timings");
  await until("getComputedStyle(document.querySelector('[data-node-id=judge] .wf-node-plate')).borderColor === 'rgb(79, 70, 229)'","selected node outline");
  assert.equal(await evaluate("document.querySelectorAll('.wf-wire-row[data-outgoing=true]').length"),2);
  assert.equal(await evaluate("document.querySelector('.wf-prompt-read code').textContent"),"{{incoming}}");
  await hover('.wf-title-input');
  await command("Emulation.setDeviceMetricsOverride",{width:1680,height:1000,deviceScaleFactor:1,mobile:false});
  await click('[aria-label="适应画布"]');
  await screenshot("workflow-editor-light");
  await navigate("?template=investigate&theme=dark");
  await click('[data-node-id="judge"] .wf-node-body');
  await hover('.wf-title-input');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wf-canvas')).backgroundColor"),"rgb(13, 14, 17)");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wf-library')).backgroundColor"),"rgb(18, 19, 24)");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-node-id=judge] .wf-node-plate')).backgroundColor"),"rgb(24, 26, 32)");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-node-id=judge] small')).color"),"rgb(138, 143, 152)");
  await screenshot("workflow-editor-dark");
  await command("Emulation.setDeviceMetricsOverride",{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await navigate("?template=investigate");
  console.log("PASS both themes, role accents, real selection, label clearance, rounded limit route, collapsible library and preserved viewport");

  const magneticSource=await center('[data-node-id="main"] [data-outlet-id="a"]');
  await hover('[data-node-id="main"] [data-outlet-id="a"]');
  await until("getComputedStyle(document.querySelector('[data-node-id=main] [data-outlet-id=a] .wf-port-face')).scale === '1.35'","port hover grows without moving its hit area");
  const magneticTarget=await evaluate("(() => {const r=document.querySelector('[data-node-id=b]').getBoundingClientRect();return {x:r.left-7,y:r.top+r.height/2};})()");
  await command("Input.dispatchMouseEvent",{type:"mousePressed",...magneticSource,button:"left",clickCount:1});
  await command("Input.dispatchMouseEvent",{type:"mouseMoved",...magneticTarget,button:"left",buttons:1});
  await until("document.querySelector('[data-node-id=b][data-drop-target=true] .wf-input-magnet')","link snaps near the input port");
  await command("Input.dispatchMouseEvent",{type:"mouseReleased",...magneticTarget,button:"left",clickCount:1});
  await until("document.querySelector('.wf-edge-inspector dl')?.textContent.includes('终点时序探索')","dropping within the magnetic radius reconnects the edge");
  await click('[aria-label="撤销"]');
  console.log("PASS editing lift, focus, staggered fields and magnetic ports with undo");

  await click('[aria-label="新建流程"]');
  assert.equal(await evaluate("document.querySelectorAll('.wf-node').length"),1);
  await hover('[data-node-id="main"] .wf-node-body');
  const newStart=await center('[data-node-id="main"] .wf-port-new');
  await drag(newStart,{x:newStart.x+135,y:newStart.y-30});
  await menuAction("Agent");
  const newAgent='[data-node-id^="agent-"]';
  await until(`document.querySelector('${newAgent}') && document.querySelectorAll('.wf-wire-hit').length===1`,"creating and connecting the next node");
  const newEnd=await center(`${newAgent} .wf-port`);
  await drag(newEnd,{x:newEnd.x-60,y:newEnd.y+105});
  await menuAction("交回主会话");
  await setValue('[aria-label="流程名称"]','新工作流');
  const created=await saveDraft();
  assert.equal(created.name,"新工作流");assert.equal(created.edges.length,2);
  assert.equal(created.edges[0].to,created.nodes[1].id);assert.equal(created.edges[1].to,"$return");
  await until("document.querySelectorAll('.wf-library-item').length===3","saved draft added to the library");
  await click(opener);
  console.log("PASS drag to blank creates a connected step and the new workflow saves");

  const originalPath=await evaluate("Array.from(document.querySelectorAll('.wf-wire-hit')).find(el=>el.getAttribute('aria-label')==='连线 已定位').getAttribute('d')");
  const bend=await wireAt("已定位");
  await drag(bend,{x:bend.x-5,y:bend.y-69});
  assert.notEqual(await evaluate("Array.from(document.querySelectorAll('.wf-wire-hit')).find(el=>el.getAttribute('aria-label')==='连线 已定位').getAttribute('d')"),originalPath);
  const bent=await saveDraft();
  assert.equal(bent.edges.find(edge=>edge.from[0]==="judge" && edge.from[1]==="done").to,"$return");
  const storedBend=await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.save').at(-1).input.layout.edgeRoutes[JSON.stringify(['judge','done',false])]");
  assert(Number.isFinite(storedBend.x)&&Number.isFinite(storedBend.y));
  await click('[aria-label="撤销"]');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.wf-wire-hit')).find(el=>el.getAttribute('aria-label')==='连线 已定位').getAttribute('d')"),originalPath);
  await clickAt(await wireAt("已定位"));
  const wireEnd=await center('[aria-label="改接 已定位"]');
  const reviewNode=await center('[data-node-id="verify"] .wf-node-body');
  assert.equal(await evaluate(`document.elementFromPoint(${wireEnd.x},${wireEnd.y})?.getAttribute('aria-label')`),"改接 已定位",await evaluate(`JSON.stringify({point:${JSON.stringify(wireEnd)},hits:document.elementsFromPoint(${wireEnd.x},${wireEnd.y}).slice(0,6).map(el=>el.getAttribute('class')),rect:document.querySelector('.wf-wire-end').getBoundingClientRect()})`));
  assert.equal(await evaluate(`document.elementFromPoint(${reviewNode.x},${reviewNode.y})?.closest('[data-node-id]')?.dataset.nodeId`),"verify","the drop target must be on the canvas");
  await drag(wireEnd,reviewNode);
  assert.match(await evaluate("document.querySelector('.wf-edge-inspector dl').textContent"),/终点独立复核/);
  await click('[aria-label="撤销"]');
  assert.match(await evaluate("document.querySelector('.wf-edge-inspector dl').textContent"),/终点交回主会话/);
  console.log("PASS drag and save a wire bend, reconnect by endpoint and undo both edits");

  await clickAt(await wireAt("已定位"),"right");await menuAction("删除连线");
  const savesBeforeInvalidGraph=await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.save').length");
  await saveDraft();
  assert.equal(await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.save').length"),savesBeforeInvalidGraph);
  assert.match(await evaluate("document.querySelector('.wf-issue-list').textContent"),/「综合判断」的「已定位」还没连线/);
  await screenshot("workflow-editor-missing-wire");
  await click(".wf-issue-list li button");
  await until("document.activeElement?.dataset.outletId==='done' && document.activeElement?.closest('[data-node-id]')?.dataset.nodeId==='judge'","focus on the exact missing outlet");
  assert.equal(await evaluate("document.activeElement.dataset.issue"),"true");
  await click('[aria-label="适应画布"]');
  await drag(await center('[data-node-id="judge"] [data-outlet-id="done"]'),await center('[data-node-id="verify"] .wf-node-body'));
  assert.equal(await evaluate("!!document.querySelector('[data-node-id=\"judge\"] [data-outlet-id=\"done\"][data-issue=\"true\"]')"),false);
  assert.match(await evaluate("document.querySelector('.wf-edge-inspector dl').textContent"),/终点独立复核/);
  await click('[aria-label="撤销"]');await click('[aria-label="撤销"]');
  await clickAt(await center('[data-node-id="verify"] .wf-node-body'),"right");await menuAction("删除节点");
  assert.equal(await evaluate("document.querySelector('[data-node-id=\"verify\"]')!==null"),false);
  await click('[aria-label="撤销"]');
  assert.equal(await evaluate("document.querySelector('[data-node-id=\"verify\"]')!==null"),true);
  await clickAt(await wireAt("已定位"));
  await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Delete",code:"Delete",windowsVirtualKeyCode:46});
  await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Delete",code:"Delete",windowsVirtualKeyCode:46});
  await until("!document.querySelector('.wf-wire-hit[aria-label=\"连线 已定位\"]')","Delete removes the selected wire");
  await click('[aria-label="撤销"]');
  assert(await wireAt("已定位"));
  console.log("PASS right-click delete, exact Chinese missing-wire guidance and drag to repair");

  await evaluate("localStorage.removeItem('nautilo.workflow.draft.investigate')");await navigate("?template=investigate");
  const node='[data-node-id="a"]';const before=await evaluate(`document.querySelector(${JSON.stringify(node)}).style.left`);
  const point=await evaluate(`(()=>{const r=document.querySelector('${node} .wf-node-body').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await command("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",clickCount:1});
  await command("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x+80,y:point.y+35,button:"left",buttons:1});
  await command("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x+80,y:point.y+35,button:"left",clickCount:1});await wait(70);
  const moved=await evaluate(`document.querySelector(${JSON.stringify(node)}).style.left`);assert.notEqual(moved,before);
  await click('[aria-label="撤销"]');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(node)}).style.left`),before);
  await click('[aria-label="重做"]');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(node)}).style.left`),moved);
  console.log("PASS pointer drag and undo/redo preserve graph position");
  await click(`${node} .wf-node-body`);
  await command("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await command("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});await wait(70);
  assert.equal(parseFloat(await evaluate(`document.querySelector(${JSON.stringify(node)}).style.left`)),parseFloat(moved)+4);
  await click('[aria-label="撤销"]');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(node)}).style.left`),moved);
  console.log("PASS keyboard movement creates one undoable edit");
  await click('[data-node-id="main"] .wf-port');await click('[data-node-id="b"] .wf-node-body');
  await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('流程定义')).click()");await until("document.querySelector('.wf-json-editor')","graph JSON dialog");
  const graph=JSON.parse(await evaluate("document.querySelector('.wf-json-editor').value"));assert.equal(graph.edges[0].to,"b");
  console.log("PASS connecting a named outlet changes the shared definition");
  await evaluate("localStorage.removeItem('nautilo.workflow.draft.investigate')");await navigate("?template=investigate");
  await setValue('[aria-label="选择节点"]','join');
  await setValue('.wf-control-fields label:nth-child(3) select','nodes');
  await setValue('.wf-control-fields label:first-child select','quorum');
  await setValue('[aria-label="汇合所需份数"]',2);
  await setValue('.wf-control-fields label:last-of-type select','cancel');
  let edited=await saveDraft();const join=edited.nodes.find(node=>node.id==='join');
  assert.deepEqual(join.sources,['a','b']);assert.equal(join.quorum,2);assert.equal(join.remaining,'cancel');
  assert.equal(await evaluate("document.querySelectorAll('.wf-source-chips span').length"),2);
  console.log("PASS join controls publish explicit sources, quorum and cancellation policy");
  await setValue('[aria-label="选择节点"]','a');await click('.wf-advanced-fields summary');await click('.wf-toggle-field input');
  await setValue('[aria-label="派发列表来源"]','incoming.result.items');await setValue('[aria-label="列表项唯一标识"]','key');
  edited=await saveDraft();assert.equal(edited.nodes.find(node=>node.id==='a').forEach.key,'key');
  console.log("PASS per-item dispatch controls persist the stable item key");
  await click('.wf-workspace-fields summary');await setValue('[aria-label="节点工作区策略"]','isolated');
  await setValue('[aria-label="节点允许修改的路径"]','src/**\ntests/**');await click('.wf-node-name');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"验收项 项目必需检查\"]').disabled"),true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"验收项 界面检查\"]').checked"),true);
  await setValue('[aria-label="节点验收规则"]','custom');
  await click('[aria-label="验收项 界面检查"]');
  edited=await saveDraft();const workspace=edited.nodes.find(node=>node.id==='a').workspace;
  assert.equal(workspace.mode,'isolated');assert.deepEqual(workspace.allowedPaths,['src/**','tests/**']);
  assert.deepEqual(workspace.verificationTemplates,['optional-check']);
  console.log("PASS workspace controls retain path scope and mandatory project verification");
  await insertNode("已定位","分发");
  edited=await saveDraft();const split=edited.nodes.find(node=>node.kind==='dispatch');
  assert(split);assert.equal(split.dispatch,'all');assert(split.exits.length>0);
  assert.equal(await evaluate("document.querySelector('.wf-control-description').textContent.includes('自动')"),true);
  console.log("PASS automatic distribution is editable without creating an extra Agent turn");
  await insertNode("完成","子流程");
  await setValue('.wf-control-fields > label:first-child select','qa-child@1');
  await setValue('[aria-label="子流程输入映射"]',JSON.stringify({question:'{{input.question}}'}));await click('.wf-node-name');
  edited=await saveDraft();const call=edited.nodes.find(node=>node.kind==='call');
  assert.deepEqual(call.ref,{id:'qa-child',revision:1});assert.equal(call.input.question,'{{input.question}}');assert(Object.keys(call.exitMap).length>0);
  console.log("PASS pinned subworkflow controls preserve input and named return mapping");
  await insertNode("需要复核","条件判断");await click('.wf-control-fields .wf-add-exit');
  const savesBefore=await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.save').length");
  await setValue('[aria-label="条件 1 等于"]','{');await click('.wf-node-name');await saveDraft();
  assert.equal(await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.save').length"),savesBefore);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"条件 1 等于\"]').checkValidity()"),false);
  await setValue('[aria-label="条件 1 等于"]','false');await click('.wf-node-name');
  edited=await saveDraft();assert.equal(edited.nodes.find(node=>node.kind==='condition').cases[0].equals,false);
  console.log("PASS invalid condition JSON blocks save until its actual value is corrected");
  await navigate("?template=investigate&run=parallel");
  assert.equal(await evaluate("document.querySelectorAll('.is-active > .wf-wire').length"),2);
  assert.equal(await evaluate("document.querySelectorAll('.wf-stream').length > 0"),true);
  const phase=await evaluate("document.getAnimations().filter(a=>a.effect?.target?.classList.contains('wf-stream')).map(a=>a.currentTime)");assert.equal(phase.length,2);
  await wait(180);const nextPhase=await evaluate("document.getAnimations().filter(a=>a.effect?.target?.classList.contains('wf-stream')).map(a=>a.currentTime)");assert(nextPhase.every((time,index)=>time>phase[index]));
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wf-node-beam')).paddingTop"),"1.5px");
  assert.equal(await evaluate(isAnimating("wf-beam-spin")),true);
  console.log("PASS parallel execution continuously animates its two active paths");
  await navigate("?run=motion-live&theme=dark");
  await evaluate("window.workflowQa.advanceRunSnapshot('motion-live','review')");
  await until(isAnimating("wf-join-ripple"),"new engine join completion animates once");
  assert.equal(await evaluate(isAnimating("wf-pass-flash")),true);
  assert.equal(await evaluate(isAnimating("wf-dash-flow")),true);
  assert.equal(await evaluate("document.querySelector('[data-node-id=verify]').dataset.motionState"),"looping");
  await wait(1650);
  assert.equal(await evaluate(isAnimating("wf-join-ripple")),false);
  await mediaMotion("reduce");
  await until("document.querySelector('.wf-canvas').dataset.motionReduced === 'true' && !document.querySelector('.wf-stream, .wf-node-beam')","system reduced motion cancels live motion");
  assert.equal(await evaluate(isAnimating("wf-dash-flow")),false);
  assert.equal(await evaluate("document.querySelector('[data-node-id=verify]').dataset.motionState"),"looping");
  assert.equal(await evaluate("document.querySelectorAll('.wf-wire-row.is-active[data-loop=true]').length"),1);
  await mediaMotion("no-preference");
  await until(isAnimating("wf-dash-flow"),"motion resumes when system preference changes");
  console.log("PASS engine events trigger one join wave and success flash, and the system motion preference updates live");
  await navigate("?run=legacy-plan");
  await until("document.querySelectorAll('.wf-node').length > 5","compiled legacy task graph");
  assert.equal(await evaluate("document.querySelector('.wf-canvas').textContent.includes('分发')"),true);
  assert.equal(await evaluate("document.querySelector('.wf-canvas').textContent.includes('等待依赖')"),true);
  assert.equal(await evaluate("document.querySelectorAll('.wf-node[data-status=\"ready\"]').length"),2);
  console.log("PASS compiled task dependencies render shared distribution and only ready consumers");
  await navigate("?run=task-plan-adopted");
  await setValue('[aria-label="选择节点"]',await evaluate("Array.from(document.querySelector('[aria-label=\"选择节点\"]').options).find(option=>option.textContent==='write').value"));
  await until("document.querySelector('.wf-workspace-node[data-stage=\"passed\"]')","adopted task acceptance evidence");
  assert.equal(await evaluate("document.querySelector('.wf-prompt-read').textContent"),"Investigate write");
  assert.equal(await evaluate("document.querySelector('.wf-dispatch-prompt pre').textContent.includes('[AGENTHUB_DELEGATED_TASK]')"),true);
  await screenshot("task-plan-adopted-light");
  await click('.wf-workspace-node .wf-evidence-button');
  await until("document.querySelector('.wf-change-review')","original task artifact");
  assert.equal(await evaluate("window.workflowQa.calls.filter(call=>call.method==='artifact.list').at(-1).input.projectRunId"),"team-run");
  assert.equal(await evaluate("document.querySelector('.wf-change-review').textContent.includes('written base.txt')"),true);
  await until("document.querySelector('[role=\"dialog\"]') && Number(getComputedStyle(document.querySelector('[role=\"dialog\"]')).opacity) > .99","visible saved diff dialog");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[role=\"dialog\"]')).position"),"fixed");
  assert.equal(await evaluate("(() => {const dialog=document.querySelector('[role=\"dialog\"]'),r=dialog.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&!!hit&&dialog.contains(hit);})()"),true);
  await screenshot("task-plan-diff-light");
  console.log("PASS adopted task evidence opens its saved diff through the original project-run owner");
  await navigate("?template=investigate&run=review&theme=dark");
  await click('[aria-label="播放执行记录"]');await wait(1550);await click('[aria-label="暂停回放"]');
  const frozen=await evaluate("document.querySelector('[aria-label=\"定位执行事件\"]').value");await wait(850);assert.equal(await evaluate("document.querySelector('[aria-label=\"定位执行事件\"]').value"),frozen);
  assert.equal(await evaluate("document.querySelector('.wf-primary')?.textContent?.includes('开始执行') || false"),false);
  assert.equal(await evaluate("document.querySelector('.wf-header-actions').textContent.includes('暂停调度')"),true);
  console.log("PASS historical playback pauses without pausing the scheduler");
  await navigate("?template=investigate&run=reminder");await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('会话消息')).click()");
  await until("document.querySelector('.wf-messages')","durable reminder details");assert(await evaluate("document.querySelector('.wf-messages').textContent.includes('原子 Agent')"));
  console.log("PASS reminder details identify the child recipient and queued message");
  await navigate("?run=workspace-merge");
  await until("document.querySelector('.wf-workspace-run[data-stage=\"waiting_merge\"]')","actual verified merge review");
  assert.equal(await evaluate("document.querySelector('.wf-header-actions').textContent.includes('暂停调度')"),false);
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"停止流程\"]')"),true);
  await screenshot("merge-review-light");
  await click('.wf-workspace-run .wf-evidence-button');
  await until("document.querySelector('.wf-change-review')","persisted Git diff");
  assert.equal(await evaluate("document.querySelector('.wf-change-review').textContent.includes('written base.txt')"),true);
  await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await wait(250);
  await evaluate("Array.from(document.querySelectorAll('.wf-workspace-run .wf-workspace-actions button')).find(button=>button.textContent==='保留成果').click()");
  await until("document.querySelector('.wf-workspace-run[data-stage=\"retained\"]')","retained workflow result");
  assert.equal(await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.control').at(-1).input.action"),"reject_merge");
  console.log("PASS final acceptance shows saved diffs and sends an explicit retain decision");
  await navigate("?run=workspace-commands");
  await until("document.querySelector('.wf-workspace-node .wf-command-review .wf-primary:not(:disabled)')","concrete verification approval");
  assert.equal(await evaluate("document.querySelector('.wf-command-review').textContent.includes('task-check.log')"),true);
  assert.equal(await evaluate("document.querySelector('.wf-prompt-read').textContent.includes('[NAUTILO_WORKFLOW_NODE]')"),false);
  assert.equal(await evaluate("document.querySelector('.wf-dispatch-prompt pre').textContent.includes('[NAUTILO_WORKFLOW_NODE]')"),true);
  await evaluate("document.querySelector('.wf-workspace-node').scrollIntoView({block:'center'})");
  await screenshot("verification-approval-light");
  const approvedInstance=await evaluate("document.querySelector('[aria-label=\"选择节点执行实例\"]')?.value");
  await click('.wf-workspace-node .wf-command-review .wf-primary');
  const approval=await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.control').at(-1).input");
  assert.equal(approval.action,"approve_verification");assert.equal(typeof approval.instanceId,"string");
  if(approvedInstance)assert.equal(approval.instanceId,approvedInstance);
  await setValue('[aria-label="定位执行事件"]',await evaluate("document.querySelector('[aria-label=\"定位执行事件\"]').max"));
  assert.equal(await evaluate("document.querySelectorAll('.wf-command-review .wf-primary').length"),0);
  console.log("PASS command approval includes the exact instance and history cannot approve live work");
  await navigate("?template=investigate&run=parallel&reduceMotion=1");assert.equal(await evaluate("document.getAnimations().filter(a=>a.effect?.target?.classList.contains('wf-stream')).length"),0);
  assert.equal(await evaluate("document.querySelectorAll('.is-active > .wf-wire').length"),2);
  console.log("PASS reduced motion retains explicit active routes without animation");
  await command("Emulation.setDeviceMetricsOverride",{width:820,height:1000,deviceScaleFactor:1,mobile:false});await wait(100);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true);
  await navigate("?template=investigate&theme=dark");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true);
  assert.equal(await evaluate("(() => {const list=document.querySelector('.wf-library-list');return list.scrollWidth <= list.clientWidth;})()"),true);
  await screenshot("workflow-editor-dark-compact");
  await navigate("?run=workspace-merge&theme=dark");
  await until("document.querySelector('.wf-workspace-run[data-stage=\"waiting_merge\"]')","compact dark merge review");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true);
  await screenshot("merge-review-dark-compact");
  console.log("PASS compact layout");

  await command("Emulation.setDeviceMetricsOverride",{width:1680,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate("localStorage.removeItem('nautilo.workflow.draft.investigate')");
  await navigate("?template=investigate");
  const previewButton='.wf-preview-button';
  const simulationCalls=await evaluate("window.workflowQa.calls.filter(call=>['workflow.start','workflow.control','workflow.save'].includes(call.method)).length");
  await click(previewButton);
  await until("document.querySelectorAll('.wf-wire-row.is-active').length===2","preview sends both main branches together");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.wf-stream-core')).fill"),"rgb(79, 70, 229)");
  await until("document.querySelectorAll('.wf-node[data-motion-state=running] .wf-node-beam').length===2","preview shows two concurrent agents");
  await screenshot("workflow-motion-light");
  await until(isAnimating("wf-join-ripple"),"preview join ripples after both arrivals");
  assert.equal(await evaluate("document.querySelectorAll('.wf-wire-row.is-active').length"),0);
  const joinOutlet="[...document.querySelectorAll('.wf-wire-row.is-active')].some(row=>JSON.parse(row.dataset.wireKey)[0]==='join')";
  await until(joinOutlet,"join releases the downstream preview edge");
  await until(isAnimating("wf-dash-flow"),"preview enters the configured review cycle");
  await until("document.querySelector('[data-node-id=verify]').dataset.motionState==='looping'","review is shown as a loop");
  await until("document.querySelector('[data-node-id=judge]').dataset.motionState==='looping'","preview comes back to the analyst");
  await until("document.querySelector('.wf-preview-status')?.textContent === '预览完成'","preview reaches a completed state");
  assert.equal(await evaluate("[...document.querySelectorAll('[data-node-id]')].find(node=>node.dataset.nodeId==='$return')?.dataset.motionState"),"success");
  assert.equal(await evaluate("window.workflowQa.calls.filter(call=>['workflow.start','workflow.control','workflow.save'].includes(call.method)).length"),simulationCalls);
  await click(second);
  await until("document.querySelector('[data-node-id=child-review]')","another topology is loaded");
  await click(previewButton);
  await until("document.querySelector('[data-node-id=child-main] .wf-node-beam')","preview uses the selected diagram's entry");
  await click(previewButton);
  assert.equal(await evaluate("document.querySelector('.wf-preview-status')"),null);
  assert.equal(await evaluate("document.querySelectorAll('.wf-node-beam,.wf-stream').length"),0);
  await mediaMotion("reduce");
  await click(previewButton);
  await until("document.querySelector('.wf-wire-row.is-active')","reduced-motion preview still reveals the active route");
  assert.equal(await evaluate("document.querySelectorAll('.wf-node-beam,.wf-stream,.wf-join-ripple').length"),0);
  await click(previewButton);
  await mediaMotion("no-preference");
  console.log("PASS diagram preview follows its topology through parallel branches, join, review loop and return, and can be stopped or viewed with reduced motion");

  if (benchmark) {
    const {gpu}=await send("SystemInfo.getInfo");
    const results=[];
    const measure=async (scene,duration)=>{
      const frames=await evaluate(`new Promise(resolve => {
        let start, previous;
        const intervals=[];
        function sample(now) {
          start ??= now;
          if (previous !== undefined) intervals.push(now-previous);
          previous=now;
          if (now-start < ${duration}) { requestAnimationFrame(sample); return; }
          const sorted=[...intervals].sort((a,b)=>a-b);
          resolve({ samples:intervals.length, durationMs:Math.round(now-start), fps:+(1000*intervals.length/(now-start)).toFixed(2),
            p95Ms:+sorted[Math.floor((sorted.length-1)*.95)].toFixed(2), over25Ms:intervals.filter(dt=>dt>25).length });
        }
        requestAnimationFrame(sample);
      })`);
      results.push({scene,...frames});
      console.log("MOTION PERF "+JSON.stringify(results.at(-1)));
    };
    await navigate("?run=parallel");
    await until(isAnimating("wf-beam-spin"),"steady light workflow");
    await wait(400);
    await screenshot("workflow-motion-light-flow");
    await measure("light: two parallel live paths",5000);
    await navigate("?run=review&theme=dark");
    await until(isAnimating("wf-dash-flow"),"steady dark review loop");
    await screenshot("workflow-motion-dark-loop");
    await measure("dark: live review loop",5000);
    await navigate("?template=investigate&theme=dark");
    await click(previewButton);
    await measure("dark: parallel join and review preview",7600);
    // Keep every branch dispatched during the full sample, including refreshes of the run snapshot.
    const size=24, timestamp=Date.now();
    const agents=Array.from({length:size},(_,index)=>({id:`agent-${index+1}`,name:`并行节点 ${index+1}`,role:"Explorer",kind:"agent",exits:[{id:"done",name:"完成"}]}));
    const definition={id:"motion-load",schemaVersion:1,name:"24 路并行",entry:"main",nodes:[
      {id:"main",kind:"main",exits:agents.map(agent=>({id:agent.id,name:agent.name}))},
      ...agents,{id:"join",kind:"join",scope:"main",exits:[{id:"return",name:"结果齐备"}]},
    ],edges:[
      ...agents.map(agent=>({from:["main",agent.id],to:agent.id})),
      ...agents.map(agent=>({from:[agent.id,"done"],to:"join"})),
      {from:["join","return"],to:"$return"},
    ]};
    const layout={nodes:{main:{x:30,y:150},join:{x:1280,y:335},$return:{x:1450,y:305},
      ...Object.fromEntries(agents.map((agent,index)=>[agent.id,{x:265+Math.floor(index/6)*245,y:50+index%6*120}]))}};
    const instances=agents.map(agent=>({id:agent.id,nodeId:agent.id,status:"running",attempt:1,iteration:1,reminders:0,
      incoming:{from:"main",branch:agent.id},createdAt:timestamp,updatedAt:timestamp}));
    const events=agents.map((agent,index)=>({sequence:index+1,type:"edge.traversed",nodeId:"main",message:"Selected outlet",timestamp,data:{edgeIndex:index,branch:agent.id,target:agent.id}}));
    const loadRun={id:"motion-load",revision:1,sessionId:"qa-main",projectId:"qa-project",requestId:"motion-load",definition,layout,
      status:"running",instances,events,messages:[],inputs:{},bindings:{},createdAt:timestamp,updatedAt:timestamp};
    await navigate("?run=motion-load&theme=dark");
    await evaluate(`window.workflowQa.advanceRunSnapshot('motion-load',${JSON.stringify(loadRun)})`);
    await until(`document.querySelectorAll('.wf-node-beam').length===${size} && document.querySelectorAll('.wf-stream').length===${size}`,"all 24 parallel routes animate under load");
    await click('[aria-label="放大"]');
    await wait(460);
    await measure("dark: 24 parallel paths, zoomed, 27 nodes / 49 routes",5000);
    const report={viewport:{width:1680,height:1000},gpuCompositing:gpu.featureStatus?.gpu_compositing,results};
    console.log("MOTION REPORT "+JSON.stringify(report));
    if(process.env.NAUTILO_WORKFLOW_QA_SHOTS)await writeFile(joinPath(process.env.NAUTILO_WORKFLOW_QA_SHOTS,"workflow-motion-performance.json"),JSON.stringify(report,null,2));
  }

  await command("Emulation.setDeviceMetricsOverride",{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await command("Page.navigate",{url:origin+"?conversation=1&theme=dark"});
  await until("document.querySelector('.composer textarea')?.placeholder.includes('@')","the workflow reference composer");
  await setValue(".composer textarea","调查首轮延迟 @并行");
  await until("document.querySelector('.workflow-mention-options [role=option]')","saved workflows in @ picker");
  await screenshot("workflow-mention-dark");
  await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await until("document.querySelector('.workflow-composer-reference')","pinned reference chip");
  await click(".composer-send");
  const pendingPlan='.conversation-workflow-plan[data-status="pending"]';
  await until(`document.querySelector(${JSON.stringify(pendingPlan)})`,"pending plan in the actual chat timeline");
  const sent=await evaluate("window.workflowQa.calls.find(call=>call.method==='session.send').input");
  assert.deepEqual(sent.workflowRef,{id:"investigate",revision:1});assert.equal(sent.text,"调查首轮延迟");
  assert.equal(await evaluate("window.workflowQa.calls.some(call=>call.method==='orchestration.start'||call.method==='workflow.start')"),false);
  await click(`${pendingPlan} .workflow-plan-footer button`);
  await until("document.querySelector('.conversation-workflow-plan[data-status=\"rejected\"]')","rejected plan remains in chat");
  assert.equal(await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.plan.decide').at(-1).input.action"),"reject");
  await click('.conversation-workflow-plan[data-status="rejected"] .workflow-plan-footer button');
  await until("document.querySelector('.workflow-composer-reference')","reusing the reference without navigating");
  await setValue(".composer textarea","再安排一次调查");
  await click(".composer-send");
  await until(`document.querySelector(${JSON.stringify(pendingPlan)})`,"a new plan after rejection");
  await click(`${pendingPlan} .workflow-plan-step`);
  await setValue(`${pendingPlan} .workflow-plan-configuration select`,"qa-alternate");
  await click(`${pendingPlan} .workflow-plan-configuration .composer-model-trigger`);
  await until("Array.from(document.querySelectorAll('.workflow-plan-configuration .model-menu-option')).some(button=>button.textContent.includes('独立复核模型'))","the selected Harness's models");
  await click(`${pendingPlan} .workflow-plan-configuration .model-menu-option`);
  await screenshot("workflow-plan-dark");
  await click(`${pendingPlan} .workflow-plan-confirm`);
  await until("document.querySelector('.conversation-workflow-plan[data-status=\"approved\"]')?.textContent.includes('执行中')","workflow starts in the same chat");
  const decision=await evaluate("window.workflowQa.calls.filter(call=>call.method==='workflow.plan.decide').at(-1).input");
  assert.equal(decision.action,"approve");assert.equal(decision.assignments.a.agentInstanceId,"qa-alternate");assert.equal(decision.assignments.a.model,"review-model");
  assert.equal(Object.keys(decision.assignments).length,1);
  assert.equal(await evaluate("document.querySelectorAll('.conversation-workflow-plan').length"),2);
  console.log("PASS @ reference, editable per-node Harness/model, rejection and approved start in the real chat UI");
  assert.deepEqual(errors,[]);console.log("PASS no uncaught browser exceptions");
  await command("Browser.close");
} finally {
  socket?.close();if(chrome.exitCode===null)chrome.kill();
  // Only remove the unique test profile created above, under the temp root.
  const absolute=resolve(profile),base=resolve(tmpdir())+sep;
  if(absolute.startsWith(base)&&absolute.includes("nautilo-workflow-chrome-")) await rm(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:150}).catch(()=>{});
}
