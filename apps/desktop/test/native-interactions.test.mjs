import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let JSDOM;
try { ({JSDOM} = require(process.env.NAUTILO_JSDOM_PATH ?? 'jsdom')); } catch {}

test('native dialogs round-trip selection, empty input, editor whitespace and cancellation', {skip: !JSDOM}, async () => {
  const desktop=fileURLToPath(new URL('..',import.meta.url));
  const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
  const bundle=await build({stdin:{resolveDir:desktop,loader:'tsx',contents:`
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import {I18nProvider} from './src/renderer/src/lib/i18n';
    import {InteractionCards} from './src/renderer/src/features/sessions/InteractionCards';
    import {useInteractionsStore as ui} from './src/renderer/src/stores/interactions';
    import {providerUiState,applyLiveProviderUi} from './src/renderer/src/lib/provider-ui';
    import {useComposerDraftsStore as drafts} from './src/renderer/src/stores/composer-drafts';
    import {conversationRows} from './src/renderer/src/lib/conversation-timeline';
    import {ConversationTurnView} from './src/renderer/src/features/timeline/ConversationTurnView';
    const root=createRoot(document.getElementById('root'));let record;let serial=0;
    window.qa={responses:[],render(question){record={id:'i'+(++serial),sessionId:'s',providerId:'pi',status:'pending',kind:'question',title:'Native',createdAt:new Date().toISOString(),questions:[{id:'q',question:'Question',...question}]};
      flushSync(()=>{ui.setState({bySession:{s:[record]}});root.render(<I18nProvider><InteractionCards sessionId='s'/></I18nProvider>);});},
      resolve(input){this.responses.push(input);return {...record,status:input.outcome==='cancelled'?'cancelled':'resolved',response:input};},
      renderTurn:turn=>flushSync(()=>root.render(<I18nProvider><ConversationTurnView turn={turn}/></I18nProvider>)),
      close:()=>flushSync(()=>root.unmount()),providerUiState,applyLiveProviderUi,drafts,conversationRows};
  `},bundle:true,platform:'browser',conditions:['worker'],format:'iife',jsx:'automatic',write:false,
  nodePaths:[join(desktop,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},loader:{'.css':'empty','.svg':'dataurl','.png':'dataurl'},
  plugins:[{name:'workers',setup(build){build.onResolve({filter:/\?worker/},()=>({path:'worker',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default class {postMessage(){} terminate(){}}'}));}}]});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.ResizeObserver=class {observe(){} disconnect(){}};
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  w.agenthub={core:{request:async ({method,input})=>method==='interaction.list'?[]:w.qa.resolve(input)}};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const button=text=>[...w.document.querySelectorAll('button')].find(button=>button.textContent.trim()===text);
  const submit=async()=>{const b=button('提交回答');assert.ok(b,'submit control exists');assert.equal(b.disabled,false);b.click();await tick();};
  try {
    w.eval(bundle.outputFiles[0].text);
    w.qa.render({options:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]});await tick();button('Beta').click();await tick();await submit();
    assert.equal(w.qa.responses.at(-1).answers.q[0],'Beta');
    w.qa.render({inputType:'text',allowEmpty:true,preserveWhitespace:true});await tick();await submit();
    assert.equal(w.qa.responses.at(-1).answers.q[0],'');
    const editor='\n  keep indentation\n';
    w.qa.render({inputType:'multiline',initialValue:editor,allowEmpty:true,preserveWhitespace:true});await tick();
    assert.equal(w.document.querySelector('textarea').value,editor);await submit();assert.equal(w.qa.responses.at(-1).answers.q[0],editor);
    w.qa.render({inputType:'text'});await tick();button('取消').click();await tick();assert.equal(w.qa.responses.at(-1).outcome,'cancelled');
    const event=(method,key,text)=>({data:{kind:'provider_ui',method,key,text}});
    assert.deepEqual(JSON.parse(JSON.stringify(w.qa.providerUiState([event('setWidget','a','old'),event('setWidget','a','new'),event('setStatus','x','busy'),event('setStatus','x','')]))),{statuses:[],widgets:['new']});
    w.qa.drafts.getState().setText('s','before');
    const native={eventId:'edit-live',type:'provider.extension_ui',payload:{method:'set_editor_text',text:'from extension'}};
    w.qa.applyLiveProviderUi('s',native);assert.equal(w.qa.drafts.getState().drafts.s.text,'from extension');
    w.qa.drafts.getState().setText('s','user typing');w.qa.applyLiveProviderUi('s',native);assert.equal(w.qa.drafts.getState().drafts.s.text,'user typing');
    const rows=w.qa.conversationRows([{id:'u',sessionId:'s',data:{kind:'message',sender:'user',text:'hi'}},{id:'a',sessionId:'s',runId:'r',data:{kind:'message',sender:'agent',text:'Partial'}},{id:'end',sessionId:'s',runId:'r',data:{kind:'activity',phase:'stopped'}}],false);
    assert.equal(rows[1].turn.completed,true);assert.equal(rows[1].turn.result.data.text,'Partial');assert.equal(rows[1].turn.events.at(-1).data.phase,'stopped');
    w.qa.renderTurn(rows[1].turn);assert.ok(w.document.body.textContent.includes('已停止'));assert.ok(w.document.body.textContent.includes('Partial'));
  } finally {w.qa?.close();w.close();}
});
