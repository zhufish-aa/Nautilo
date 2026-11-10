import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,renameSync,rmSync,realpathSync,existsSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {SourceControl,parseSourceControlStatus} from '../dist/runtime/source-control.js';
import {sourceControlDirectory} from '../dist/application/source-control.js';
import {Database} from '../dist/database/index.js';
function git(cwd,...args){return execFileSync('git',['--no-pager','-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});}
test('history pages preserve the reviewed tip, scope cursors and use literal message or hash searches', async t => {
  const {root, temp, service, write, commit} = fixture(t);
  const history = input => service.history(root, input);
  assert.deepEqual((await history({})).items, []);
  await assert.rejects(history({cursor: '%'}), /游标/);
  write('tracked.txt', 'first\n');
  commit();
  const hashes = [git(root, 'rev-parse', 'HEAD').trim()];
  for (const subject of ['Older [x].* 中文', 'Other', 'Latest']) {
    git(root, 'commit', '--allow-empty', '-m', subject, '-m', 'Search BODY here');
    hashes.push(git(root, 'rev-parse', 'HEAD').trim());
  }
  const tip = hashes.at(-1);
  const first = await history({limit: 2});
  assert.deepEqual(first.items.map(row => row.hash), hashes.slice(-2).reverse());
  git(root, 'commit', '--allow-empty', '-m', 'New while reviewing');
  const next = await history({limit: 2, cursor: first.nextCursor});
  assert.equal(next.head, tip);
  assert.notEqual(next.currentHead, tip);
  assert.deepEqual(next.items.map(row => row.hash), hashes.slice(0,2).reverse());
  assert.equal(next.nextCursor, undefined);
  assert.equal((await history({})).items[0].hash, next.currentHead);
  const filter = await history({query:'search body', limit:2});
  assert.equal((await history({query:'search body',limit:2,cursor:filter.nextCursor})).items[0].hash, hashes[1]);
  for (const query of ['[x].* 中文', hashes[1].slice(0,10).toUpperCase()]) {
    assert.deepEqual((await history({query})).items.map(row=>row.hash), [hashes[1]]);
  }
  await assert.rejects(history({cursor:first.nextCursor,query:'different'}), /刷新/);
  await assert.rejects(history({limit:0}), /100/);
  await assert.rejects(history({cursor:Buffer.from('null').toString('base64url')}), /游标/);
  const linked = join(temp, 'linked');
  git(root,'worktree','add','--detach',linked);
  await assert.rejects(service.history(linked,{cursor:first.nextCursor}), /刷新/);
  git(root,'switch','-c','other',hashes[0]);
  await assert.rejects(history({cursor:first.nextCursor}), /刷新/);
  assert.deepEqual((await history({query:tip})).items, []);
  git(root,'switch','main');
  git(root,'replace',tip,hashes[0]);
  await assert.rejects(history({cursor:first.nextCursor}), /刷新/);
});

function fixture(t){
  const temp=realpathSync(mkdtempSync(join(tmpdir(),'nautilo-scm-node-'))),root=join(temp,'repository');mkdirSync(root);git(root,'init','-b','main');
  for(const[key,value]of [['user.name','Nautilo Fixture'],['user.email','fixture@example.invalid'],['commit.gpgsign','false'],['core.autocrlf','false']])git(root,'config',key,value);
  t.after(()=>{const absolute=realpathSync(temp),parent=realpathSync(tmpdir()),tail=relative(parent,absolute);assert.ok(tail&&tail!=='..'&&!tail.startsWith('..\\')&&!tail.startsWith('../')&&!isAbsolute(tail)&&tail.startsWith('nautilo-scm-node-'));rmSync(absolute,{recursive:true,force:true});});
  const service=new SourceControl();return{temp,root,service,write:(name,content)=>writeFileSync(join(root,name),content),commit:()=>{git(root,'add','-A');git(root,'commit','-m','fixture baseline');},async mutate(action,extra={}){const state=await service.status(root);return service.mutate(root,{action,token:state.token,...extra});}};
}
function editorConflict(t,binary=false){const f=fixture(t);f.write('file.txt',binary?Buffer.from([0,1,2]):'base\n');f.write('other.txt','unchanged\n');f.commit();git(f.root,'switch','-c','feature');f.write('file.txt',binary?Buffer.from([0,3,4]):'incoming\n');f.commit();git(f.root,'switch','main');f.write('file.txt',binary?Buffer.from([0,5,6]):'current\n');f.commit();assert.throws(()=>git(f.root,'merge','feature'));return f;}
test('conflict editor whole versions preserve the native symlink mode in the index',async t=>{
  const f=fixture(t);f.write('file.txt','base\n');f.commit();git(f.root,'config','core.symlinks','false');const base=git(f.root,'rev-parse','HEAD:file.txt').trim(),link=execFileSync('git',['-C',f.root,'hash-object','-w','--stdin'],{input:'target.txt',encoding:'utf8',windowsHide:true}).trim();execFileSync('git',['-C',f.root,'update-index','--index-info'],{input:`0 ${'0'.repeat(40)}\tfile.txt\n100644 ${base} 1\tfile.txt\n100644 ${base} 2\tfile.txt\n120000 ${link} 3\tfile.txt\n`,windowsHide:true});const file=await f.service.file(f.root,{path:'file.txt'});assert.equal(file.editable,false);const result=await f.service.save(f.root,{path:'file.txt',fileVersion:file.token,resolution:'theirs',stage:true});assert.equal(result.staged,true);assert.ok(git(f.root,'ls-files','--stage','--','file.txt').startsWith(`120000 ${link} 0\t`));assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'target.txt');
});
test('conflict editor saves without staging, then marks only its resolved file and preserves other staged files',async t=>{
  const f=editorConflict(t);f.write('other.txt','keep staged\n');git(f.root,'add','--','other.txt');let file=await f.service.file(f.root,{path:'file.txt'});assert.equal(file.base.content,'base\n');assert.equal(file.ours.content,'current\n');assert.equal(file.theirs.content,'incoming\n');assert.equal(file.conflict,true);
  let result=await f.service.save(f.root,{path:'file.txt',fileVersion:file.token,content:'manual draft\n'});assert.equal(result.saved,true);assert.equal(result.staged,false);assert.equal(result.file.conflict,true);assert.equal(git(f.root,'ls-files','-u','--','file.txt').trim().split('\n').length,3);
  result=await f.service.save(f.root,{path:'file.txt',fileVersion:result.file.token,content:'merged result\n',stage:true});assert.equal(result.staged,true);assert.equal(result.error,undefined);assert.equal(result.file.conflict,false);assert.equal(git(f.root,'show',':file.txt'),'merged result\n');assert.equal(git(f.root,'show',':other.txt'),'keep staged\n');await f.mutate('commit',{message:'Resolved in editor'});assert.equal(git(f.root,'rev-list','--parents','-1','HEAD').trim().split(' ').length,3);
});
test('conflict editor native versions preserve CRLF and binary files and clean up private temporary paths',async t=>{
  const f=editorConflict(t);git(f.root,'config','core.autocrlf','true');let file=await f.service.file(f.root,{path:'file.txt'}),result=await f.service.save(f.root,{path:'file.txt',fileVersion:file.token,resolution:'theirs'});assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'incoming\r\n');assert.equal(result.file.conflict,true);result=await f.service.save(f.root,{path:'file.txt',fileVersion:result.file.token,resolution:'ours',stage:true});assert.equal(result.staged,true);assert.equal(git(f.root,'show',':file.txt'),'current\n');assert.equal(readdirSync(join(f.root,'.git')).some(name=>name.startsWith('.nautilo-scm-')),false);
  const binary=editorConflict(t,true);file=await binary.service.file(binary.root,{path:'file.txt'});assert.equal(file.editable,false);assert.equal(file.theirs.binary,true);result=await binary.service.save(binary.root,{path:'file.txt',fileVersion:file.token,resolution:'theirs',stage:true});assert.equal(result.staged,true);assert.deepEqual(readFileSync(join(binary.root,'file.txt')),Buffer.from([0,3,4]));
});
test('conflict editor rejects stale edits and attribute changes while preserving external contents',async t=>{
  const f=editorConflict(t);let file=await f.service.file(f.root,{path:'file.txt'});f.write('file.txt','external edit\n');await assert.rejects(f.service.save(f.root,{path:'file.txt',fileVersion:file.token,content:'overwrite',stage:true}),/已改变/);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'external edit\n');file=await f.service.file(f.root,{path:'file.txt'});f.write('.gitattributes','file.txt text eol=crlf\n');await assert.rejects(f.service.save(f.root,{path:'file.txt',fileVersion:file.token,resolution:'theirs'}),/已改变/);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'external edit\n');
});
test('conflict editor reports saved content when a required clean filter prevents staging',async t=>{
  const f=editorConflict(t);f.write('file.txt','\ufeffcurrent\r\n');f.write('.gitattributes','file.txt filter=fail\n');git(f.root,'config','filter.fail.clean','nautilo-fixture-command-that-does-not-exist');git(f.root,'config','filter.fail.required','true');const file=await f.service.file(f.root,{path:'file.txt'}),result=await f.service.save(f.root,{path:'file.txt',fileVersion:file.token,content:'saved despite filter failure\n',stage:true});assert.equal(result.saved,true);assert.equal(result.staged,false);assert.match(result.error,/已保存.*暂存失败/s);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'\ufeffsaved despite filter failure\r\n');assert.equal(git(f.root,'ls-files','-u','--','file.txt').trim().split('\n').length,3);
});
test('conflict editor does not overwrite an external edit made during native version preparation',async t=>{
  const f=editorConflict(t),script=join(f.root,'.git','smudge.cjs');writeFileSync(script,`const fs=require('node:fs');let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(join(f.root,'file.txt'))},'external during preparation\\n');process.stdout.write(data)});`);f.write('.gitattributes','file.txt filter=fixture\n');git(f.root,'config','filter.fixture.smudge','node "'+script.replaceAll('\\','/')+'"');const file=await f.service.file(f.root,{path:'file.txt'});await assert.rejects(f.service.save(f.root,{path:'file.txt',fileVersion:file.token,resolution:'theirs',stage:true}),/已改变/);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'external during preparation\n');assert.equal(readdirSync(join(f.root,'.git')).some(name=>name.startsWith('.nautilo-scm-')),false);
});
test('conflict editor handles a deleted side and keeps linked worktree file identities separate',async t=>{
  const f=fixture(t);f.write('file.txt','base\n');f.commit();git(f.root,'switch','-c','feature');git(f.root,'rm','file.txt');git(f.root,'commit','-m','Delete');git(f.root,'switch','main');f.write('file.txt','current\n');f.commit();assert.throws(()=>git(f.root,'merge','feature'));const file=await f.service.file(f.root,{path:'file.txt'});assert.equal(file.theirs.exists,false);const result=await f.service.save(f.root,{path:'file.txt',fileVersion:file.token,resolution:'theirs',stage:true});assert.equal(result.saved,true);assert.equal(result.staged,true);assert.equal(result.file.working.exists,false);assert.equal(existsSync(join(f.root,'file.txt')),false);
  const scope=fixture(t);scope.write('file.txt','base\n');scope.commit();const worktree=join(scope.temp,'feature');git(scope.root,'worktree','add','-b','feature',worktree);const mainFile=await scope.service.file(scope.root,{path:'file.txt'});await assert.rejects(scope.service.save(worktree,{path:'file.txt',fileVersion:mainFile.token,content:'wrong tree'}),/已改变/);const featureFile=await scope.service.file(worktree,{path:'file.txt'});await scope.service.save(worktree,{path:'file.txt',fileVersion:featureFile.token,content:'feature draft\n'});assert.equal(readFileSync(join(scope.root,'file.txt'),'utf8'),'base\n');assert.equal(readFileSync(join(worktree,'file.txt'),'utf8'),'feature draft\n');
});
test('conflict editor rejects parent links outside the repository before creating files',async t=>{const f=fixture(t),outside=fixture(t);symlinkSync(outside.root,join(f.root,'escape'),process.platform==='win32'?'junction':'dir');await assert.rejects(f.service.file(f.root,{path:'escape/new.txt'}),/之外/);await assert.rejects(f.service.save(f.root,{path:'escape/new.txt',fileVersion:'unknown',content:'outside'}),/之外/);assert.equal(existsSync(join(outside.root,'new.txt')),false);});
test('file editor keeps a large regular text file editable after saving within its preview bound',async t=>{const f=fixture(t),text='long line\n'.repeat(180000);f.write('large.txt',text);f.commit();const staged=git(f.root,'rev-parse',':large.txt'),file=await f.service.file(f.root,{path:'large.txt'});assert.equal(file.editable,true);assert.equal(file.working.content,text);const result=await f.service.save(f.root,{path:'large.txt',fileVersion:file.token,content:text+'tail\n'});assert.equal(result.saved,true);assert.equal(result.file.editable,true);assert.equal(result.file.working.content,text+'tail\n');assert.equal(git(f.root,'rev-parse',':large.txt'),staged);});
test('porcelain v2 retains path boundaries and native conflict identity',()=>{
  const parsed=parseSourceControlStatus(['# branch.oid (initial)','# branch.head main','? 中文 name.txt','2 R. N... 100644 100644 100644 a b R100 new.txt','old\nname.txt','u UU N... 1 1 1 1 a b c conflict.txt',''].join('\0'));
  assert.equal(parsed.branch,'main');assert.equal(parsed.head,undefined);assert.equal(parsed.changes[0].untracked,true);assert.equal(parsed.changes[1].originalPath,'old\nname.txt');assert.equal(parsed.changes[2].conflict,true);
});
test('untracked nested repositories keep directory previews without weakening path checks',async t=>{
  for(const path of ['../escape/','nested//','/outside/','.git/'])assert.throws(()=>parseSourceControlStatus('? '+path+'\0'),/工作目录/);
  const parsed=parseSourceControlStatus('? doop/\0? file.txt\0');assert.equal(parsed.changes[0].path,'doop');assert.equal(parsed.changes[0].directory,true);assert.equal(parsed.changes[1].directory,false);
  const f=fixture(t);mkdirSync(join(f.root,'nested'));git(join(f.root,'nested'),'init');f.write('nested/keep.txt','untouched');
  const status=await f.service.status(f.root);assert.ok(status.changes.some(file=>file.path==='nested'&&file.directory));
  const diff=await f.service.diff(f.root,{path:'nested',source:'worktree'});assert.equal(diff.previewReason,'directory');assert.equal(readFileSync(join(f.root,'nested/keep.txt'),'utf8'),'untouched');
});
test('commit details and diffs retain native initial commits, rename identities and immutable contents',async t=>{
  const f=fixture(t),before=Array.from({length:30},(_,line)=>`line ${line}\n`).join('');f.write('old [x] 中文.txt',before);f.write('deleted.txt','removed later\n');f.write('binary.dat',Buffer.from([0,1,2]));f.commit();
  const first=git(f.root,'rev-parse','HEAD').trim(),initial=await f.service.commitDetails(f.root,{hash:first});assert.equal(initial.files.length,3);assert.equal(initial.parents.length,0);
  const firstDiff=await f.service.commitDiff(f.root,{hash:first,path:'old [x] 中文.txt'});assert.equal(firstDiff.before,'');assert.equal(firstDiff.after,before);
  renameSync(join(f.root,'old [x] 中文.txt'),join(f.root,'renamed 中文.txt'));const after=before.replace('line 3\n','changed 3\n');f.write('renamed 中文.txt',after);rmSync(join(f.root,'deleted.txt'));f.write('new.rs','fn main() {}\n');f.write('binary.dat',Buffer.from([0,4,5]));git(f.root,'add','-A');git(f.root,'commit','-m','Subject','-m','Multiline body\nSecond line');
  const hash=git(f.root,'rev-parse','HEAD').trim();f.write('renamed 中文.txt','future working edit\n');const statusBefore=git(f.root,'status','--porcelain=v2','-z'),details=await f.service.commitDetails(f.root,{hash});assert.equal(details.subject,'Subject');assert.match(details.body,/Second line/);assert.equal(details.files.length,4);
  const rename=details.files.find(file=>file.path==='renamed 中文.txt');assert.equal(rename.originalPath,'old [x] 中文.txt');assert.equal(rename.additions,1);assert.equal(rename.deletions,1);assert.equal(details.files.find(file=>file.path==='binary.dat').binary,true);
  const diff=await f.service.commitDiff(f.root,{hash,path:'renamed 中文.txt'});assert.equal(diff.before,before);assert.equal(diff.after,after);assert.equal(diff.commitHash,hash);
  const deleted=await f.service.commitDiff(f.root,{hash,path:'deleted.txt'});assert.equal(deleted.before,'removed later\n');assert.equal(deleted.after,'');const binary=await f.service.commitDiff(f.root,{hash,path:'binary.dat'});assert.equal(binary.binary,true);assert.equal(binary.after,undefined);
  await assert.rejects(f.service.commitDetails(f.root,{hash:'--all'}));await assert.rejects(f.service.commitDiff(f.root,{hash,path:'../escape'}));await assert.rejects(f.service.commitDiff(f.root,{hash,path:'missing.txt'}));assert.equal(git(f.root,'status','--porcelain=v2','-z'),statusBefore);assert.equal(git(f.root,'rev-parse','HEAD').trim(),hash);
});
test('merge commit details compare its first parent and exclude unchanged files',async t=>{
  const f=fixture(t);f.write('main.txt','base\n');f.write('feature.txt','base\n');f.commit();git(f.root,'switch','-c','feature');f.write('feature.txt','feature change\n');f.commit();git(f.root,'switch','main');f.write('main.txt','main change\n');f.commit();git(f.root,'merge','--no-edit','feature');
  const hash=git(f.root,'rev-parse','HEAD').trim(),details=await f.service.commitDetails(f.root,{hash});assert.equal(details.parents.length,2);assert.deepEqual(details.files.map(file=>file.path),['feature.txt']);const diff=await f.service.commitDiff(f.root,{hash,path:'feature.txt'});assert.equal(diff.before,'base\n');assert.equal(diff.after,'feature change\n');
});
test('code previews include full files and separate selected content from later working edits',async t=>{
  const f=fixture(t),before=Array.from({length:40},(_,line)=>`line ${line}\n`).join('');f.write('code.rs',before);f.commit();const selected=before.replace('line 20\n','selected change\n');f.write('code.rs',selected);await f.mutate('stage',{paths:['code.rs']});const working=selected.replace('line 30\n','working change\n');f.write('code.rs',working);
  const status=await f.service.status(f.root),file=status.changes.find(file=>file.path==='code.rs');assert.equal(file.additions,2);assert.equal(file.deletions,2);
  const index=await f.service.diff(f.root,{path:'code.rs',source:'index'});assert.equal(index.before,before);assert.equal(index.after,selected);const diff=await f.service.diff(f.root,{path:'code.rs',source:'worktree'});assert.equal(diff.before,selected);assert.equal(diff.after,working);f.write('new.rs','fn main() {}\n');const fresh=await f.service.diff(f.root,{path:'new.rs',source:'worktree'});assert.equal(fresh.before,'');assert.equal(fresh.after,'fn main() {}\n');
});
test('stage, unstage and commit preserve partial worktree edits and literal filenames',async t=>{
  const f=fixture(t);f.write('[x].txt','first\n');f.write('x.txt','untouched\n');f.write('中文 name.txt','other\n');
  await f.mutate('stage',{paths:['[x].txt']});f.write('[x].txt','second\n');assert.match((await f.service.diff(f.root,{path:'[x].txt',source:'index'})).patch,/\+first/);
  await f.mutate('unstage',{paths:['[x].txt']});assert.equal(readFileSync(join(f.root,'[x].txt'),'utf8'),'second\n');
  await f.mutate('stage',{paths:['[x].txt']});f.write('[x].txt','working copy\n');await f.mutate('commit',{message:'Quoted "subject"\n\nMultiline body'});
  assert.equal(git(f.root,'show','HEAD:[x].txt'),'second\n');assert.equal(git(f.root,'ls-tree','--name-only','HEAD').trim(),'[x].txt');assert.equal(readFileSync(join(f.root,'[x].txt'),'utf8'),'working copy\n');
});
test('discard checks reviewed content and can restore a deleted nested directory',async t=>{
  const f=fixture(t);mkdirSync(join(f.root,'src'));f.write('src/file.txt','baseline\n');f.commit();f.write('src/file.txt','reviewed\n');
  const state=await f.service.status(f.root),diff=await f.service.diff(f.root,{path:'src/file.txt',source:'worktree'});f.write('src/file.txt','new edit\n');
  await assert.rejects(f.service.mutate(f.root,{action:'discard',paths:['src/file.txt'],token:state.token,fileToken:diff.fileToken}),/内容已改变/);assert.equal(readFileSync(join(f.root,'src/file.txt'),'utf8'),'new edit\n');
  const source=realpathSync(join(f.root,'src'));assert.ok(source.startsWith(realpathSync(f.root)));rmSync(source,{recursive:true});
  const deleted=await f.service.diff(f.root,{path:'src/file.txt',source:'worktree'});assert.match(deleted.patch,/-baseline/);await f.mutate('discard',{paths:['src/file.txt'],fileToken:deleted.fileToken});assert.equal(readFileSync(join(f.root,'src/file.txt'),'utf8'),'baseline\n');
});
test('renames unstage together and a stale index cannot commit unseen content',async t=>{
  const f=fixture(t);f.write('old name.txt','baseline\n');f.commit();renameSync(join(f.root,'old name.txt'),join(f.root,'new name.txt'));git(f.root,'add','-A');
  const state=await f.service.status(f.root);assert.equal(state.changes[0].originalPath,'old name.txt');await f.mutate('unstage',{paths:['new name.txt']});
  const before=await f.service.status(f.root);git(f.root,'add','-A');await assert.rejects(f.service.mutate(f.root,{action:'commit',token:before.token,message:'stale'}),/状态已改变/);
});
test('native merge conflicts block commits until resolved, then retain both parents',async t=>{
  const f=fixture(t);f.write('file.txt','base\n');f.commit();git(f.root,'switch','-c','feature');f.write('file.txt','feature\n');f.commit();git(f.root,'switch','main');f.write('file.txt','main\n');f.commit();
  assert.throws(()=>git(f.root,'merge','feature'));const state=await f.service.status(f.root);assert.equal(state.operation,'merge');assert.equal(state.changes[0].conflict,true);
  await assert.rejects(f.mutate('commit',{message:'unresolved'}),/解决冲突/);f.write('file.txt','main\n');await f.mutate('stage',{paths:['file.txt']});assert.equal((await f.service.status(f.root)).changes.length,0);await f.mutate('commit',{message:'Resolve merge'});
  assert.equal(git(f.root,'rev-list','--parents','-1','HEAD').trim().split(' ').length,3);assert.equal((await f.service.status(f.root)).operation,undefined);
});
test('publish, fetch and fast-forward pull use a local bare remote and preserve dirty work',async t=>{
  const f=fixture(t),other=fixture(t),remote=join(f.temp,'remote.git');git(f.temp,'init','--bare',remote);f.write('file.txt','base\n');f.commit();git(f.root,'remote','add','origin',remote);
  await f.mutate('push',{remote:'origin'});assert.equal((await f.service.status(f.root)).upstream,'origin/main');
  git(f.root,'remote','add','fork',remote);git(f.root,'fetch','fork');git(f.root,'config','branch.main.remote','fork');assert.equal((await f.service.status(f.root)).upstreamRemote,'fork');git(f.root,'config','branch.main.remote','origin');
  git(f.root,'config','branch.main.pushRemote','fork');const triangular=await f.mutate('push');assert.equal(triangular.status.pushRemote,'fork');assert.equal(triangular.status.upstreamRemote,'origin');assert.equal(git(f.root,'config','branch.main.remote').trim(),'origin');
  git(other.root,'remote','add','origin',remote);git(other.root,'fetch','origin');git(other.root,'reset','--hard','origin/main');other.write('file.txt','remote\n');other.commit();git(other.root,'push','origin','HEAD:main');
  const fetched=await f.mutate('fetch',{remote:'origin'});assert.equal(fetched.status.behind,1);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'base\n');
  await f.mutate('pull',{remote:'origin'});assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'remote\n');await f.mutate('create-branch',{branch:'feature'});await f.mutate('switch-branch',{branch:'main'});
  f.write('file.txt','local commit\n');f.commit();const localHead=git(f.root,'rev-parse','HEAD');other.write('file.txt','remote diverged\n');other.commit();git(other.root,'push','origin','HEAD:main');
  await assert.rejects(f.mutate('pull',{remote:'origin'}));assert.equal(git(f.root,'rev-parse','HEAD'),localHead);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'local commit\n');
  f.write('file.txt','unsaved\n');await assert.rejects(f.mutate('switch-branch',{branch:'feature'}),/处理当前更改/);await assert.rejects(f.mutate('pull',{remote:'origin'}),/处理当前更改/);assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'unsaved\n');
});
test('session scope selects its linked worktree and mismatched project scope is rejected',async t=>{
  const f=fixture(t);f.write('file.txt','base\n');f.commit();const worktree=join(f.temp,'feature');git(f.root,'worktree','add','-b','feature',worktree);writeFileSync(join(worktree,'file.txt'),'feature edit\n');
  const database=new Database(':memory:');t.after(()=>database.close());database.projects.save({id:'project',name:'Fixture',rootPath:f.root,repositoryType:'git',frontendPaths:[],backendPaths:[],ignoredPaths:[],policyId:'default'},new Date().toISOString());
  database.sessions.save({id:'session',projectId:'project',memberId:'agent',title:'Fixture',status:'idle',nativeWorkingDirectory:worktree,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const cwd=sourceControlDirectory(database,{sessionId:'session'});assert.equal(cwd,worktree);assert.equal((await f.service.status(cwd)).branch,'feature');assert.throws(()=>sourceControlDirectory(database,{sessionId:'session',projectId:'wrong'}));
});
test('large untracked and binary previews are bounded and explicit',async t=>{
  const f=fixture(t);f.write('binary.bin',Buffer.from([1,0,2]));f.write('large.txt','x'.repeat(2*1024*1024));
  const binary=await f.service.diff(f.root,{path:'binary.bin',source:'worktree'}),large=await f.service.diff(f.root,{path:'large.txt',source:'worktree'});assert.equal(binary.binary,true);assert.equal(large.truncated,true);assert.ok(large.patch.length<1100000);
  await assert.rejects(f.service.diff(f.root,{path:'large.txt',source:'index'}),/暂存状态已改变/);
});
test('initializing an unversioned directory keeps files and never nests a repository',async t=>{
  const f=fixture(t),directory=join(f.temp,'unversioned');mkdirSync(directory);writeFileSync(join(directory,'kept.txt'),'kept\n');assert.equal((await f.service.status(directory)).available,false);
  const initialized=await f.service.mutate(directory,{action:'init',token:''});assert.equal(initialized.status.available,true);assert.equal(initialized.status.head,undefined);assert.equal(readFileSync(join(directory,'kept.txt'),'utf8'),'kept\n');
  const nested=join(directory,'nested');mkdirSync(nested);await f.service.mutate(nested,{action:'init',token:''});assert.equal(existsSync(join(nested,'.git')),false);
});
test('individual hunks stage and unstage without changing working files or another staged file',async t=>{
  const f=fixture(t),base=Array.from({length:36},(_,index)=>`line ${index+1}`).join('\n')+'\n';f.write('file.txt',base);f.write('other.txt','base\n');f.commit();
  f.write('other.txt','kept staged\n');await f.mutate('stage',{paths:['other.txt']});const changed=base.replace('line 3\n','first edit\n').replace('line 30\n','second edit\n');f.write('file.txt',changed);
  let diff=await f.service.diff(f.root,{path:'file.txt',source:'worktree'});assert.equal(diff.hunks.length,2);await f.mutate('stage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,hunkIds:[diff.hunks[1].id]});
  assert.equal(git(f.root,'show',' :file.txt'.trim()),base.replace('line 30\n','second edit\n'));assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),changed);
  diff=await f.service.diff(f.root,{path:'file.txt',source:'index'});await f.mutate('unstage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,hunkIds:[diff.hunks[0].id]});
  assert.equal(git(f.root,'show',':file.txt'),base);assert.equal(git(f.root,'show',':other.txt'),'kept staged\n');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),changed);
});
test('individual lines preserve unselected changes in both staging directions',async t=>{
  const f=fixture(t);f.write('file.txt','a\nb\nc\n');f.commit();f.write('file.txt','a\nB\nC\n');
  let diff=await f.service.diff(f.root,{path:'file.txt',source:'worktree'}),rows=diff.patch.split('\n');const selected=[rows.indexOf('-b')+1,rows.indexOf('+B')+1];
  await f.mutate('stage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,lines:selected});assert.equal(git(f.root,'show',':file.txt'),'a\nB\nc\n');
  await f.mutate('stage',{paths:['file.txt']});diff=await f.service.diff(f.root,{path:'file.txt',source:'index'});rows=diff.patch.split('\n');
  await f.mutate('unstage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,lines:[rows.indexOf('-b')+1,rows.indexOf('+B')+1]});assert.equal(git(f.root,'show',':file.txt'),'a\nb\nC\n');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'a\nB\nC\n');
});
test('partial new and deleted files keep native EOL and EOF semantics',async t=>{
  const f=fixture(t);git(f.root,'config','core.autocrlf','true');f.write('中文 [x].txt','one\r\ntwo\r\nthree');
  let diff=await f.service.diff(f.root,{path:'中文 [x].txt',source:'worktree'}),rows=diff.patch.split('\n');await f.mutate('stage-hunks',{paths:['中文 [x].txt'],patchToken:diff.patchToken,lines:[rows.indexOf('+one')+1]});assert.equal(git(f.root,'show',':中文 [x].txt'),'one\n');
  diff=await f.service.diff(f.root,{path:'中文 [x].txt',source:'index'});await f.mutate('unstage-hunks',{paths:['中文 [x].txt'],patchToken:diff.patchToken,hunkIds:[diff.hunks[0].id]});assert.throws(()=>git(f.root,'show',':中文 [x].txt'));assert.equal(readFileSync(join(f.root,'中文 [x].txt'),'utf8'),'one\r\ntwo\r\nthree');
  await f.mutate('stage',{paths:['中文 [x].txt']});await f.mutate('commit',{message:'baseline'});rmSync(join(f.root,'中文 [x].txt'));diff=await f.service.diff(f.root,{path:'中文 [x].txt',source:'worktree'});rows=diff.patch.split('\n');
  await f.mutate('stage-hunks',{paths:['中文 [x].txt'],patchToken:diff.patchToken,lines:[rows.indexOf('-two')+1]});assert.equal(git(f.root,'show',':中文 [x].txt'),'one\nthree');
});
test('partial changes reject stale patches and non-change row selections',async t=>{
  const f=fixture(t);f.write('file.txt','one\ntwo\n');f.commit();f.write('file.txt','ONE\ntwo\n');let diff=await f.service.diff(f.root,{path:'file.txt',source:'worktree'});f.write('file.txt','LATEST\ntwo\n');
  await assert.rejects(f.mutate('stage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,hunkIds:[diff.hunks[0].id]}),/差异内容已改变/);assert.equal(git(f.root,'show',':file.txt'),'one\ntwo\n');
  diff=await f.service.diff(f.root,{path:'file.txt',source:'worktree'});await assert.rejects(f.mutate('stage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,lines:[1]}),/选择的差异已失效/);
});
test('partial EOF edits retain newline boundaries when only an addition is staged',async t=>{
  const f=fixture(t);f.write('file.txt','one');f.commit();f.write('file.txt','two\n');const diff=await f.service.diff(f.root,{path:'file.txt',source:'worktree'}),rows=diff.patch.split('\n');
  await f.mutate('stage-hunks',{paths:['file.txt'],patchToken:diff.patchToken,lines:[rows.indexOf('+two')+1]});assert.equal(git(f.root,'show',':file.txt'),'one\ntwo\n');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'two\n');
});
