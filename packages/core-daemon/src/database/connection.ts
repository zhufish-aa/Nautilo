import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class DatabaseConnection {
  readonly raw: DatabaseSync;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.raw = new DatabaseSync(filePath);
    // busy_timeout: two daemon processes can share one data dir during the
    // Electron→Tauri migration; writers must wait for each other instead of
    // failing (or racing) on the write lock.
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }
  close(): void { this.raw.close(); }
}
