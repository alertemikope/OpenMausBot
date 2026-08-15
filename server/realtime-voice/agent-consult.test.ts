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

  it("keeps target-owned work controllable after the originating voice session changes", async () => {
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

  it("tracks independent target runs in parallel", async () => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const adapter = {
      interruptTurn: vi.fn(async () => {}),
      respondToRequest: vi.fn(async () => {}),
    } as unknown as ProviderAdapter;
    const runtime = new HarnessAgentConsultRuntime({
      resolveTarget: (targetId) => ({ targetId, threadId: `thread-${targetId}`, busy: false, adapter }),
      startTurn: vi.fn(async () => {}),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const luna = runtime.run({
      voiceSessionId: "voice-1",
      targetId: "luna",
      prompt: "mail",
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });
    const codex = runtime.run({
      voiceSessionId: "voice-1",
      targetId: "codex",
      prompt: "code",
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    });
    expect(runtime.activeTargets().sort()).toEqual(["codex", "luna"]);
    for (const listener of listeners) listener(runtimeEvent("item.completed", { threadId: "thread-luna", turnId: "turn-luna", itemType: "assistant_text", text: "mail done" }));
    for (const listener of listeners) listener(runtimeEvent("turn.completed", { threadId: "thread-luna", turnId: "turn-luna", ok: true }));
    for (const listener of listeners) listener(runtimeEvent("item.completed", { threadId: "thread-codex", turnId: "turn-codex", itemType: "assistant_text", text: "code done" }));
    for (const listener of listeners) listener(runtimeEvent("turn.completed", { threadId: "thread-codex", turnId: "turn-codex", ok: true }));
    await expect(luna).resolves.toEqual({ text: "mail done" });
    await expect(codex).resolves.toEqual({ text: "code done" });
    expect(runtime.activeTargets()).toEqual([]);
  });
});
