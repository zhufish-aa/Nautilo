import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@agenthub/event-protocol";
import { CoreError } from "../errors.js";
import { EventService } from "./event-service.js";

interface SubscriptionScope { projectRunId?: string; sessionId?: string; }

export class EventSubscriptionService {
  private readonly subscriptions = new Map<string, SubscriptionScope>();
  constructor(private readonly events: EventService) {}
  subscribe(scope: SubscriptionScope): { subscriptionId: string } {
    if (!scope.projectRunId && !scope.sessionId) throw new CoreError("IPC_INVALID_REQUEST", { field: "event scope" });
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, { ...scope });
    return { subscriptionId };
  }
  replay(subscriptionId: string, afterSequence: number): { events: RuntimeEvent[]; lastSequence: number } {
    const scope = this.subscriptions.get(subscriptionId);
    if (!scope) throw new CoreError("IPC_NOT_FOUND", { resource: "eventSubscription", id: subscriptionId });
    const events = this.events.replay({ ...scope, afterSequence });
    return { events, lastSequence: events.at(-1)?.sequence ?? afterSequence };
  }
  async wait(subscriptionId: string, afterSequence: number, timeoutMs = 20_000): Promise<{ events: RuntimeEvent[]; lastSequence: number }> {
    const scope = this.subscriptions.get(subscriptionId);
    if (!scope) throw new CoreError("IPC_NOT_FOUND", { resource: "eventSubscription", id: subscriptionId });
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: { events: RuntimeEvent[]; lastSequence: number }): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const matches = (event: RuntimeEvent): boolean =>
        event.sequence > afterSequence &&
        (!scope.sessionId || event.sessionId === scope.sessionId) &&
        (!scope.projectRunId || event.projectRunId === scope.projectRunId);
      const unsubscribe = this.events.onAppend((event) => {
        if (!matches(event)) return;
        queueMicrotask(() => finish(this.replay(subscriptionId, afterSequence)));
      });
      const available = this.replay(subscriptionId, afterSequence);
      if (available.events.length) {
        finish(available);
        return;
      }
      timer = setTimeout(() => finish({ events: [], lastSequence: afterSequence }), Math.min(Math.max(timeoutMs, 250), 25_000));
    });
  }
}
