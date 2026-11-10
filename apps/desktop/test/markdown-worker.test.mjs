import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(new URL("../package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { default: Markdown } = await import(pathToFileURL(require.resolve("react-markdown")).href);
const { default: gfm } = await import(pathToFileURL(require.resolve("remark-gfm")).href);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const pluginSource = await readFile(new URL("../markdown-worker.vite.ts", import.meta.url), "utf8");
const pluginModule = ts.transpileModule(pluginSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { markdownEntitiesPlugin } = await import(`data:text/javascript,${encodeURIComponent(pluginModule)}`);
const optimizer = markdownEntitiesPlugin().config().optimizeDeps;
// Use normal browser conditions, just as Vite's dev prebundler does. There
// is no document in this test runtime: selecting the DOM entry fails here.
const parsedBundle = await build({ stdin: { contents: 'export { parseMarkdownFragments } from "./src/renderer/src/lib/markdown-parse"; export { normalizeMarkdownLocalLinks } from "./src/renderer/src/lib/file-references";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) }, bundle: true, platform: "browser", plugins: optimizer.esbuildOptions.plugins, format: "esm", write: false, define: { "process.env.NODE_ENV": '"test"' } });
const temporary = await mkdtemp(path.join(tmpdir(), "nautilo-markdown-test-"));
after(() => rm(temporary, { recursive: true, force: true }));
const parserFile = path.join(temporary, "parser.mjs");
await writeFile(parserFile, parsedBundle.outputFiles[0].text);
const { parseMarkdownFragments, normalizeMarkdownLocalLinks } = await import(pathToFileURL(parserFile).href);
const queueSource = await readFile(new URL("../src/renderer/src/lib/markdown-worker-queue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(queueSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { MarkdownWorkerQueue } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
const original = source => renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [gfm] }, normalizeMarkdownLocalLinks(source)));
const fragmented = source => renderToStaticMarkup(React.createElement(React.Fragment, {}, ...parseMarkdownFragments(source).map((serialized, key) => React.createElement(Markdown, { key, rehypePlugins: [() => () => JSON.parse(serialized)] }, ""))));
const gap = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.\n\n`).join("");
const fixtures = [
  "# Title\n\n**strong _nested_** ~~deleted~~ `inline` https://example.com?a=1&b=2\n\n---\n",
  "A setext heading\n----------------\n\n> Quote\n>\n> - first\n> - second\n",
  "- tight\n- next\n  - nested\n\n- loose paragraph\n\n  second paragraph\n\n1. ordered\n2. two\n\n- [x] done\n- [ ] not done\n",
  "| a | b |\n|:--|--:|\n| `c` | a\\|b |\n| d | **e** |\n",
  "Before\n\n```js\nconst sample = '[link][ref]';\n\n# not a heading\n```\n\nAfter\n\n~~~text\nunclosed fence\n",
  `[forward][ref] [shortcut] [ref][] ![alt][image]\n\n${gap}[ref]: https://example.com/target \"Title\"\n[shortcut]: /path/to/source.ts\n[image]: https://example.com/image.png\n\n[ref]: https://ignored.example\n`,
  `A note[^later] and another[^second].\n\n${gap}Repeated[^later].\n\n[^later]: First note\n\n    Continued paragraph\n\n[^second]: Second note\n`,
  '<script>alert("bad")</script>\n\n<div onclick="alert(1)">raw HTML</div>\n\n[unsafe](javascript:alert%281%29) ![data](data:text/html;base64,AAAA) [safe](https://example.com)\n',
  '[local](C:\\project\\file.ts) [web](https://example.com)\n\n`C:\\project\\file.ts` /project/file.ts\n',
  "Escapes \\* and &amp; entities\n\n    indented code\n\n<https://example.com> and <user@example.com>\n"
];

test("whole-document AST fragments preserve all Markdown/GFM semantics and safe HTML/URLs", () => {
  for (const source of fixtures) assert.equal(fragmented(source), original(source), source.slice(0, 80));
  const unsafe = fragmented(fixtures[7]);
  assert(!unsafe.includes('<script>'));
  assert(!unsafe.includes('href="javascript:'));
  assert(!unsafe.includes('src="data:'));
  assert(unsafe.includes('&lt;script&gt;'));
});

test("unfinished streaming prefixes remain equivalent, including closing syntax added later", () => {
  for (const source of fixtures) {
    for (let length = 0; length <= source.length; length += 11) assert.equal(fragmented(source.slice(0, length)), original(source.slice(0, length)), `prefix ${length}: ${source.slice(0, 40)}`);
  }
});

test("unchanged parsed fragments are exact-equal; late references invalidate earlier fragments", () => {
  const initial = parseMarkdownFragments(gap + "Tail");
  const appended = parseMarkdownFragments(gap + "Tail appended");
  assert(initial.length > 1);
  assert.equal(initial[0], appended[0]);
  assert.notEqual(initial.at(-1), appended.at(-1));
  const before = parseMarkdownFragments(`[target]\n\n${gap}`);
  const after = parseMarkdownFragments(`[target]\n\n${gap}[target]: https://example.com\n`);
  assert.notEqual(before[0], after[0]);
});

function harness() {
  const worker = { sent: [], terminated: false, onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message) { this.sent.push(message); }, terminate() { this.terminated = true; } };
  let emptied = 0;
  const queue = new MarkdownWorkerQueue(worker, () => emptied++);
  const finish = (message = worker.sent.at(-1)) => worker.onmessage?.({ data: { id: message.id, fragments: [message.source] } });
  return { queue, worker, finish, emptyCount: () => emptied };
}

test("worker queue retains only one active and latest pending snapshot and flushes final content", () => {
  const h = harness(), results = [];
  const subscription = h.queue.subscribe((source) => results.push(source), () => assert.fail("unexpected failure"));
  subscription.update("first");
  for (let index = 0; index < 100; index++) subscription.update(`update ${index}`);
  subscription.update("final after completion/cancellation");
  assert.equal(h.worker.sent.length, 1);
  h.finish();
  assert.equal(h.worker.sent.length, 2);
  assert.equal(h.worker.sent[1].source, "final after completion/cancellation");
  h.finish();
  assert.deepEqual(results, ["first", "final after completion/cancellation"]);
  subscription.dispose();
  assert(h.worker.terminated);
  assert.equal(h.emptyCount(), 1);
});

test("disposed messages cannot receive stale results; other owners are not starved", () => {
  const h = harness(), results = [];
  const a = h.queue.subscribe(source => results.push(`a:${source}`), () => {});
  const b = h.queue.subscribe(source => results.push(`b:${source}`), () => {});
  a.update("old"); b.update("other"); a.update("new");
  const old = h.worker.sent[0]; a.dispose(); h.finish(old);
  assert.deepEqual(results, []);
  assert.equal(h.worker.sent[1].source, "other");
  h.finish(old); assert.deepEqual(results, [], "duplicate/out-of-order replies are ignored");
  h.finish(); assert.deepEqual(results, ["b:other"]);
  b.dispose(); assert(h.worker.terminated);
});

test("worker error, message decoding error and posting failure signal a synchronous fallback", () => {
  for (const mode of ["onerror", "onmessageerror", "post"]) {
    const h = harness(); let failures = 0;
    h.queue.subscribe(() => assert.fail(), () => failures++);
    const a = h.queue.subscribe(() => assert.fail(), () => failures++);
    if (mode === "post") { h.worker.postMessage = () => { throw new Error("blocked worker"); }; a.update("source"); }
    else {
      let prevented = false;
      h.worker[mode]({ preventDefault() { prevented = true; } });
      assert(prevented, "Handled worker errors must not become fatal window errors");
    }
    assert.equal(failures, 2); assert(h.worker.terminated); assert.equal(h.emptyCount(), 1);
  }
});

test("disposing an active owner restarts the worker immediately for other waiting messages", () => {
  const workers = [];
  const create = () => {
    const worker = { sent: [], onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage(message) { this.sent.push(message); }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  };
  const queue = new MarkdownWorkerQueue(create(), () => {}, create), results = [];
  const obsolete = queue.subscribe(() => assert.fail(), () => assert.fail());
  const visible = queue.subscribe(source => results.push(source), () => assert.fail());
  obsolete.update("huge obsolete snapshot"); visible.update("visible snapshot");
  obsolete.dispose();
  assert(workers[0].terminated); assert.equal(workers.length, 2); assert.equal(workers[1].sent[0].source, "visible snapshot");
  const request = workers[1].sent[0]; workers[1].onmessage({ data: { id: request.id, fragments: [request.source] } });
  assert.deepEqual(results, ["visible snapshot"]); visible.dispose(); assert(workers[1].terminated);
});
