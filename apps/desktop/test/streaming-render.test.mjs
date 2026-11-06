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
      import { useStreamingText } from '${hook}';
      const root = createRoot(document.getElementById('root'));
      function Output({ text, streaming }) {
        const visible = useStreamingText(text, streaming, 'reasoning');
        return <output data-streaming={streaming}>{visible}</output>;
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

test('streamed Markdown keeps formatted nodes through delayed parsing and completion', {
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
        render: (source, streaming = true) => root.render(<MarkdownContent source={source} streaming={streaming} onContentLayout={layout}/>),
        finish: () => { const job = window.jobs.shift(); job.worker.onmessage?.({data:{id:job.message.id,fragments:parseMarkdownFragments(job.message.source)}}); },
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
    const first = 'Already visible **reasoning**.\n\n';
    dom.window.qa.render(first);
    await wait(() => doc.querySelector('strong'));
    const paragraph = doc.querySelector('p');
    const large = first + '1. Keep this list formatted. '.repeat(360);
    dom.window.qa.render(large);
    await wait(() => dom.window.jobs.length === 1);
    assert.equal(doc.querySelector('[data-markdown-raw]'), null, 'pending tokens must not insert a second raw block');
    assert.equal(doc.querySelector('p'), paragraph, 'visible nodes must survive the worker transition');
    const before = dom.window.layouts;
    dom.window.qa.finish();
    await wait(() => doc.querySelector('ol'));
    assert.equal(doc.querySelector('p'), paragraph);
    assert.ok(dom.window.layouts > before, 'follow-tail must run after formatted content commits');
    dom.window.qa.render(large + '\n\nFinal sentence.', false);
    await wait(() => dom.window.jobs.length === 1);
    assert.equal(doc.querySelector('[data-markdown-raw]'), null, 'completion must not flash an unformatted tail');
    dom.window.qa.finish();
    await wait(() => doc.querySelector('.markdown-content').textContent.includes('Final sentence.'));
    assert.equal(doc.querySelector('p'), paragraph);
    assert.equal(doc.querySelector('[data-markdown-raw]'), null);
  } finally { dom.window.qa?.close(); dom.window.close(); }
});
