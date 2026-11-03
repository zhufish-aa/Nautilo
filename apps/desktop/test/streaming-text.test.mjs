import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/renderer/src/lib/streaming-text.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  let cursor = 0, now = 0, timerId = 1, dirty = false, props = ["", false, undefined], visible;
  const slots = [], effects = [], timers = new Map();
  const hooks = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, (value) => { if (value !== slots[i].value) { slots[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    }
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: () => hooks, setTimeout: (fn, ms) => { const id = timerId++; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: (id) => timers.delete(id) });
  const render = (text = props[0], streaming = props[1], identity = props[2]) => {
    props = [text, streaming, identity];
    do { dirty = false; cursor = 0; visible = exports.useStreamingText(...props); while (effects.length) effects.shift()(); } while (dirty);
    return visible;
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) { const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); if (dirty) render(); }
    now = end;
    return visible;
  };
  return { ...exports, render, advance, timers, unmount: () => { for (const slot of slots) slot?.cleanup?.(); } };
}

test("adaptive delay leaves short replies at 50ms and caps huge streams at 500ms", () => {
  const h = harness();
  assert.deepEqual([0, 100, 8000, 30000, 60000, 1000000].map(h.streamingTextDelay), [50, 50, 50, 200, 400, 500]);
});

test("first content is immediate, rapid cumulative updates coalesce without append/loss", () => {
  const h = harness();
  assert.equal(h.render("Hello", true), "Hello");
  assert.equal(h.render("Hello there", true), "Hello");
  assert.equal(h.advance(49), "Hello");
  assert.equal(h.advance(1), "Hello there");
  const long = "x".repeat(60000);
  h.render(long, true);
  for (let i = 0; i < 100; i++) h.render(long + i, true);
  assert.equal(h.timers.size, 1);
  assert.equal(h.advance(399), "Hello there");
  assert.equal(h.advance(1), long + "99");
});

test("completion or cancellation flushes final content immediately and clears stale timers", () => {
  const h = harness();
  const long = "x".repeat(60000);
  h.render(long, true); h.advance(400);
  h.render(long + " partial", true);
  assert.equal(h.render(long + " final", false), long + " final");
  assert.equal(h.timers.size, 0);
  assert.equal(h.advance(1000), long + " final");
});

test("unmount clears pending work instead of retaining obsolete message content", () => {
  const h = harness();
  h.render("old", true); h.render("old updated", true);
  h.unmount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.advance(1000), "old");
});


test("empty-to-first-content and message identity changes render immediately without old timers", () => {
  const h = harness();
  h.render("", true, "session:one");
  assert.equal(h.render("First", true, "session:one"), "First");
  assert.equal(h.timers.size, 0);
  h.render("x".repeat(100000), true, "session:one");
  assert.equal(h.render("New message", true, "other:two"), "New message");
  assert.equal(h.timers.size, 0);
  assert.equal(h.advance(1000), "New message");
});

test("long-to-short replacement re-arms at the short cadence", () => {
  const h = harness();
  h.render("x".repeat(100000), true, "one");
  assert.equal(h.render("short", true, "one"), "x".repeat(100000));
  assert.equal(h.advance(49), "x".repeat(100000));
  assert.equal(h.advance(1), "short");
});
