import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.NAUTILO_JSDOM_PATH ?? 'jsdom')); } catch {}

test('timeline follows delayed process layout, survives collapse, and respects reading history', {
  skip: !JSDOM && 'Set NAUTILO_JSDOM_PATH to an isolated jsdom installation',
}, async () => {
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
  const bundle = await build({
    stdin: { resolveDir: desktop, loader: 'tsx', contents: `
      import React, { StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { TimelineViewport } from './src/renderer/src/features/timeline/Timeline';
      const root = createRoot(document.getElementById('root'));
      window.qa = {
        render: (contentKey = 0, forceFollowKey, sessionKey = 's', active = true) => flushSync(() => root.render(
          <StrictMode><TimelineViewport rows={['user', 'turn'].map(key => ({ key, render: () => <div>{key}</div> }))}
            {...{contentKey, forceFollowKey, sessionKey, active}} /></StrictMode>)),
        close: () => flushSync(() => root.unmount())
      };
    ` },
    bundle: true, platform: 'browser', conditions: ['worker'], format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, nodePaths: [join(desktop, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'unused-workers', setup(build) {
      build.onResolve({ filter: /\?worker/ }, () => ({ path: 'worker', namespace: 'test-worker' }));
      build.onLoad({ filter: /.*/, namespace: 'test-worker' }, () => ({ contents: 'export default class { postMessage() {} terminate() {} }' }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const observers = new Set();
  w.ResizeObserver = class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
  };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.Worker = class {};
  const frame = () => new Promise(resolve => w.requestAnimationFrame(resolve));
  const resized = target => {
    for (const observer of observers) if (observer.targets.has(target)) observer.callback([{ target }]);
  };
  try {
    w.eval(bundle.outputFiles[0].text);
    w.qa.render();
    const viewport = w.document.querySelector('[aria-live="polite"]');
    const content = viewport.querySelector('[data-timeline-content]');
    let height = 1000, viewportHeight = 200, top = 0, writes = 0;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => viewportHeight },
      scrollTop: { get: () => top, set: value => { writes++; top = Math.max(0, Math.min(value, height - viewportHeight)); } },
    });
    const scroll = value => { viewport.scrollTop = value; viewport.dispatchEvent(new w.Event('scroll')); };
    w.qa.render(1);
    assert.equal(top, 800);

    // A child stream/worker updates after the parent's contentKey effect.
    height = 1400; resized(content); resized(content);
    assert.equal(top, 800, 'ResizeObserver must not write layout synchronously');
    const before = writes;
    await frame();
    assert.equal(top, 1200);
    assert.equal(writes, before + 1, 'batch layout changes into one frame');
    resized(content); await frame();
    assert.equal(writes, before + 1, 'already aligned content must not produce a feedback loop');

    // Native browser clamping when a completed process collapses.
    height = 700; scroll(500); resized(content); await frame();
    height = 900; resized(content); await frame();
    assert.equal(top, 700, 'automatic shrink must not disable following the next output');

    // Wheel input arriving between resize notification and the scheduled pin.
    height = 1200; resized(content);
    viewport.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll(600); await frame();
    height = 1400; resized(content); await frame();
    assert.equal(top, 600, 'new tools and reasoning must not pull a reader back down');

    scroll(1150); // Down into the bottom threshold re-enables following.
    height = 1600; resized(content); await frame();
    assert.equal(top, 1400);
    viewportHeight = 150; resized(viewport); await frame();
    assert.equal(top, 1450, 'composer/viewport resizing keeps the newest row visible');

    scroll(700);
    w.qa.render(2, 'new-user-message');
    assert.equal(top, 1450, 'sending a new message resumes follow mode immediately');
    w.qa.render(2, 'new-user-message', 's', false);
    height = 1800; resized(content); await frame();
    assert.equal(top, 1450, 'hidden workbenches must not scroll');
    w.qa.render(2, 'new-user-message', 'other-session', true);
    assert.equal(top, 1650);
    w.qa.close();
    assert.equal(observers.size, 0, 'unmount releases observers and pending frames');
  } finally { w.qa?.close(); w.close(); }
});
