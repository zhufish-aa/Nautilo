/** UI regression for configured model editing. Uses an isolated installed jsdom. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '../..');
const fromVite = createRequire(require.resolve('vite/package.json', { paths: [desktop] }));
const esbuild = fromVite('esbuild');
const { JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH || 'jsdom');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nautilo-model-editor-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const output = path.join(scratch, 'entry.js');
  const root = path.join(desktop, 'src/renderer/src');
  await esbuild.build({ stdin: { contents: `import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { I18nProvider } from '${root}/lib/i18n'; import { ModelConfigurationEditor } from '${root}/features/agents/ModelConfigurationEditor'; import { modelRow } from '${root}/features/agents/model-editor'; function Test(){ const [models,setModels]=useState([modelRow({ id:'test-model',displayName:'Test model',reasoningEfforts:['low','high'],defaultReasoningEffort:'high',pricing:{input:0}},'m')]); window.models=models; return <I18nProvider><ModelConfigurationEditor models={models} onChange={setModels}/></I18nProvider> };createRoot(document.getElementById('root')).render(<Test/>);`, resolveDir: desktop, loader: 'tsx' }, outfile: output, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"test"' } });
  const errors=[]; const virtualConsole=new VirtualConsole(); virtualConsole.on('jsdomError', error=>errors.push(error.message)); virtualConsole.on('error', (...args)=>errors.push(args.join(' ')));
  const dom=new JSDOM('<div id="root"></div>',{url:'http://unit.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window,d=w.document; w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}); w.ResizeObserver=class{observe(){} unobserve(){} disconnect(){}}; w.HTMLElement.prototype.scrollIntoView=function(){};
  w.eval(fs.readFileSync(output,'utf8')); await sleep(150);
  const click=text=>{const button=[...d.querySelectorAll('button')].find(node=>node.textContent.trim()===text); assert(button,`Missing ${text}`);button.click();};
  click('Test model'); await sleep(50);
  assert(d.querySelector('section')); assert.equal(w.models[0].defaultReasoningEffort,'high');
  const toggle=d.querySelector('[role="switch"]'); toggle.click(); await sleep(30); assert.equal(w.models[0].enabled,false);
  const remove=d.querySelector('button[aria-label="移除模型"],button[aria-label="Remove model"]'); assert(remove);remove.click();await sleep(30);assert.equal(w.models.length,0);assert.equal(d.querySelector('section'),null);
  const add=[...d.querySelectorAll('button')].find(node=>/手动添加|Add model/.test(node.textContent));add.click();await sleep(50);assert.equal(w.models.length,1);assert(d.querySelector('section'));assert.equal(w.models[0].efforts,'');
  // Opening the no-options default selector must not create an empty Radix item.
  const defaultSelect=d.querySelector('[role="combobox"]');assert(defaultSelect);assert.match(defaultSelect.textContent,/服务商默认|Provider default/);
  assert.deepEqual(errors,[]);dom.window.close();fs.rmSync(scratch,{recursive:true,force:true});console.log('PASS model select, enable, remove, add, empty reasoning default and no runtime errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
