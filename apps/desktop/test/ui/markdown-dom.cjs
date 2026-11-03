/** DOM/worker-protocol integration, not a browser/WebView paint benchmark.
 * NAUTILO_JSDOM_PATH=/tmp/nautilo-dom/node_modules/jsdom node apps/desktop/test/ui/markdown-dom.cjs
 * No app dependency installation; uses the existing Vite/esbuild toolchain.
 */
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '../..');
const esbuild = createRequire(require.resolve('vite/package.json', { paths: [desktop] }))('esbuild');
const { JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH || 'jsdom');
const { performance } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nautilo-markdown-'));
  const entry = path.join(scratch, 'entry.tsx'), output = path.join(scratch, 'entry.js');
  const parserPath = path.join(desktop, 'src/renderer/src/lib/markdown-parse.ts');
  fs.writeFileSync(entry, `import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom'; import {MarkdownContent} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/features/timeline/MarkdownContent'))}; import {I18nProvider} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/lib/i18n'))}; import {TimelineViewport} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/features/timeline/Timeline'))}; import {useSettingsStore} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/stores/settings'))}; const root=createRoot(document.getElementById('root')!); window.renderMarkdown=(source,key='message',inverted=false)=>flushSync(()=>root.render(<I18nProvider><MarkdownContent key={key} source={source} inverted={inverted} /></I18nProvider>)); window.renderTimeline=(keys,sessionKey,contentKey,forceFollowKey)=>flushSync(()=>root.render(<I18nProvider><TimelineViewport rows={keys.map(key=>({key,render:()=>key}))} sessionKey={sessionKey} contentKey={contentKey} forceFollowKey={forceFollowKey}/></I18nProvider>)); window.setLocale=locale=>flushSync(()=>useSettingsStore.setState({locale})); window.flushWorker=(worker,data)=>flushSync(()=>worker.onmessage({data})); window.clear=()=>flushSync(()=>root.render(null));`);
  await esbuild.build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'browser', conditions: ['worker'], format: 'iife', jsx: 'automatic', nodePaths: [path.join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': process.env.MARKDOWN_BENCH ? '"production"' : '"test"' }, loader: { '.css': 'empty' }, plugins: [{ name: 'controlled-worker', setup(build) {
    build.onResolve({ filter: /markdown\.worker\?worker$/ }, args => ({ path: args.path, namespace: 'markdown-test-worker' }));
    build.onLoad({ filter: /.*/, namespace: 'markdown-test-worker' }, () => ({ contents: `import {parseMarkdownFragments} from ${JSON.stringify(parserPath)}; export default class Worker { constructor(){this.sent=[];this.terminated=false;window.markdownWorkers.push(this)} postMessage(message){this.sent.push(message)} prepare(message=this.sent.at(-1)){return {id:message.id,fragments:parseMarkdownFragments(message.source)}} finish(message=this.sent.at(-1)){this.onmessage?.({data:this.prepare(message)})} terminate(){this.terminated=true} }`, resolveDir: desktop }));
    build.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'other-worker' }));
    build.onLoad({ filter: /.*/, namespace: 'other-worker' }, () => ({ contents: 'export default class Worker { postMessage(){} terminate(){} }' }));
  } }] });
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://unit.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document;
  w.markdownWorkers = []; w.Worker = class {};
  w.matchMedia = media => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  let copied; Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  w.eval(fs.readFileSync(output, 'utf8'));
  const check = async (name, fn) => { await fn(); console.log('PASS', name); };
  const before = '```js\nconsole.log("copy");\n```\n\n' + Array.from({ length: 100 }, (_, i) => `Paragraph ${i}.\n\n`).join('');
  await check('short source uses no worker; streaming preserves completed DOM, copy state and keyboard focus', async () => {
    w.renderMarkdown(before);
    assert.equal(w.markdownWorkers.length, 0);
    const paragraphs = [...d.querySelectorAll('p')], pre = d.querySelector('pre'), button = d.querySelector('button');
    button.focus(); button.click(); await sleep(20);
    assert.equal(copied, 'console.log("copy");'); assert(button.querySelector('.lucide-check'));
    w.renderMarkdown(before + 'Tail');
    assert(paragraphs.every((element, index) => element === d.querySelectorAll('p')[index]));
    assert.equal(d.querySelector('pre'), pre); assert.equal(d.querySelector('button'), button); assert(button.querySelector('.lucide-check')); assert.equal(d.activeElement, button);
  });
  await check('crossing 8k exposes every new character immediately and retains the completed interactive prefix', async () => {
    const pre = d.querySelector('pre'), button = d.querySelector('button');
    const source = before + 'Tail' + ' appended text'.repeat(700);
    w.renderMarkdown(source);
    assert.equal(d.querySelector('.whitespace-pre-wrap').textContent, source.slice((before + 'Tail').length));
    assert.equal(d.querySelector('pre'), pre); assert.equal(d.activeElement, button); assert(d.querySelector('[aria-busy="true"]'));
    const worker = w.markdownWorkers.at(-1); assert.equal(worker.sent.length, 1);
    worker.finish(); await sleep(30);
    assert(!d.querySelector('[aria-busy="true"]')); assert(!d.querySelector('.whitespace-pre-wrap')); assert.equal(d.querySelector('pre'), pre); assert.equal(d.querySelector('button'), button); assert(button.querySelector('.lucide-check')); assert.equal(d.activeElement, button);
  });
  await check('first long snapshot is completely readable before parsing; completed/cancelled final tail never waits to be readable', async () => {
    const source = '# Complete answer\n\n' + 'full text '.repeat(1500);
    w.renderMarkdown(source, 'new-message');
    assert.equal(d.querySelector('.whitespace-pre-wrap').textContent, source);
    const worker = w.markdownWorkers.at(-1);
    w.renderMarkdown(source + ' final result', 'new-message');
    assert(d.body.textContent.endsWith(' final result')); assert.equal(worker.sent.length, 1);
    worker.finish(); await sleep(20);
    assert.equal(worker.sent.length, 2); assert(d.body.textContent.endsWith(' final result')); assert.equal(d.querySelector('.whitespace-pre-wrap').textContent, ' final result');
    worker.finish(); await sleep(20); assert(!d.querySelector('[aria-busy="true"]')); assert(d.body.textContent.endsWith(' final result'));
  });
  await check('replacement and unmount reject obsolete worker output and release all worker ownership', async () => {
    const source = 'a '.repeat(5000); w.renderMarkdown(source, 'replace'); const old = w.markdownWorkers.at(-1), active = old.sent[0];
    const replacement = '# New\n\n' + 'b '.repeat(5000); w.renderMarkdown(replacement, 'replace'); old.finish(active); await sleep(20);
    assert.equal(d.querySelector('.whitespace-pre-wrap').textContent, replacement);
    w.renderMarkdown('Short replacement', 'replace'); assert(old.terminated); old.finish(); await sleep(20); assert.equal(d.body.textContent, 'Short replacement');
    w.renderMarkdown(source, 'unmount'); const worker = w.markdownWorkers.at(-1); w.clear(); assert(worker.terminated); worker.finish(); await sleep(20); assert.equal(d.body.textContent, '');
  });
  await check('worker failure falls back to complete safe Markdown; themes and localized code controls still update', async () => {
    const source = '```js\nconsole.log(1);\n```\n\n<script>window.injected=true</script>\n\n[bad](javascript:alert%281%29)\n\n' + 'text '.repeat(2000);
    w.renderMarkdown(source, 'failure'); w.markdownWorkers.at(-1).onerror({}); await sleep(30);
    assert(d.querySelector('pre')); assert(!d.querySelector('script')); assert(!d.querySelector('a[href^="javascript:"]')); assert.equal(w.injected, undefined); assert(d.body.textContent.includes('<script>window.injected=true</script>'));
    w.renderMarkdown(source, 'failure', true); assert(d.querySelector('.text-on-accent')); assert(d.querySelector('pre'));
    w.setLocale('en-US'); await sleep(20); assert(d.querySelector('button[aria-label="Copy code"]'));
  });
  await check('row text updates preserve follow-tail, upward scroll pause, forced resume and session reset', async () => {
    w.renderTimeline(['one', 'two'], 's', 0);
    const viewport = d.querySelector('[aria-live="polite"]'); let height = 1000;
    Object.defineProperty(viewport, 'scrollHeight', { get: () => height }); Object.defineProperty(viewport, 'clientHeight', { get: () => 200 });
    w.renderTimeline(['one', 'two'], 's', 1); assert.equal(viewport.scrollTop, 1000);
    viewport.scrollTop = 500; viewport.dispatchEvent(new w.Event('scroll', { bubbles: true })); height = 1200;
    w.renderTimeline(['one', 'two'], 's', 2); assert.equal(viewport.scrollTop, 500);
    w.renderTimeline(['two', 'one'], 's', 3); assert.equal(viewport.scrollTop, 500);
    w.renderTimeline(['two', 'one', 'three'], 's', 4, 'force'); assert.equal(viewport.scrollTop, 1200);
    viewport.scrollTop = 600; viewport.dispatchEvent(new w.Event('scroll', { bubbles: true })); height = 1300;
    w.renderTimeline(['one'], 'other-session', 5, 'force'); assert.equal(viewport.scrollTop, 1300);
  });
  if (process.env.MARKDOWN_BENCH) {
    const block = '## Update\n\nText with **emphasis** and `code`, [link](https://example.com).\n\n- first\n- second\n\n';
    const median = values => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
    for (const chars of [32000, 64000]) {
      const source = block.repeat(Math.ceil(chars / block.length)).slice(0, chars), samples = [];
      let start = performance.now(); w.renderMarkdown(source, `bench-${chars}`); const firstFullRawCommitMs = performance.now() - start;
      const worker = w.markdownWorkers.at(-1), initial = worker.prepare();
      start = performance.now(); w.flushWorker(worker, initial); const firstFormattedCommitMs = performance.now() - start;
      let next = source;
      for (let index = 0; index < 12; index++) {
        next += ' appended ' + index;
        start = performance.now(); w.renderMarkdown(next, `bench-${chars}`); const rawTailCommitMs = performance.now() - start;
        const ready = worker.prepare(); // Parser work deliberately OUTSIDE UI timing; production does this in the worker.
        start = performance.now(); w.flushWorker(worker, ready); const cachedFormattedCommitMs = performance.now() - start;
        assert(d.body.textContent.trimEnd().endsWith(' appended ' + index));
        if (index >= 3) samples.push({ rawTailCommitMs, cachedFormattedCommitMs });
      }
      console.log(JSON.stringify({ kind: 'production_react_jsdom_commit_proxy_not_browser_paint', chars, firstFullRawCommitMs: +firstFullRawCommitMs.toFixed(2), firstFormattedCommitMs: +firstFormattedCommitMs.toFixed(2), p50RawTailCommitMs: median(samples.map(x => x.rawTailCommitMs)), p50CachedFormattedCommitMs: median(samples.map(x => x.cachedFormattedCommitMs)), maxCachedFormattedCommitMs: +Math.max(...samples.map(x => x.cachedFormattedCommitMs)).toFixed(2) }));
    }
  }
  w.clear(); assert.equal(errors.length, 0, errors.join('\n')); dom.window.close(); fs.rmSync(scratch, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
