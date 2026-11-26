import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.NAUTILO_JSDOM_PATH ?? 'jsdom')); } catch {}

test('StrictMode keeps displaying successive reasoning snapshots before completion', {
  skip: !JSDOM && 'Set NAUTILO_JSDOM_PATH to an isolated jsdom installation',
}, async () => {
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
  const hook = join(desktop, 'src/renderer/src/lib/streaming-text.ts').replaceAll('\\', '/');
  const bundle = await build({
    stdin: { resolveDir: desktop, loader: 'tsx', contents: `
      import React, { StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useSmoothStreamText } from '${hook}';
      const root = createRoot(document.getElementById('root'));
      function Output({ text, streaming }) {
        const visible = useSmoothStreamText(text, streaming);
        return <output data-streaming={streaming}>{visible.text}</output>;
      }
      window.qa = { render: (text, streaming = true) => root.render(<StrictMode><Output text={text} streaming={streaming}/></StrictMode>), close: () => root.unmount() };
    ` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    nodePaths: [join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"development"' },
  });
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    dom.window.eval(bundle.outputFiles[0].text);
    const wait = async predicate => {
      const until = Date.now() + 1000;
      while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate(), dom.window.document.querySelector('output')?.textContent);
    };
    const value = () => dom.window.document.querySelector('output')?.textContent;
    const first = 'This is a riddle. Let me analyze.';
    const second = first + '\n\nA girl scored 38 on a math test.';
    const third = second + ' She changed the result.';
    dom.window.qa.render(first);
    await wait(() => value() === first);
    dom.window.qa.render(second);
    await wait(() => value() === second);
    assert.equal(dom.window.document.querySelector('output').dataset.streaming, 'true');
    dom.window.qa.render(third);
    await wait(() => value() === third);
    dom.window.qa.render(third + ' Done.', false);
    await wait(() => value() === third + ' Done.');
  } finally {
    dom.window.qa?.close();
    dom.window.close();
  }
});

test('streamed Markdown fades only new spans and keeps frozen blocks through completion', {
  skip: !JSDOM && 'Set NAUTILO_JSDOM_PATH to an isolated jsdom installation',
}, async () => {
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
  const bundle = await build({
    stdin: { resolveDir: desktop, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MarkdownContent } from './src/renderer/src/features/timeline/MarkdownContent';
      import { parseMarkdownFragments } from './src/renderer/src/lib/markdown-parse';
      const root = createRoot(document.getElementById('root'));
      const layout = () => window.layouts++;
      window.layouts = 0;
      window.qa = {
        render: (source, streaming = true, fade = true, key = 'live') => root.render(<MarkdownContent key={key} source={source} streaming={streaming} fade={fade} onContentLayout={layout}/>),
        finish: () => { const job = window.jobs.shift(); job.worker.onmessage?.({data:{id:job.message.id,fragments:parseMarkdownFragments(job.message.source, job.message.blockwise)}}); },
        close: () => root.unmount()
      };
    ` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    nodePaths: [join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'test-runtime', setup(build) {
      build.onResolve({ filter: /markdown\.worker\?worker$/ }, () => ({ path: 'worker', namespace: 'test' }));
      build.onResolve({ filter: /\/lib\/i18n$/ }, () => ({ path: 'i18n', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ loader: 'js', contents: path === 'worker'
        ? `export default class { postMessage(message) { window.jobs.push({worker:this,message}); } terminate() {} }`
        : `const value={t:key=>key,locale:'zh-CN'}; export const useI18n=()=>value;` }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    dom.window.Worker = class {};
    dom.window.jobs = [];
    dom.window.eval(bundle.outputFiles[0].text);
    const doc = dom.window.document;
    const wait = async predicate => {
      const until = Date.now() + 1500;
      while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate());
    };
    const first = 'Already visible **reasoning**.';
    dom.window.qa.render(first, true, false);
    await wait(() => doc.querySelector('strong'));
    const paragraph = doc.querySelector('p');
    const firstWord = paragraph.querySelector('[data-stream-segment]');
    assert.equal(firstWord.textContent, 'Already ');
    assert.equal(firstWord.classList.contains('stream-fade-seg'), false, 'existing stream snapshots stay static');
    const longer = first + ' 中文👩‍👩‍👧‍👦 mixed.';
    dom.window.qa.render(longer);
    await wait(() => paragraph.textContent === longer.replaceAll('**', ''));
    assert.equal(paragraph.querySelector('[data-stream-segment]'), firstWord);
    assert.equal(firstWord.classList.contains('stream-fade-seg'), false);
    const incoming = [...paragraph.querySelectorAll('.stream-fade-seg')];
    assert(incoming.some(span => span.textContent.includes('中文')));
    const fading = incoming.at(-1);
    fading.dispatchEvent(new dom.window.Event('animationend'));
    assert.equal(fading.classList.contains('stream-fade-seg'), false);
    const buglessCopy = 'const content = "<script>";\n'.repeat(500);
    const large = longer + '\n\n```js\n' + buglessCopy;
    dom.window.qa.render(large);
    await wait(() => doc.querySelector('pre code')?.textContent === buglessCopy);
    assert.equal(dom.window.jobs.length, 0, 'the live suffix never submits a whole-message parse');
    assert.equal(doc.querySelector('pre .hljs-keyword'), null, 'leave a growing code block plain');
    assert.equal(doc.querySelector('[data-markdown-raw]'), null);
    assert.equal(doc.querySelector('p'), paragraph);
    let copied;
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { async writeText(value) { copied = value; } } });
    doc.querySelector('button[aria-label="复制代码"]').click();
    await wait(() => copied !== undefined);
    assert.equal(copied, buglessCopy.trimEnd());
    const before = dom.window.layouts;
    dom.window.qa.render(large + '```\n\nFinal sentence.', false, false);
    await wait(() => dom.window.jobs.length === 1);
    assert.equal(doc.querySelector('[data-markdown-raw]'), null, 'completion must not flash an unformatted tail');
    dom.window.qa.finish();
    await wait(() => doc.querySelector('.markdown-content').textContent.includes('Final sentence.'));
    assert.equal(doc.querySelector('p'), paragraph);
    assert.equal(paragraph.querySelector('[data-stream-segment]'), firstWord);
    assert.ok(doc.querySelector('pre .hljs-keyword'));
    assert.ok(dom.window.layouts > before, 'content layout is reported after the final parse');
    assert.equal(doc.querySelector('[data-markdown-raw]'), null);
    dom.window.qa.render('Stored **history**. 👋', false, true, 'history');
    await wait(() => doc.querySelector('p')?.textContent === 'Stored history. 👋');
    assert.equal(doc.querySelector('.stream-fade-seg'), null);
  } finally { dom.window.qa?.close(); dom.window.close(); }
});
