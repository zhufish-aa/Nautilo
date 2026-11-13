import type { DatabaseSync } from "node:sqlite";
import type {
  RequestLog,
  RequestLogPage,
  RequestLogQuery,
} from "@agenthub/schemas";
import { JsonRepository } from "./json-repository.js";

export class RequestLogRepository extends JsonRepository<RequestLog> {
  constructor(db: DatabaseSync) {
    super(db, "request_logs");
  }
  page(input: RequestLogQuery): RequestLogPage {
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 40)));
    const [time = "", id = ""] = (input.before ?? "").split("|");
    const items = this.db
      .prepare(
        "SELECT data FROM request_logs WHERE (?1='' OR json_extract(data,'$.sessionId')=?1) AND (?2='' OR json_extract(data,'$.providerId')=?2) AND (?3='' OR json_extract(data,'$.status')=?3) AND (?4='' OR json_extract(data,'$.createdAt') < ?4 OR (json_extract(data,'$.createdAt')=?4 AND id < ?5)) ORDER BY json_extract(data,'$.createdAt') DESC, id DESC LIMIT ?6",
      )
      .all(
        input.sessionId ?? "",
        input.providerId ?? "",
        input.status ?? "",
        time,
        id,
        limit + 1,
      )
      .map((row) => JSON.parse(String(row.data)) as RequestLog);
    const more = items.length > limit;
    items.length = Math.min(items.length, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: more && last ? `${last.createdAt}|${last.id}` : undefined,
    };
  }
  interruptOpen(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE request_logs SET data=json_set(data,'$.status','interrupted','$.updatedAt',?1,'$.failure',json_object('stage','daemon','code','DAEMON_RESTARTED','message','The daemon exited before this request finished.')), updated_at=?1 WHERE json_extract(data,'$.status') IN ('queued','preparing','running')",
      )
      .run(now);
  }
}
