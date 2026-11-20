// Real viewport + virtualizer behavior; deterministic geometry, no live provider.
const path = require("node:path"), assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const desktop = path.resolve(__dirname, "../..");
const esbuild = createRequire(require.resolve("vite/package.json", { paths: [desktop] }))("esbuild");
const { JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH || "jsdom");

const errors = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const bundle = await esbuild.build({ write: false, entryPoints: [path.join(__dirname, "conversation-navigation-entry.tsx")],  bundle: true, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".ttf": "dataurl" }, nodePaths: [path.join(desktop, "node_modules")], define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "worker-stub", setup(build) { build.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: "worker" })); build.onLoad({ filter: /.*/, namespace: "worker" }, () => ({ contents: "export default class Worker { postMessage() {} terminate() {} }" })); } }] });
  const log = new VirtualConsole(); log.on("jsdomError", error => errors.push(error.message)); log.on("error", (...args) => errors.push(args.join(" ")));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://unit.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: log });
  const w = dom.window, d = w.document;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe(element) { queueMicrotask(() => element.isConnected && this.callback([{ target: element, borderBoxSize: [{ blockSize: element.offsetHeight, inlineSize: 1100 }], contentRect: element.getBoundingClientRect() }])); } unobserve() {} disconnect() {} };
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.hasAttribute("data-index") ? 120 : 600; } });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 600; } });
  Object.defineProperty(w.HTMLElement.prototype, "scrollHeight", { get() { return Number.parseFloat(this.querySelector("[data-timeline-content]")?.style.height || "600"); } });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this.hasAttribute("data-index") ? Number.parseFloat(this.style.transform.match(/translateY\(([^p]+)/)?.[1] || "0") - (this.parentElement?.parentElement?.scrollTop || 0) : 0;
    return { top, bottom: top + this.offsetHeight, height: this.offsetHeight, width: 1100, left: 0, right: 1100, x: 0, y: top };
  };
  w.HTMLElement.prototype.scrollTo = function (options) { this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, options.top)); w.setTimeout(() => this.dispatchEvent(new w.Event("scroll")), 0); };
  try {
    w.eval(bundle.outputFiles.find(file => file.path.endsWith(".js") || file.path === "<stdout>").text); await pause(150);
    const qa = w.qa, viewport = () => d.querySelector("[aria-live=polite]"), tick = index => d.querySelector(`[data-location="question-${index}"]`);
    assert.deepEqual(errors, []); assert(tick(40), d.body.innerHTML); assert(d.querySelectorAll("[data-index]").length < 30, "600 rows must remain virtualized");
    tick(40).click(); await pause(150);
    assert(d.querySelector('[data-index="80"]'), "jump must mount an off-screen user-message row");
    assert(Math.abs(d.querySelector('[data-index="80"]').getBoundingClientRect().top - 12) < 3, `the target must be aligned after measurement: top=${d.querySelector('[data-index="80"]').getBoundingClientRect().top}, scroll=${viewport().scrollTop}, transform=${d.querySelector('[data-index="80"]').style.transform}`);
    tick(40).focus(); await pause(40);
    assert(d.querySelector(".conversation-navigator-preview").textContent.includes("Answer 40"));
    d.querySelector('[aria-label="添加书签"]').click(); await pause(40);
    assert.equal(tick(40).dataset.bookmarked, "true");
    assert.deepEqual(Array.from(qa.settings.getState().conversationBookmarks.a), ["question-40"]);
    tick(40).dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await pause(40);
    assert.equal(d.activeElement, tick(41));
    tick(41).click(); await pause(120);
    const readingTop = viewport().scrollTop;
    qa.render("b"); await pause(80); qa.render("a"); await pause(120);
    assert(Math.abs(viewport().scrollTop - readingTop) < 3, "returning must restore the old reading position instead of following the tail");
    assert.equal(qa.positions.get("a").follow, false);
    assert.deepEqual(errors, []);
    console.log("PASS virtualized jump, measured alignment, hover preview, persisted bookmark, keyboard navigation and reading-position restore");
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
