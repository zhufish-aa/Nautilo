import type {SourceControlScope} from "@agenthub/schemas";
import type {Database} from "../database/index.js";
import {CoreError} from "../errors.js";
export function sourceControlDirectory(database:Database,input:SourceControlScope):string {
  const session=input.sessionId?database.sessions.get(input.sessionId):undefined;
  if(input.sessionId&&!session)throw new CoreError("IPC_NOT_FOUND",{resource:"session",id:input.sessionId});
  if(session&&input.projectId&&session.projectId!==input.projectId)throw new Error("会话与项目不匹配。");
  const project=database.projects.get(input.projectId??session?.projectId??"");if(!project)throw new CoreError("IPC_NOT_FOUND",{resource:"project",id:input.projectId});
  return session?.nativeWorkingDirectory??project.rootPath;
}
