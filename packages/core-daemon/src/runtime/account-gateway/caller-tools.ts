import { randomUUID } from "node:crypto";
import type {
  AdapterStartRequest,
  RuntimeToolResult,
} from "../../adapters/index.js";
import { AsyncQueue } from "../../adapters/async-queue.js";
import type { Json } from "./http.js";

type PendingResult = {
  resolve: (result: RuntimeToolResult) => void;
  reject: (error: Error) => void;
};

/** The HTTP result resolves the original parked native tool invocation. */
export class CallerTools {
  private readonly pending = new Map<string, PendingResult>();

  cancel(): void {
    for (const pending of this.pending.values())
      pending.reject(Error("Account relay cancelled"));
    this.pending.clear();
  }

  deliver(messages: Json[]): number {
    let delivered = 0;
    for (const message of messages.filter((m) => m.role === "tool")) {
      const pending = this.pending.get(message.tool_call_id);
      if (!pending) continue;
      this.pending.delete(message.tool_call_id);
      pending.resolve({
        success: true,
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      });
      delivered++;
    }
    return delivered;
  }

  bind(
    tools: Json[],
    output: AsyncQueue<Json>,
  ): Pick<AdapterStartRequest, "runtimeTools" | "executeRuntimeTool"> {
    const specs = tools.map((tool, index) => ({
      name: `nautilo_relay_${index}`,
      description: `Caller tool ${tool.function.name}: ${tool.function.description ?? ""}`,
      inputSchema: tool.function.parameters ?? { type: "object" },
    }));
    return {
      runtimeTools: specs,
      executeRuntimeTool: (call) =>
        new Promise((resolve, reject) => {
          const index = specs.findIndex((spec) => spec.name === call.name);
          if (index < 0) {
            reject(Error("Unknown caller tool"));
            return;
          }
          const id = `relay-${randomUUID()}`;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(Error("Caller tool result timed out"));
          }, 300_000);
          timer.unref();
          this.pending.set(id, {
            resolve: (result) => {
              clearTimeout(timer);
              resolve(result);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          output.push({
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: tools[index].function.name,
                  arguments:
                    typeof call.arguments === "string"
                      ? call.arguments
                      : JSON.stringify(call.arguments),
                },
              },
            ],
          });
        }),
    };
  }
}
