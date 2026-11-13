import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
type Node = { start: number; end: number; props: Map<string, Node> };
function space(text: string, at: { i: number }): void {
  while (at.i < text.length) {
    if (/\s/.test(text[at.i])) at.i++;
    else if (text.startsWith("//", at.i)) {
      const end = text.indexOf("\n", at.i);
      at.i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", at.i)) {
      const end = text.indexOf("*/", at.i + 2);
      if (end < 0) throw Error("Unterminated config comment");
      at.i = end + 2;
    } else break;
  }
}
function string(text: string, at: { i: number }): string {
  const start = at.i++;
  while (at.i < text.length) {
    if (text[at.i] === "\\") at.i += 2;
    else if (text[at.i++] === '"') return JSON.parse(text.slice(start, at.i));
  }
  throw Error("Unterminated config string");
}
function readNode(text: string, at: { i: number }, depth = 0): Node {
  if (depth > 64) throw Error("Config nesting limit exceeded");
  space(text, at);
  const start = at.i,
    props = new Map<string, Node>();
  const first = text[at.i];
  if (first === "{" || first === "[") {
    at.i++;
    const end = first === "{" ? "}" : "]";
    while (true) {
      space(text, at);
      if (text[at.i] === end) {
        at.i++;
        break;
      }
      if (first === "{") {
        if (text[at.i] !== '"') throw Error("Expected config key");
        const key = string(text, at);
        space(text, at);
        if (text[at.i++] !== ":") throw Error("Expected config colon");
        props.set(key, readNode(text, at, depth + 1));
      } else readNode(text, at, depth + 1);
      space(text, at);
      if (text[at.i] === ",") at.i++;
      else if (text[at.i] !== end) throw Error("Expected config separator");
    }
  } else if (first === '"') string(text, at);
  else {
    while (
      at.i < text.length &&
      !/[\s,\]}]/.test(text[at.i]) &&
      !text.startsWith("/*", at.i) &&
      !text.startsWith("//", at.i)
    )
      at.i++;
    JSON.parse(text.slice(start, at.i));
  }
  return { start, end: at.i, props };
}
function root(text: string): Node {
  const at = { i: 0 },
    result = readNode(text, at);
  space(text, at);
  if (at.i !== text.length || text[result.start] !== "{")
    throw Error("Config must be an object");
  return result;
}
function decode(text: string): unknown {
  const at = { i: 0 };
  let out = "";
  while (at.i < text.length) {
    if (text[at.i] === '"') {
      const start = at.i;
      string(text, at);
      out += text.slice(start, at.i);
    } else if (text.startsWith("//", at.i) || text.startsWith("/*", at.i))
      space(text, at);
    else if (text[at.i] === ",") {
      const look = { i: at.i + 1 };
      space(text, look);
      if (!/[}\]]/.test(text[look.i] ?? "")) out += ",";
      at.i++;
    } else out += text[at.i++];
  }
  return JSON.parse(out);
}
export function configGet(
  text: string,
  format: "json" | "toml",
  path: string[],
): unknown {
  if (format === "toml") {
    let value: unknown = parseToml(text);
    for (const key of path)
      value =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return value;
  }
  let current = root(text);
  for (const key of path) {
    const child = current.props.get(key);
    if (!child) return undefined;
    current = child;
  }
  return decode(text.slice(current.start, current.end));
}
export function configSet(
  text: string,
  format: "json" | "toml",
  path: string[],
  value: unknown,
): string {
  if (format === "toml") {
    // Replace this one server's table and child tables; all unrelated text is retained.
    const section = path
      .map((key) => (/^[\w-]+$/.test(key) ? key : JSON.stringify(key)))
      .join(".");
    const lines = text.split(/(?<=\n)/),
      kept: string[] = [];
    let skip = false;
    for (const line of lines) {
      const match = /^\s*\[([^\]]+)\]/.exec(line);
      if (match)
        skip = match[1] === section || match[1].startsWith(`${section}.`);
      if (!skip) kept.push(line);
    }
    let wrapped: unknown = value;
    for (const key of [...path].reverse()) wrapped = { [key]: wrapped };
    const encoded = stringifyToml(wrapped as Record<string, unknown>);
    return `${kept.join("").trimEnd()}\n\n${encoded}`;
  }
  let current = root(text);
  for (let index = 0; index < path.length; index++) {
    const key = path[index],
      next = current.props.get(key);
    if (next) {
      if (index === path.length - 1)
        return (
          text.slice(0, next.start) +
          JSON.stringify(value, null, 2) +
          text.slice(next.end)
        );
      if (text[next.start] !== "{")
        throw Error("MCP section must be an object");
      current = next;
      continue;
    }
    let nested = value;
    for (const segment of path.slice(index + 1).reverse())
      nested = { [segment]: nested };
    const insert = current.end - 1,
      last = [...current.props.values()].at(-1),
      look = { i: last?.end ?? current.start + 1 };
    space(text, look);
    const comma = last && text[look.i] !== "," ? "," : "";
    const suffix = `\n  ${JSON.stringify(key)}: ${JSON.stringify(nested, null, 2)}\n`;
    let result = text.slice(0, insert) + suffix + text.slice(insert);
    if (comma && last)
      result = result.slice(0, last.end) + comma + result.slice(last.end);
    return result;
  }
  throw Error("Empty edit path");
}
