import { randomUUID } from "node:crypto";
import type { ArtifactId, Message, ProjectRun, Session, Task } from "@agenthub/domain";
import { Database } from "../../database/index.js";

export class MessageRouter {
  constructor(private readonly database: Database) {}

  userGoal(session: Session, projectRun: ProjectRun, attachmentIds: ArtifactId[] = []): Message {
    return this.save(session, {
      sender: "user",
      kind: "chat",
      projectRunId: projectRun.id,
      toMemberId: projectRun.mainMemberId,
      attachmentIds,
      text: projectRun.goal
    });
  }

  delegation(main: Session, child: Session, projectRun: ProjectRun, task: Task): void {
    const correlationId = randomUUID();
    const text = `Delegated task ${task.id}: ${task.title}`;
    const route = {
      sender: "system" as const,
      kind: "delegation" as const,
      projectRunId: projectRun.id,
      taskId: task.id,
      fromMemberId: projectRun.mainMemberId,
      toMemberId: task.assignedMemberId,
      correlationId,
      text
    };
    this.save(main, route);
    this.save(child, route);
  }

  result(main: Session, projectRun: ProjectRun, task: Task, text: string): Message {
    return this.save(main, {
      sender: "system",
      kind: "result",
      projectRunId: projectRun.id,
      taskId: task.id,
      fromMemberId: task.assignedMemberId,
      toMemberId: projectRun.mainMemberId,
      text
    });
  }

  recovery(main: Session, projectRun: ProjectRun, task: Task, text: string): Message {
    return this.save(main, {
      sender: "system",
      kind: "recovery",
      projectRunId: projectRun.id,
      taskId: task.id,
      fromMemberId: task.assignedMemberId,
      toMemberId: projectRun.mainMemberId,
      text
    });
  }

  system(session: Session, projectRun: ProjectRun, text: string, kind: Message["kind"] = "chat"): Message {
    return this.save(session, {
      sender: "system",
      kind,
      projectRunId: projectRun.id,
      text
    });
  }

  private save(session: Session, fields: Omit<Message, "id" | "sessionId" | "createdAt">): Message {
    const message: Message = { id: randomUUID(), sessionId: session.id, createdAt: new Date().toISOString(), ...fields };
    this.database.sessions.saveMessage(message);
    return message;
  }
}
