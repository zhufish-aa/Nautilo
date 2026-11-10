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
  fs.writeFileSync(entry, `import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom'; import {MarkdownContent} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/features/timeline/MarkdownContent'))}; import {I18nProvider} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/lib/i18n'))}; import {TimelineViewport} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/features/timeline/Timeline'))}; import {useSettingsStore} from ${JSON.stringify(path.join(desktop, 'src/renderer/src/stores/settings'))}; const root=createRoot(document.getElementById('root')!); window.renderMarkdown=(source,key='message',inverted=false)=>flushSync(()=>root.render(<I18nProvider><MarkdownContent key={key} source={source} inverted={inverted} /></I18nProvider>)); window.renderTimeline=(keys,sessionKey,contentKey,forceFollowKey)=>flushSync(()=>root.render(<I18nProvider><TimelineViewport rows={keys.map(key=>({key,render:()=>key}))} sessionKey={sessionKey} contentKey={contentKey} forceFollowKey={forceFollowKey}/></I18nProvider>)); window.setLocale=locale=>flushSync(()=>useSettingsStore.setState({locale})); window.flushTask=fn=>flushSync(fn); window.flushWorker=(worker,data)=>flushSync(()=>worker.onmessage({data})); window.clear=()=>flushSync(()=>root.render(null));`);
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
  const copySelection = async () => { await w.navigator.clipboard.writeText(w.getSelection().toString()); return copied; };
  const nativeSetTimeout = w.setTimeout.bind(w), nativeClearTimeout = w.clearTimeout.bind(w);
  const heldTimers = new Map(); let timerId = -1, holdTimers = false, profileTasks = false, taskTimes = [];
  w.setTimeout = (fn, delay = 0, ...args) => {
    if (holdTimers && delay === 0) { const id = timerId--; heldTimers.set(id, () => fn(...args)); return id; }
    return nativeSetTimeout(() => {
      const start = performance.now();
      if (profileTasks && delay === 0) { w.flushTask(() => fn(...args)); taskTimes.push(performance.now() - start); }
      else fn(...args);
    }, delay);
  };
  w.clearTimeout = id => { if (heldTimers.has(id)) heldTimers.delete(id); else nativeClearTimeout(id); };
  const step = () => {
    const [id, fn] = heldTimers.entries().next().value ?? [];
    assert(fn, 'expected a scheduled preparation task'); heldTimers.delete(id); w.flushTask(fn);
  };
  const finishMount = () => { let steps = 0; while (heldTimers.size) { assert(++steps < 1000, 'preparation must terminate'); step(); } return steps; };
  const waitForFormatted = async () => {
    const deadline = performance.now() + 5000;
    while (d.querySelector('[data-markdown-formatted]')?.hidden) { assert(performance.now() < deadline, 'initial formatting did not finish'); await sleep(1); }
  };
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
  const longDocument = '```js\nconsole.log("full copy");\n```\n\n' + Array.from({ length: 300 }, (_, i) => `Paragraph ${i}: complete searchable content ${i}.\n\n`).join('');
  await check('large first DOM mount is bounded, full raw text stays visible, and a selection postpones reveal', async () => {
    w.clear(); holdTimers = true; w.renderMarkdown(longDocument, 'progressive-selection');
    const raw = d.querySelector('[data-markdown-raw]'), sourceNode = raw.firstChild;
    const worker = w.markdownWorkers.at(-1), response = worker.prepare(); assert(response.fragments.length > 4);
    w.flushWorker(worker, response);
    const formatted = d.querySelector('[data-markdown-formatted]');
    assert(formatted.hidden); assert.equal(formatted.getAttribute('aria-hidden'), 'true'); assert(formatted.hasAttribute('inert')); assert.equal(formatted.style.display, 'none');
    assert.equal(raw.textContent, longDocument); assert.equal(heldTimers.size, 1); assert.equal(formatted.childElementCount, 0);
    step(); assert(formatted.hidden); assert(formatted.childElementCount > 0);
    const maximumFirstBatch = response.fragments.slice(0, 2).flatMap(json => JSON.parse(json).children).filter(node => node.type === 'element').length;
    assert.equal(formatted.childElementCount, maximumFirstBatch); assert.equal(raw.firstChild, sourceNode); assert.equal(raw.textContent, longDocument);
    const range = d.createRange(); range.setStart(sourceNode, 10); range.setEnd(sourceNode, 30);
    const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    w.flushTask(() => d.dispatchEvent(new w.Event('selectionchange')));
    const selected = selection.toString(); finishMount();
    assert(formatted.hidden); assert.equal(selection.toString(), selected); assert.equal(d.querySelector('[data-markdown-raw]'), raw);
    assert(raw.textContent.includes('Paragraph 299: complete searchable content 299.'));
    const live = d.querySelector('[aria-busy="true"]'); assert(live); assert.equal(live.querySelectorAll('[aria-live]').length, 0, 'no second live region re-announces prepared text');
    w.flushTask(() => { selection.removeAllRanges(); d.dispatchEvent(new w.Event('selectionchange')); });
    assert(!formatted.hidden); assert(!formatted.hasAttribute('inert')); assert(!formatted.hasAttribute('aria-hidden')); assert.equal(formatted.style.display, 'contents'); assert(!d.querySelector('[data-markdown-raw]'));
    assert.equal(d.querySelectorAll('p').length, 300); holdTimers = false;
  });
  await check('a selected first raw snapshot survives streaming appends and final formatting availability', async () => {
    w.clear(); holdTimers = true; w.renderMarkdown(longDocument, 'selected-append');
    const raw = d.querySelector('[data-markdown-raw]'), text = raw.firstChild;
    const range = d.createRange(); range.setStart(text, 12); range.setEnd(text, 32); const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    w.flushTask(() => d.dispatchEvent(new w.Event('selectionchange'))); const selected = selection.toString(), copiedBefore = await copySelection();
    const updated = longDocument + '\nAppend while selecting'; w.renderMarkdown(updated, 'selected-append');
    assert.equal(raw.firstChild, text); assert.equal(selection.toString(), selected); assert.equal(raw.textContent, updated);
    const worker = w.markdownWorkers.at(-1); w.flushWorker(worker, worker.prepare());
    if (worker.sent.at(-1).source === updated) w.flushWorker(worker, worker.prepare()); finishMount();
    assert.equal(selection.toString(), selected); assert.equal(d.querySelector('[data-markdown-raw]'), raw); assert.equal(raw.textContent, updated); assert(d.querySelector('[data-markdown-formatted]').hidden);
    assert.equal(await copySelection(), copiedBefore); console.log(JSON.stringify({ case: 'initial_selection_clipboard_proxy', before: copiedBefore, after: copied, identical: true }));
    w.flushTask(() => { selection.removeAllRanges(); d.dispatchEvent(new w.Event('selectionchange')); }); finishMount(); assert(!d.querySelector('[data-markdown-raw]')); holdTimers = false;
  });
  await check('selected streaming tail and formatted text survive appends and worker completion', async () => {
    w.clear(); holdTimers = true; w.renderMarkdown(longDocument, 'selected-tail'); const worker = w.markdownWorkers.at(-1); w.flushWorker(worker, worker.prepare()); finishMount();
    const updated = longDocument + '\nnew selectable tail'; w.renderMarkdown(updated, 'selected-tail'); const raw = d.querySelector('[data-markdown-raw]'), text = raw.firstChild;
    const selection = w.getSelection(), range = d.createRange(); range.setStart(text, 1); range.setEnd(text, 15); selection.removeAllRanges(); selection.addRange(range);
    w.flushTask(() => d.dispatchEvent(new w.Event('selectionchange'))); const selected = selection.toString(), copiedBefore = await copySelection();
    w.flushWorker(worker, worker.prepare()); assert.equal(d.querySelector('[data-markdown-raw]'), raw); assert.equal(selection.toString(), selected);
    const final = updated + ' and completed'; w.renderMarkdown(final, 'selected-tail'); assert.equal(raw.firstChild, text); assert.equal(selection.toString(), selected); assert.equal(raw.textContent, '\nnew selectable tail and completed');
    w.flushWorker(worker, worker.prepare()); assert.equal(selection.toString(), selected); assert.equal(d.querySelector('[data-markdown-raw]'), raw);
    assert.equal(await copySelection(), copiedBefore); console.log(JSON.stringify({ case: 'streaming_tail_clipboard_proxy', before: copiedBefore, after: copied, identical: true }));
    w.flushTask(() => { selection.removeAllRanges(); d.dispatchEvent(new w.Event('selectionchange')); }); assert(!d.querySelector('[data-markdown-raw]')); assert(d.body.textContent.includes('new selectable tail and completed'));
    const paragraph = d.querySelector('p'), child = paragraph.firstChild; const formattedRange = d.createRange(); formattedRange.setStart(child, 2); formattedRange.setEnd(child, 10); selection.addRange(formattedRange);
    w.flushTask(() => d.dispatchEvent(new w.Event('selectionchange'))); const formattedSelection = selection.toString();
    w.renderMarkdown(final + ' more', 'selected-tail'); w.flushWorker(worker, worker.prepare()); assert.equal(selection.toString(), formattedSelection); assert.equal(d.querySelector('p'), paragraph); assert(d.querySelector('[data-markdown-raw]').textContent.endsWith(' more'));
    w.flushTask(() => { selection.removeAllRanges(); d.dispatchEvent(new w.Event('selectionchange')); }); holdTimers = false;
  });
  await check('native Find shortcut keeps its raw target until Escape or an explicit keyboard-accessible switch', async () => {
    w.clear(); holdTimers = true; w.renderMarkdown(longDocument, 'progressive-find');
    const raw = d.querySelector('[data-markdown-raw]');
    const find = new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    w.flushTask(() => d.dispatchEvent(find)); assert(!find.defaultPrevented);
    const worker = w.markdownWorkers.at(-1); w.flushWorker(worker, worker.prepare()); finishMount();
    assert(d.querySelector('[data-markdown-formatted]').hidden); assert.equal(d.querySelector('[data-markdown-raw]'), raw);
    const reveal = [...d.querySelectorAll('button')].find(button => button.textContent === 'Show formatted text'); assert(reveal); reveal.focus();
    w.flushTask(() => reveal.click()); assert(!d.querySelector('[data-markdown-formatted]').hidden); assert(!d.querySelector('[data-markdown-raw]'));
    assert.equal(d.activeElement.getAttribute('tabindex'), '-1'); assert(d.activeElement.contains(d.querySelector('pre')));
    const copy = d.querySelector('button[aria-label="Copy code"]'); copy.click(); await sleep(10); assert.equal(copied, 'console.log("full copy");');
    w.clear(); w.renderMarkdown(longDocument, 'progressive-find-escape');
    w.flushTask(() => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })));
    const other = w.markdownWorkers.at(-1); w.flushWorker(other, other.prepare()); finishMount(); assert(d.querySelector('[data-markdown-formatted]').hidden);
    w.flushTask(() => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); assert(!d.querySelector('[data-markdown-formatted]').hidden); holdTimers = false;
  });
  await check('preparation completion/cancellation keeps final text; replacement and unmount cancel old DOM work', async () => {
    w.clear(); holdTimers = true; w.renderMarkdown(longDocument, 'progressive-final');
    let worker = w.markdownWorkers.at(-1); w.flushWorker(worker, worker.prepare()); step();
    const final = longDocument + '\nFinal cancelled/completed result'; w.renderMarkdown(final, 'progressive-final'); assert.equal(d.querySelector('[data-markdown-raw]').textContent, final);
    w.flushWorker(worker, worker.prepare()); finishMount(); assert(d.body.textContent.includes('Final cancelled/completed result')); assert(!d.querySelector('[data-markdown-raw]'));
    w.clear(); w.renderMarkdown(longDocument, 'progressive-replace'); worker = w.markdownWorkers.at(-1); w.flushWorker(worker, worker.prepare()); step();
    const obsoleteTimer = heldTimers.values().next().value;
    w.renderMarkdown('Replacement\n\n' + longDocument, 'progressive-replace'); assert.equal(heldTimers.size, 0); assert.equal(d.querySelector('[data-markdown-raw]').textContent, 'Replacement\n\n' + longDocument);
    w.flushTask(obsoleteTimer); assert.equal(d.querySelector('[data-markdown-formatted]').childElementCount, 0);
    w.flushWorker(worker, worker.prepare()); step(); assert(heldTimers.size);
    w.clear(); assert.equal(heldTimers.size, 0); assert(worker.terminated); assert.equal(d.body.textContent, ''); holdTimers = false;
  });
  await check('reduced-motion preference introduces no animation and still reveals the entire prepared document', async () => {
    w.matchMedia = media => ({ matches: media.includes('prefers-reduced-motion'), media, addEventListener() {}, removeEventListener() {} });
    holdTimers = true; w.renderMarkdown(longDocument, 'reduced-motion'); const worker = w.markdownWorkers.at(-1); w.flushWorker(worker, worker.prepare()); finishMount();
    const formatted = d.querySelector('[data-markdown-formatted]'); assert(!formatted.hidden); assert.equal(formatted.style.animation, ''); assert.equal(formatted.style.transition, ''); assert.equal(d.querySelectorAll('p').length, 300); holdTimers = false;
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
      taskTimes = []; profileTasks = true;
      const preparationStart = performance.now();
      start = performance.now(); w.flushWorker(worker, initial); const firstWorkerDeliveryCommitMs = performance.now() - start;
      await waitForFormatted();
      const firstFormattedWallMs = performance.now() - preparationStart; profileTasks = false;
      const initialTaskTimes = [...taskTimes];
      let next = source;
      for (let index = 0; index < 12; index++) {
        next += ' appended ' + index;
        start = performance.now(); w.renderMarkdown(next, `bench-${chars}`); const rawTailCommitMs = performance.now() - start;
        const ready = worker.prepare(); // Parser work deliberately OUTSIDE UI timing; production does this in the worker.
        start = performance.now(); w.flushWorker(worker, ready); const cachedFormattedCommitMs = performance.now() - start;
        assert(d.body.textContent.trimEnd().endsWith(' appended ' + index));
        if (index >= 3) samples.push({ rawTailCommitMs, cachedFormattedCommitMs });
      }
      console.log(JSON.stringify({ kind: 'production_react_jsdom_commit_proxy_not_browser_paint', chars, firstFullRawCommitMs: +firstFullRawCommitMs.toFixed(2), firstWorkerDeliveryCommitMs: +firstWorkerDeliveryCommitMs.toFixed(2), firstFormattedWallMs: +firstFormattedWallMs.toFixed(2), preparationTasks: initialTaskTimes.length, maxPreparationCommitMs: +Math.max(...initialTaskTimes).toFixed(2), p50PreparationCommitMs: median(initialTaskTimes), p50RawTailCommitMs: median(samples.map(x => x.rawTailCommitMs)), p50CachedFormattedCommitMs: median(samples.map(x => x.cachedFormattedCommitMs)), maxCachedFormattedCommitMs: +Math.max(...samples.map(x => x.cachedFormattedCommitMs)).toFixed(2) }));
    }
  }
  w.clear(); assert.equal(errors.length, 0, errors.join('\n')); dom.window.close(); fs.rmSync(scratch, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
