import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { WorkRegistry } from "./registry.ts";

const dirs: string[] = [];

function fixture(now = 1_000) {
  const dir = mkdtempSync(join(tmpdir(), "omb-work-"));
  dirs.push(dir);
  let clock = now;
  const emitted: unknown[] = [];
  const file = join(dir, "work.json");
  const registry = new WorkRegistry({ file, now: () => clock, emit: (frame) => emitted.push(frame) });
  return { registry, file, emitted, tick: (ms = 1) => (clock += ms) };
}

function event(type: RuntimeEvent["type"], overrides: Record<string, unknown> = {}): RuntimeEvent {
  return {
    type,
    eventId: `event-${type}`,
    provider: "codex",
    providerInstanceId: "codex-main",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as RuntimeEvent;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WorkRegistry", () => {
  it("reports stale autonomous work without classifying user waits as stuck", () => {
    const h = fixture(2_000_000);
    const running = h.registry.create({ origin: "chat", targetBotId: "bot-a", threadId: "thread-run", objective: "Long work" });
    h.registry.claim(running.id);
    const waiting = h.registry.create({ origin: "chat", targetBotId: "bot-b", threadId: "thread-wait", objective: "Needs approval" });
    h.registry.claim(waiting.id);
    h.registry.handleRuntimeEvent(event("request.opened", {
      threadId: "thread-wait",
      turnId: undefined,
      requestId: "req-1",
      requestType: "permission",
      summary: "Approve",
    }));
    h.tick(31 * 60_000);

    expect(h.registry.runtimeStatus()).toMatchObject({ active: 2, stale: 1, waiting: 1 });
  });
  it("persists a private receipt and projects the provider lifecycle", () => {
    const h = fixture();
    const item = h.registry.create({
      origin: "voice",
      targetBotId: "bot-1",
      threadId: "thread-1",
      objective: "Check July invoices",
      voiceSessionId: "voice-1",
    });
    expect(item.state).toBe("queued");
    expect(statSync(h.file).mode & 0o777).toBe(0o600);

    h.tick();
    h.registry.handleRuntimeEvent(event("turn.started"));
    h.registry.handleRuntimeEvent(event("item.started", { itemType: "tool", title: "gmail.search" }));
    h.registry.handleRuntimeEvent(event("request.opened", {
      requestType: "permission",
      requestId: "request-1",
      tool: "gmail.send",
      summary: "Send the report",
    }));
    expect(h.registry.get(item.id)).toMatchObject({
      state: "waiting_approval",
      turnId: "turn-1",
      currentTool: "gmail.search",
      requestId: "request-1",
    });

    h.registry.handleRuntimeEvent(event("request.resolved", { requestId: "request-1", behavior: "allow", source: "user" }));
    h.registry.handleRuntimeEvent(event("item.completed", { itemType: "assistant_text", text: "Nothing is missing." }));
    h.registry.handleRuntimeEvent(event("turn.completed", { ok: true, cost: 0.03 }));
    expect(h.registry.get(item.id)).toMatchObject({
      state: "completed",
      result: "Nothing is missing.",
      cost: 0.03,
      providerInstanceId: "codex-main",
    });
    expect(JSON.parse(readFileSync(h.file, "utf8")).items).toHaveLength(1);
    expect(h.emitted).toContainEqual(expect.objectContaining({ kind: "work.item" }));
  });

  it("never lets a late event from an old turn bind to newer work", () => {
    const h = fixture();
    const old = h.registry.create({ origin: "chat", targetBotId: "bot-1", threadId: "thread-1", objective: "Old" });
    h.registry.handleRuntimeEvent(event("turn.started", { turnId: "old-turn" }));
    h.registry.handleRuntimeEvent(event("turn.completed", { turnId: "old-turn", ok: true }));
    const next = h.registry.create({ origin: "chat", targetBotId: "bot-1", threadId: "thread-1", objective: "New" });

    h.registry.handleRuntimeEvent(event("turn.completed", { turnId: "old-turn", ok: false, stopReason: "late failure" }));

    expect(h.registry.get(old.id)?.state).toBe("completed");
    expect(h.registry.get(next.id)?.state).toBe("queued");
    expect(h.registry.get(next.id)?.turnId).toBeUndefined();
  });

  it("marks only process-owned states interrupted on restart and preserves queued work", () => {
    const h = fixture();
    const running = h.registry.create({ origin: "voice", targetBotId: "bot-1", threadId: "thread-1", objective: "Running" });
    h.registry.handleRuntimeEvent(event("turn.started"));
    const queued = h.registry.create({ origin: "voice", targetBotId: "bot-1", threadId: "thread-1", objective: "Next" });

    h.tick(100);
    const reloaded = new WorkRegistry({ file: h.file, now: () => 2_000 });

    expect(reloaded.get(running.id)).toMatchObject({
      state: "interrupted_by_restart",
      error: "OpenMausBot restarted while this work was running",
      finishedAt: 2_000,
    });
    expect(reloaded.get(queued.id)?.state).toBe("queued");
  });

  it("claims queued work exactly once and supports explicit cancellation", () => {
    const h = fixture();
    const queued = h.registry.create({ origin: "voice", targetBotId: "bot-1", threadId: "thread-1", objective: "Next" });
    expect(h.registry.claim(queued.id)).toBe(true);
    expect(h.registry.claim(queued.id)).toBe(false);
    expect(h.registry.get(queued.id)?.state).toBe("running");
    h.registry.requestCancel(queued.id);
    h.registry.handleRuntimeEvent(event("turn.started"));
    h.registry.handleRuntimeEvent(event("turn.completed", { ok: false, stopReason: "interrupted" }));
    expect(h.registry.get(queued.id)?.state).toBe("cancelled");

    const waiting = h.registry.create({ origin: "voice", targetBotId: "bot-1", objective: "Never launched" });
    expect(h.registry.cancelQueued(waiting.id)).toBe(true);
    expect(h.registry.get(waiting.id)?.state).toBe("cancelled");
  });

  it("mirrors routine receipts idempotently without owning their scheduler", () => {
    const h = fixture();
    h.registry.upsertRoutineRun({
      id: "run-1",
      routineId: "routine-1",
      routineName: "Morning brief",
      prompt: "Summarize mail",
      botId: "bot-2",
      runOn: "maus",
      scheduledFor: 5_000,
      status: "queued",
      manual: false,
      createdAt: 1_000,
    });
    h.registry.upsertRoutineRun({
      id: "run-1",
      routineId: "routine-1",
      routineName: "Morning brief",
      prompt: "Summarize mail",
      botId: "bot-2",
      runOn: "maus",
      scheduledFor: 5_000,
      status: "running",
      manual: false,
      threadId: "routine-thread",
      startedAt: 5_001,
      createdAt: 1_000,
    });
    expect(h.registry.list()).toHaveLength(1);
    expect(h.registry.get("run-1")).toMatchObject({
      origin: "routine",
      sourceId: "routine-1",
      state: "running",
      threadId: "routine-thread",
      scheduledFor: 5_000,
    });
  });

  it("repairs overly broad legacy permissions on load", () => {
    const h = fixture();
    h.registry.create({ origin: "chat", targetBotId: "bot-1", objective: "Private" });
    chmodSync(h.file, 0o644);
    new WorkRegistry({ file: h.file });
    expect(statSync(h.file).mode & 0o777).toBe(0o600);
  });
});
