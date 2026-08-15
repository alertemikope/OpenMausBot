import { describe, expect, it, vi } from "vitest";

import type { ProviderAdapter, RuntimeEvent } from "../contracts.ts";
import { HarnessAgentConsultRuntime } from "./agent-consult.ts";

function runtimeEvent(type: RuntimeEvent["type"], overrides: Record<string, unknown> = {}): RuntimeEvent {
  return {
    type,
    eventId: `event-${type}`,
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as RuntimeEvent;
}

function fixture() {
  let listener: ((event: RuntimeEvent) => void) | undefined;
  const adapter = {
    interruptTurn: vi.fn(async () => {}),
    steerTurn: vi.fn(async () => ({ accepted: true })),
    respondToRequest: vi.fn(async () => {}),
  } as unknown as ProviderAdapter;
  const startTurn = vi.fn(async () => {});
  const runtime = new HarnessAgentConsultRuntime({
    resolveTarget: (targetId) => targetId === "bot-1"
      ? { targetId, threadId: "thread-1", busy: false, adapter }
      : undefined,
    startTurn,
    subscribe: (next) => {
      listener = next;
      return () => { listener = undefined; };
    },
  });
  return { runtime, adapter, startTurn, emit: (event: RuntimeEvent) => listener?.(event) };
}

describe("harness-backed AgentConsult runtime", () => {
  it("reports progress, steers the owned turn and returns its final text", async () => {
    const { runtime, adapter, startTurn, emit } = fixture();
    const result = runtime.run({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      prompt: "Check July invoices",
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });
    expect(startTurn).toHaveBeenCalledWith("bot-1", "Check July invoices", expect.any(Function));
    emit(runtimeEvent("turn.started"));
    emit(runtimeEvent("item.started", { itemType: "tool", title: "gmail.search" }));
    await expect(runtime.control({ voiceSessionId: "voice-1", targetId: "bot-1", mode: "status", text: "status" }))
      .resolves.toMatchObject({ ok: true, message: expect.stringContaining("gmail.search") });
    await expect(runtime.control({ voiceSessionId: "voice-1", targetId: "bot-1", mode: "steer", text: "Only July" }))
      .resolves.toEqual({ ok: true, message: "I redirected the active agent turn." });
    expect(adapter.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", "Only July");
    emit(runtimeEvent("item.completed", { itemType: "assistant_text", text: "No invoice is missing." }));
    emit(runtimeEvent("turn.completed", { ok: true }));
    await expect(result).resolves.toEqual({ text: "No invoice is missing." });
  });

  it("cancels only the active voice-owned turn", async () => {
    const { runtime, adapter, emit } = fixture();
    const controller = new AbortController();
    const result = runtime.run({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      prompt: "Long task",
      signal: controller.signal,
      onEvent: vi.fn(),
    });
    emit(runtimeEvent("turn.started"));
    await expect(runtime.control({ voiceSessionId: "voice-other", targetId: "bot-1", mode: "cancel", text: "cancel" }))
      .resolves.toEqual({ ok: false, message: "There is no active delegated task." });
    await expect(runtime.control({ voiceSessionId: "voice-1", targetId: "bot-1", mode: "cancel", text: "cancel" }))
      .resolves.toEqual({ ok: true, message: "The active agent task was cancelled." });
    expect(adapter.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
    emit(runtimeEvent("turn.completed", { ok: false, stopReason: "cancelled" }));
    await expect(result).rejects.toThrow("cancelled");
  });

  it("binds approval decisions to the selected bot thread and request id", async () => {
    const { runtime, adapter } = fixture();
    await runtime.respondToRequest({
      targetId: "bot-1",
      threadId: "thread-1",
      requestId: "request-1",
      behavior: "allow",
    });
    expect(adapter.respondToRequest).toHaveBeenCalledWith("thread-1", "request-1", { behavior: "allow" });
    await expect(runtime.respondToRequest({
      targetId: "bot-1",
      threadId: "wrong-thread",
      requestId: "request-1",
      behavior: "deny",
    })).rejects.toThrow("no longer owned");
  });
});
