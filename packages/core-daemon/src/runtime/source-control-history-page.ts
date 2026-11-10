import {createHash} from "node:crypto";
import {open} from "node:fs/promises";
import {join} from "node:path";
import type {SourceControlHistoryInput, SourceControlHistoryPage, SourceControlCommitSummary} from "@agenthub/schemas";
import type {SourceGitReader} from "./source-control-content.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const validOid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(value);
const invalidCursor = "提交记录游标无效，请刷新。";
const staleCursor = "提交历史、分支或搜索条件已改变，请刷新记录。";

interface Cursor {
  v: 1; root: string; ref: string; query: string; graph: string; head: string; offset: number;
}

function decodeCursor(text?: string): Cursor | undefined {
  if (text == null) return;
  try {
    if (typeof text !== "string" || text.length > 4096 || !/^[\w-]+$/u.test(text)) throw Error();
    const bytes = Buffer.from(text, "base64url");
    if (bytes.toString("base64url") !== text) throw Error();
    const c = JSON.parse(bytes.toString("utf8"));
    if (!c || c.v !== 1 || !validOid(c.head) || !Number.isInteger(c.offset) || c.offset < 0 || c.offset > 0xffffffff) throw Error();
    return c;
  } catch {
    throw new Error(invalidCursor);
  }
}

async function graphSignature(root: string, io: SourceGitReader): Promise<string> {
  let signature = await io.checked(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00", "refs/replace/"]);
  const common = (await io.checked(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).replace(/[\r\n]+$/u, "");
  for (const name of ["shallow", "info/grafts"]) {
    let file;
    try {
      file = await open(join(common, name), "r");
      const max = 4 * 1024 * 1024;
      const digest = createHash("sha256");
      let size = 0;
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const {bytesRead} = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > max) throw new Error("Git 历史边界过大，请在原生终端检查。");
        digest.update(buffer.subarray(0, bytesRead));
      }
      signature += "\0" + name + ":" + digest.digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await file?.close();
    }
  }
  return hash(signature);
}

async function summaries(root: string, io: SourceGitReader, options: string[], head: string): Promise<SourceControlCommitSummary[]> {
  const raw = await io.checked(root, ["log", "--topo-order", "--no-show-signature", "--no-decorate", "--no-notes",
    "--encoding=UTF-8", "-z", "--format=%H%x00%s%x00%an%x00%cI", ...options, head, "--"]);
  if (!raw) return [];
  const fields = raw.split("\0");
  if (fields.pop() !== "" || fields.length % 4) throw new Error("Git 提交记录不完整");
  const rows: SourceControlCommitSummary[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    const [hash, subject, author, committedAt] = fields.slice(i, i + 4);
    if (!validOid(hash)) throw new Error("Git 提交记录无效");
    rows.push({hash, subject, author, committedAt});
  }
  return rows;
}

async function isAncestor(root: string, io: SourceGitReader, oid: string, head: string) {
  const result = await io.git(root, ["merge-base", "--is-ancestor", oid, head], undefined, 8192);
  if (result.code !== 0 && result.code !== 1) throw new Error("无法读取提交历史：" + result.stderr.trim());
  return result.code === 0;
}

export async function readSourceHistory(root: string, input: SourceControlHistoryInput, io: SourceGitReader): Promise<SourceControlHistoryPage> {
  if (input.query != null && typeof input.query !== "string") throw new Error("搜索条件无效");
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 50;
  if (Buffer.byteLength(query) > 2048 || /[\0\r\n]/u.test(query)) throw new Error("搜索内容过长或包含无效字符");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("每页提交数应为 1 到 100");
  const cursor = decodeCursor(input.cursor);
  const symbolic = await io.git(root, ["symbolic-ref", "--quiet", "HEAD"], undefined, 8192);
  if (symbolic.code !== 1 && symbolic.code !== 0) throw new Error("无法读取 Git 分支");
  const target = symbolic.code === 0 ? symbolic.stdout.trim() : "HEAD";
  const live = await io.git(root, ["rev-parse", "--verify", "--quiet", target + "^{commit}"], undefined, 8192);
  if (live.code !== 0) {
    if (symbolic.code === 0 && (await io.git(root, ["show-ref", "--verify", "--quiet", target], undefined, 8192)).code === 1) {
      if (cursor) throw new Error(staleCursor);
      return {rootPath: root, reference: target, query, items: []};
    }
    throw new Error("无法读取当前提交，请检查原生 Git 状态。");
  }
  const currentHead = live.stdout.trim();
  if (!validOid(currentHead)) throw new Error("Git 当前提交无效");
  const page: SourceControlHistoryPage = {rootPath: root, reference: target, query, head: currentHead, currentHead, items: []};
  if (!cursor && /^[a-f\d]{4,64}$/iu.test(query)) {
    const prefix = query.toLowerCase();
    const found = await io.git(root, ["rev-parse", "--verify", "--quiet", prefix + "^{commit}"], undefined, 8192);
    const candidate = found.stdout.trim();
    if (found.code === 0 && validOid(candidate) && candidate.startsWith(prefix)) {
      if (await isAncestor(root, io, candidate, currentHead)) page.items = await summaries(root, io, ["-1"], candidate);
      return page;
    }
  }

  const ref = symbolic.code === 0 ? target : "HEAD@" + currentHead;
  const rootHash = hash(process.platform === "win32" ? root.toLowerCase() : root);
  const queryHash = hash(query);
  const graph = await graphSignature(root, io);
  if (cursor && (cursor.ref !== ref || cursor.root !== rootHash || cursor.query !== queryHash || cursor.graph !== graph ||
      (cursor.head !== currentHead && !await isAncestor(root, io, cursor.head, currentHead)))) throw new Error(staleCursor);

  const head = cursor?.head ?? currentHead;
  const offset = cursor?.offset ?? 0;
  const options = ["--max-count=" + (limit + 1), "--skip=" + offset];
  if (query) options.push("--fixed-strings", "--regexp-ignore-case", "--grep=" + query);
  const records = await summaries(root, io, options, head);
  page.head = head;
  page.items = records.slice(0, limit);
  if (records.length > limit) {
    if (offset + limit > 0xffffffff) throw new Error(invalidCursor);
    const next: Cursor = {v: 1, ref, root: rootHash, query: queryHash, graph, head, offset: offset + limit};
    page.nextCursor = Buffer.from(JSON.stringify(next)).toString("base64url");
  }
  return page;
}
