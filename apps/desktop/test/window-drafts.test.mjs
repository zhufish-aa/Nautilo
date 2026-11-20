import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/main/window-drafts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('import { ipcMain } from "electron";', 'const ipcMain = globalThis.__draftCloseIpc;');

async function fixture() {
  const ipc = new EventEmitter(), handlers = new Map();
  ipc.handle = (name, handle) => handlers.set(name, handle);
  globalThis.__draftCloseIpc = ipc;
  const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}#${Math.random()}`);
  module.registerDraftCloseHandlers();
  delete globalThis.__draftCloseIpc;
  const win = new EventEmitter(), page = new EventEmitter(), sent = [];
  let destroyed = false, closes = 0;
  page.id = 14;
  page.isDestroyed = () => destroyed;
  page.send = (...args) => sent.push(args);
  win.webContents = page;
  win.isDestroyed = () => destroyed;
  win.close = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    win.emit("close", event);
    if (!event.defaultPrevented) { closes++; destroyed = true; win.emit("closed"); }
  };
  ipc.emit("window:drafts-ready", { sender: page });
  const acknowledge = (saved, owner = page.id) => handlers.get("window:drafts-flushed")({ sender: { id: owner } }, sent.at(-1)[1], saved);
  return { win, page, sent, acknowledge, protect: () => module.protectWindowDrafts(win), closes: () => closes };
}

test("native close waits for its own renderer to save, then closes once", async () => {
  const f = await fixture(); f.protect();
  f.win.close(); f.win.close();
  assert.equal(f.closes(), 0); assert.equal(f.sent.length, 1);
  f.acknowledge(true, 99); assert.equal(f.closes(), 0);
  f.acknowledge(true); assert.equal(f.closes(), 1);
});

test("failed draft save keeps the window open and permits another attempt", async () => {
  const f = await fixture(); f.protect(); f.win.close();
  f.acknowledge(false); assert.equal(f.closes(), 0);
  f.win.close(); assert.equal(f.sent.length, 2);
  f.acknowledge(true); assert.equal(f.closes(), 1);
});

test("an existing close-to-background handler remains in charge", async () => {
  const f = await fixture(); f.win.on("close", event => event.preventDefault()); f.protect();
  f.win.close(); assert.equal(f.sent.length, 0); assert.equal(f.closes(), 0);
  f.win.emit("closed");
});

test("renderer crash releases the pending close without touching destroyed contents", async () => {
  const f = await fixture(); f.protect(); f.win.close();
  f.page.emit("render-process-gone");
  f.acknowledge(true); assert.equal(f.closes(), 0);
  f.win.close(); assert.equal(f.closes(), 1);
});
