import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/renderer/src/lib/streaming-text.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  let cursor = 0, now = 0, nextId = 1, dirty = false, args = [], visible;
  const slots = [], effects = [], frames = new Map();
  const document = new EventTarget();
  const hooks = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, value => { if (value !== slots[i].value) { slots[i].value = value; dirty = true; } }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useLayoutEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) {
        effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
      }
    }
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: () => hooks, document, performance: { now: () => now },
    requestAnimationFrame: fn => { const id = nextId++; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  function render(...props) {
    if (props.length) args = props;
    do {
      dirty = false;
      cursor = 0;
      visible = exports.useSmoothStreamText(...args);
      while (effects.length) effects.shift()();
    } while (dirty);
    return visible;
  }
  function frame(ms) {
    now += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(fn => fn(now));
    return dirty ? render() : visible;
  }
  const visibility = hidden => {
    document.hidden = hidden;
    document.dispatchEvent(new Event("visibilitychange"));
    return render();
  };
  return { render, frame, frames, visibility, unmount: () => slots.forEach(slot => slot?.cleanup?.()) };
}

test("bursts are paced by elapsed time on 60, 120, 144 and 240 Hz displays", () => {
  const results = [];
  const source = "汉".repeat(2_000);
  for (const rate of [60, 120, 144, 240]) {
    const h = harness();
    assert.equal(h.render(source, true, true, true).text, "");
    const first = h.frame(1000 / rate);
    assert.ok(first.text.length > 0 && first.text.length < source.length / 3);
    let visible = first;
    for (let frame = 1; frame < rate * 0.25; frame++) visible = h.frame(1000 / rate);
    results.push(visible.text.length);
    for (let frame = 0; frame < rate * 0.05; frame++) visible = h.frame(1000 / rate);
    assert.equal(visible.text, source);
    assert.equal(h.frames.size, 0, "no loop while the input is idle");
  }
  assert.ok(Math.max(...results) - Math.min(...results) < 55, results.join(", "));
});

test("rapid packets share the next frame and display only complete graphemes", () => {
  const h = harness();
  const pieces = ["汉", "👩‍👩‍👧‍👦", "e\u0301", "🇹🇼", "A", "👍🏽"];
  const valid = new Set(["", ...pieces.map((_, index) => pieces.slice(0, index + 1).join(""))]);
  const text = pieces.join("");
  for (let i = 0; i <= text.length; i++) h.render(text.slice(0, i), true);
  assert.equal(h.frames.size, 1);
  for (let i = 0; i < 32; i++) assert.ok(valid.has(h.frame(1000 / 144).text));
  assert.equal(h.render(text, true).text, text);
  h.render(text + "\ud83d", true);
  assert.equal(h.frame(25).text, text, "a dangling surrogate is never displayed");
});

test("completion and stop drain an existing queue within 180 ms; static history is immediate", () => {
  const h = harness();
  const text = "abcdef".repeat(300);
  h.render(text, true, true, true);
  const first = h.frame(1000 / 60).text;
  assert.ok(first.length < text.length);
  assert.equal(h.render(text, false).text, first);
  for (let i = 0; i < 11; i++) h.frame(1000 / 60);
  assert.equal(h.render(text, false).text, text);
  assert.equal(h.frames.size, 0);
  const history = harness();
  assert.deepEqual({ ...history.render(text, false) }, { text, fade: false });
  assert.equal(history.frames.size, 0);
});

test("backgrounding, disabling animation, and unmount cancel scheduled frames", () => {
  const h = harness();
  h.render("existing", true);
  h.render("existing plus newer output ".repeat(100), true);
  assert.equal(h.frames.size, 1);
  const source = "existing plus newer output ".repeat(100);
  assert.deepEqual({ ...h.visibility(true) }, { text: source, fade: false });
  assert.equal(h.frames.size, 0);
  assert.equal(h.visibility(false).text, source);
  assert.equal(h.render(source + " A new delta", true, false).text, source + " A new delta");
  assert.equal(h.frames.size, 0);
  h.render(source + " A new delta", true);
  h.render(source + " A new delta appended again", true);
  assert.equal(h.frames.size, 1);
  h.unmount();
  assert.equal(h.frames.size, 0);
});
