import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const exports = {};
const code = ts.transpileModule(readFileSync(new URL("../src/renderer/src/lib/highlight.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
vm.runInNewContext(code, { exports, require: createRequire(import.meta.url) });
test("JSON, Rust and Kotlin previews emit syntax tokens while source stays escaped", () => {
  assert.match(exports.highlightCode('{"name":"Nautilo","count":2}', "package.json"), /hljs-attr/);
  assert.match(exports.highlightCode('fn main() { println!("hello"); }', "source.rs"), /hljs-keyword/);
  assert.match(exports.highlightCode('val text = "hello"', "Source.kt"), /hljs-string/);
  assert.equal(exports.languageForPath("D:\\project\\CODE.RS"), "rust");
  assert.equal(exports.highlightCode('<script>alert("x")</script>', "unknown.txt"), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  const longLine = '<"x">'.repeat(10_000);
  assert.equal(exports.highlightLine(longLine, "json"), exports.escapeHtml(longLine));
});
