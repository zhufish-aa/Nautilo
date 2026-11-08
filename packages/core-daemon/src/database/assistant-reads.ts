import type { IpcRequestMap } from "@agenthub/schemas";
import type { DatabaseSync } from "node:sqlite";
import type {
  AssistantLookup,
  AssistantRead,
  AssistantSessionPage,
  AssistantExcerptPage,
} from "@agenthub/schemas";
import { CoreError } from "../errors.js";

export function assistantRecords(db: DatabaseSync, input: IpcRequestMap["assistant.records"]["input"]) {
  return db
    .prepare(
      "SELECT rowid AS seq, data FROM assistant_records WHERE kind=? AND rowid>? AND (?=0 OR rowid<?) AND (?='' OR instr(lower(data),lower(?))>0) ORDER BY rowid " +
        (input.oldest ? "ASC" : "DESC") +
        " LIMIT ?",
    )
    .all(
      input.kind,
      input.after ?? 0,
      input.before ?? 0,
      input.before ?? 0,
      input.query ?? "",
      input.query ?? "",
      Math.max(1, Math.min(40, input.limit ?? 24)),
    )
    .map((row) => ({ seq: Number(row.seq), value: JSON.parse(String(row.data)) }));
}
export function saveAssistantRecord(db: DatabaseSync, input: IpcRequestMap["assistant.save"]["input"]) {
  const data = JSON.stringify(input.value);
  if (
    !["turn", "settings", "memory"].includes(input.kind) ||
    !input.id ||
    input.id.length > 100 ||
    (input.kind !== "turn" && input.id !== input.kind) ||
    !input.value ||
    typeof input.value !== "object" ||
    Array.isArray(input.value) ||
    Buffer.byteLength(data) > 256000
  )
    throw new CoreError("IPC_INVALID_REQUEST", { reason: "Invalid assistant record" });
  const row = db
    .prepare(
      "INSERT INTO assistant_records(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE assistant_records.kind=excluded.kind RETURNING rowid",
    )
    .get(input.id, input.kind, data);
  if (!row) throw new CoreError("IPC_INVALID_REQUEST", { reason: "Assistant record identity conflict" });
  return { seq: Number(row.rowid) };
}

const sessions = `WITH filter AS (SELECT ? AS project, ? AS session, lower(?) AS term, ? AS previews),
catalog AS (
  SELECT s.*, p.data AS project_data,
    (SELECT r.data FROM runs r WHERE r.session_id=s.id AND coalesce(json_extract(r.data,'$.presentation'),'') <> 'provider_command' ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 1) AS last_run,
    (SELECT max(m.created_at) FROM messages m WHERE m.session_id=s.id) AS activity
  FROM sessions s LEFT JOIN projects p ON p.id=s.project_id, filter f
  WHERE (f.project='' OR s.project_id=f.project) AND (f.session='' OR s.id=f.session)
    AND (f.term='' OR instr(lower(json_extract(s.data,'$.title')),f.term)>0 OR instr(lower(coalesce(json_extract(p.data,'$.name'),'')),f.term)>0
      OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id AND json_extract(m.data,'$.kind')='chat' AND instr(lower(json_extract(m.data,'$.text')),f.term)>0))
)
SELECT json_object('id',s.id,'title',substr(json_extract(s.data,'$.title'),1,160),
 'projectId',s.project_id,'project',json_extract(s.project_data,'$.name'),
 'harness',coalesce(json_extract(a.data,'$.displayName'),s.member_id),'status',json_extract(s.data,'$.status'),
 'runStatus',json_extract(s.last_run,'$.status'),'updatedAt',max(s.updated_at,coalesce(s.activity,'')),
 'preview',CASE WHEN f.previews THEN (SELECT substr(json_extract(m.data,'$.text'),1,140) FROM messages m
    WHERE m.session_id=s.id AND json_extract(m.data,'$.kind')='chat' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) END) AS item
FROM catalog s LEFT JOIN agents a ON a.id=coalesce(json_extract(s.data,'$.agentInstanceId'),s.member_id), filter f
ORDER BY max(s.updated_at,coalesce(s.activity,'')) DESC,s.id LIMIT 13 OFFSET ?`;
const excerpts = `WITH filter AS (SELECT ? AS session, lower(?) AS term, ? AS anchor, ? AS message, ? AS start),
matches AS (
 SELECT m.rowid AS ordinal,m.id,m.created_at,json_extract(m.data,'$.sender') AS sender,
   json_extract(m.data,'$.text') AS body,f.message,
   CASE WHEN f.message<>'' THEN f.start WHEN f.term<>'' THEN max(0,instr(lower(json_extract(m.data,'$.text')),f.term)-81) ELSE 0 END AS start
 FROM messages m,filter f WHERE m.session_id=f.session AND json_extract(m.data,'$.kind')='chat'
 AND (f.message='' OR m.id=f.message)
 AND (f.term='' OR instr(lower(json_extract(m.data,'$.text')),f.term)>0)
 AND (f.anchor=0 OR (m.created_at,m.rowid)<(SELECT created_at,rowid FROM messages WHERE session_id=f.session AND rowid=f.anchor))
 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 7
)
SELECT ordinal,json_object('id',id,'at',created_at,'sender',sender,'offset',start,
 'text',substr(body,start+1,CASE WHEN message='' THEN 480 ELSE 1200 END),
 'nextOffset',CASE WHEN length(body)>start+(CASE WHEN message='' THEN 480 ELSE 1200 END) THEN start+(CASE WHEN message='' THEN 480 ELSE 1200 END) END) AS item
FROM matches ORDER BY created_at DESC,ordinal DESC`;

function searchTerm(query = ""): string {
  if (Array.from(query).length > 200)
    throw new CoreError("IPC_INVALID_REQUEST", {
      field: "query",
      reason: "Search accepts up to 200 characters",
    });
  return query;
}
export function assistantSessions(db: DatabaseSync, input: AssistantLookup): AssistantSessionPage {
  const skip = Math.max(0, input.skip ?? 0);
  const rows = db
    .prepare(sessions)
    .all(input.projectId ?? "", input.sessionId ?? "", searchTerm(input.query), Number(!!input.previews), skip);
  return {
    items: rows.slice(0, 12).map((row) => JSON.parse(String(row.item))),
    next: rows.length > 12 ? skip + 12 : null,
  };
}
export function assistantExcerpts(db: DatabaseSync, input: AssistantRead): AssistantExcerptPage {
  if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(input.sessionId))
    throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });
  const rows = db
    .prepare(excerpts)
    .all(
      input.sessionId,
      searchTerm(input.query),
      input.before ?? 0,
      input.messageId ?? "",
      Math.max(0, input.offset ?? 0),
    );
  return {
    items: rows.slice(0, 6).map((row) => JSON.parse(String(row.item))),
    next: rows.length > 6 ? Number(rows[5]!.ordinal) : null,
  };
}
