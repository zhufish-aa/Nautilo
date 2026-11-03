// Parsing/rendering proxy using the installed Markdown stack. This is SSR,
// not browser paint time or a claim about desktop FPS/model latency.
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
const require = createRequire(new URL("../package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { default: Markdown } = await import(require.resolve("react-markdown"));
const { default: gfm } = await import(require.resolve("remark-gfm"));
const block = "## Update\n\nText with **emphasis** and `code`, [link](https://example.com).\n\n- first\n- second\n\n";
for (const chars of [2000, 8000, 32000, 64000]) {
  const source = block.repeat(Math.ceil(chars / block.length)).slice(0, chars);
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [gfm] }, source));
    if (i >= 3) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ kind: "markdown_ssr_proxy", chars, p50Ms: +samples[3].toFixed(1), maxMs: +samples.at(-1).toFixed(1) }));
}
