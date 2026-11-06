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
