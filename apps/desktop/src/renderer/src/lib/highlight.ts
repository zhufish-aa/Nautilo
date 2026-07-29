/**
 * Syntax highlighting for the file preview / diff views.
 *
 * Uses highlight.js core with a curated language set (keeps the bundle small);
 * token colors come from our own design tokens in global.css, so both light
 * and dark themes stay consistent with the rest of the app.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dos from "highlight.js/lib/languages/dos";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("go", go);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("less", less);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("protobuf", protobuf);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  css: "css", scss: "scss", less: "less",
  json: "json", md: "markdown", mdx: "markdown",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", swift: "swift",
  html: "xml", htm: "xml", xml: "xml", vue: "xml", svelte: "xml",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "dos",
  graphql: "graphql", gql: "graphql", proto: "protobuf"
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Registered language id for a file path; undefined when the extension is unknown. */
export function languageForPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const extension = filePath.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  const language = EXTENSION_TO_LANGUAGE[extension];
  return language && hljs.getLanguage(language) ? language : undefined;
}

/** Highlights a whole file; falls back to escaped plain text. */
export function highlightCode(code: string, filePath: string): string {
  const language = languageForPath(filePath);
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Highlights a single line in the given language. Used by the diff view,
 * where rows are rendered (and sometimes split into segments) line by line.
 */
export function highlightLine(line: string, language?: string): string {
  if (!line) return " ";
  if (!language) return escapeHtml(line);
  try {
    return hljs.highlight(line, { language, ignoreIllegals: true }).value || " ";
  } catch {
    return escapeHtml(line);
  }
}

/** Highlights a single diff line (diff grammar is line-oriented). */
export function highlightDiffLine(line: string): string {
  if (!line) return " ";
  try {
    return hljs.highlight(line, { language: "diff", ignoreIllegals: true }).value || " ";
  } catch {
    return escapeHtml(line);
  }
}
