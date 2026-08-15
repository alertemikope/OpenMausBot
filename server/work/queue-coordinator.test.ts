import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "./contracts.ts";
import { WorkQueueCoordinator } from "./queue-coordinator.ts";

function item(id: string, targetBotId: string, origin: WorkItem["origin"] = "voice"): WorkItem {
  return {
    id,
    origin,
    targetBotId,
    objective: id,
    state: "queued",
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("WorkQueueCoordinator", () => {
  it("claims ready work once, skips busy bots and leaves routines to their scheduler", async () => {
    const items = [item("ready", "bot-ready"), item("busy", "bot-busy"), item("routine", "bot-ready", "routine")];
    const claimed = new Set<string>();
    const start = vi.fn(async () => {});
    const coordinator = new WorkQueueCoordinator({
      work: {
        queued: () => items,
        claim: (id) => !claimed.has(id) && Boolean(claimed.add(id)),
        failDispatch: vi.fn(),
      },
      targetState: (id) => id === "bot-busy" ? "busy" : "ready",
      start,
    });

    await coordinator.drain();
    await coordinator.drain();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: "ready" }));
    expect(claimed).toEqual(new Set(["ready"]));
  });

  it("fails missing targets and converts dispatch rejection into a durable failure", async () => {
    const failDispatch = vi.fn();
    const coordinator = new WorkQueueCoordinator({
      work: {
        queued: () => [item("missing", "gone"), item("broken", "ready")],
        claim: () => true,
        failDispatch,
      },
      targetState: (id) => id === "gone" ? "missing" : "ready",
      start: async () => { throw new Error("provider unavailable"); },
    });

    await coordinator.drain();

    expect(failDispatch).toHaveBeenCalledWith("missing", "The assigned bot no longer exists");
    expect(failDispatch).toHaveBeenCalledWith("broken", "provider unavailable");
  });
});

