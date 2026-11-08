import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalService } from '../dist/runtime/terminal-service.js';

test('terminal cursor reconnect preserves output and detached sessions accept input and resize', () => {
  let output, exit; const writes=[], sizes=[]; let starts=0;
  const service=new TerminalService({available:true,start:()=>{starts++;return {pid:77,write:text=>writes.push(text),resize:(cols,rows)=>sizes.push([cols,rows]),kill:()=>exit(0),onData:cb=>{output=cb;return ()=>{};},onExit:cb=>{exit=cb;return ()=>{};}};}});
  try {
    const first=service.open('shell:s','C:/fixture');
    output('中文\x1b[31m');
    const read=service.read(first.id,0);assert.equal(Buffer.from(read.data,'base64').toString(),'中文\x1b[31m');
    const next=service.open('shell:s','C:/fixture');assert.equal(next.id,first.id);assert.equal(starts,1);
    service.write(next.id,'hello\r');service.resize(next.id,120,30);
    assert.deepEqual(writes,['hello\r']);assert.deepEqual(sizes,[[120,30]]);
    assert.equal(service.read(next.id,read.cursor).data,'');
    exit(0);assert.equal(service.read(next.id,0).exited,true);
    const other=service.open('shell:other','C:/fixture');assert.notEqual(other.id,next.id);
    assert.equal(service.read(next.id,0).data,read.data,'opening another terminal preserves exited scrollback');
  } finally {service.closeAll();}
});

test('terminal tabs keep exited scrollback, scope identity and siblings across restore and close',()=>{
  const processes=[];
  const service=new TerminalService({available:true,start:()=>{const child={pid:processes.length+10,killCount:0,write(){},resize(){},kill(){this.killCount++;this.exit(0)},onData(callback){this.output=callback;return()=>{}},onExit(callback){this.exit=callback;return()=>{}}};processes.push(child);return child;}});
  const scope=TerminalService.scope('session:one','project');
  const open=(tabId,restoreOnly=false)=>service.open(JSON.stringify(['shell',scope,tabId]),'D:/fixture',100,24,{scope,tabId,restoreOnly});
  try{
    assert.throws(()=>open('missing',true));assert.equal(processes.length,0);
    const first=open('default'),second=open('build');assert.notEqual(first.pid,second.pid);
    processes[0].output('retained output');assert.equal(open('default',true).id,first.id);assert.equal(processes.length,2);
    service.stop(first.id);assert.equal(processes[0].killCount,1);assert.equal(processes[1].killCount,0);
    assert.equal(open('default',true).id,first.id);assert.equal(open('default',true).exited,true);
    assert.equal(Buffer.from(service.read(first.id,0).data,'base64').toString(),'retained output');
    processes[0].output('x'.repeat(300000));const prefix=service.read(first.id,0);assert.equal(prefix.exited,false,'exit is reported only after draining the retained tail');assert.equal(service.read(first.id,prefix.cursor).exited,true);
    const restarted=open('default');assert.notEqual(restarted.id,first.id);assert.equal(service.list(scope).items.length,2);
    assert.equal(service.list(TerminalService.scope(undefined,'session:one')).items.length,0);
    service.closeTab(scope,'default');assert.throws(()=>service.read(first.id,0));assert.throws(()=>service.read(restarted.id,0));assert.throws(()=>open('default',true));assert.equal(processes[1].killCount,0);assert.equal(service.list(scope).items[0].id,second.id);
    const otherScope=TerminalService.scope('other-session','project'),other=service.open(JSON.stringify(['shell',otherScope,'default']),'D:/fixture',100,24,{scope:otherScope,tabId:'default'});
    service.closeScope(scope);assert.equal(service.list(scope).items.length,0);assert.throws(()=>open('default'));assert.equal(service.list(otherScope).items[0].id,other.id);
  }finally{service.closeAll();}
});
