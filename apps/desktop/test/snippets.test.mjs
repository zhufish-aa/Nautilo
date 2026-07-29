import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/snippets.ts", import.meta.url);

async function loadSnippets() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

const SNIPPETS = [
  { id: "1", title: "跑测试并修红", text: "运行本项目的测试并修复失败" },
  { id: "2", title: "中文 commit", text: "提交改动并写中文 commit message" }
];

test("snippetQuery only triggers on a leading // without whitespace", async () => {
  const { snippetQuery } = await loadSnippets();
  assert.equal(snippetQuery("//"), "");
  assert.equal(snippetQuery("//测"), "测");
  assert.equal(snippetQuery("//Commit"), "commit");
  // Slash commands and ordinary text must not be treated as snippet queries.
  assert.equal(snippetQuery("/compact"), undefined);
  assert.equal(snippetQuery("//跑 测试"), undefined);
  assert.equal(snippetQuery("a //b"), undefined);
  assert.equal(snippetQuery(""), undefined);
});

test("filterSnippets matches title and text, empty query returns all", async () => {
  const { filterSnippets } = await loadSnippets();
  assert.deepEqual(filterSnippets(SNIPPETS, ""), SNIPPETS);
  assert.deepEqual(filterSnippets(SNIPPETS, "测试").map((item) => item.id), ["1"]);
  assert.deepEqual(filterSnippets(SNIPPETS, "commit").map((item) => item.id), ["2"]);
  assert.deepEqual(filterSnippets(SNIPPETS, "不存在"), []);
});
