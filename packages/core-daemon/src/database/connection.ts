import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class DatabaseConnection {
  readonly raw: DatabaseSync;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.raw = new DatabaseSync(filePath);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  }
  close(): void { this.raw.close(); }
}
