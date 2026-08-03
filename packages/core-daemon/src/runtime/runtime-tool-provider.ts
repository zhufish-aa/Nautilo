import type { AgentInstance, Session } from "@agenthub/domain";
import type { RuntimeToolExecutor, RuntimeToolSpec } from "../adapters/index.js";
import type { RunContext } from "./run-service.js";

export const RUNTIME_TOOL_SCHEMA_VERSION = 3;

export interface RuntimeToolBinding {
  tools: RuntimeToolSpec[];
  execute: RuntimeToolExecutor;
}

export interface RuntimeToolProvider {
  forRun(session: Session, context: RunContext, agent: AgentInstance): RuntimeToolBinding | undefined;
}
