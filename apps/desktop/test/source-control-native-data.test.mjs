import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const build=createRequire(require.resolve('vite/package.json'))('esbuild').build;
const entry=fileURLToPath(new URL('../src/renderer/src/features/sessions/source-control-native-data.ts',import.meta.url));
const load=build({entryPoints:[entry],bundle:true,write:false,format:'esm'}).then(({outputFiles})=>
  import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));

test('native Git previews preserve line pairs, inserted rows and inline marks',async()=>{
  const {prepareNativeDiff}=await load;
  const sections=prepareNativeDiff('first\nconst value = "old";\nlast','first\nconst value = "new";\nextra\nlast','sample.ts').blocks;
  const change=sections.find(section=>section.kind==='change');
  assert.equal(change.split[0].length,2);
  assert.equal(change.unified[0].length,3);
  assert.match(change.split[0].html,/is-remove.+<mark>old<\/mark>.+is-add.+<mark>new<\/mark>/);
  assert.match(change.unified[0].html,/extra/);
  assert.match(sections.at(-1).unified[0].html,/>3<.+>4<.+last/);
});

test('native Git previews fold context and keep file text as escaped text',async()=>{
  const {prepareNativeDiff}=await load;
  const shared=Array.from({length:40},(_,i)=>`const line${i} = ${i};`).join('\n');
  const diff=prepareNativeDiff(`${shared}\nconst value = "<&";`,`${shared}\nconst value = "<span>&";`,'sample.ts');
  assert.ok(diff.blocks.some(section=>section.kind==='fold'&&section.length>30));
  const html=diff.blocks.find(section=>section.kind==='change').unified[0].html;
  assert.match(html,/&lt;/);
  assert.match(html,/&amp;/);
  assert.doesNotMatch(html,/<span>&/);
});
