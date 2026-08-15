import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { LiveDelegationController } from "./delegation-controller.ts";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; }
}

const delegation = (id: string, text: string) => JSON.stringify({
  type: "delegation.created",
  item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
});

const runtimeEvent = (overrides: Partial<RuntimeEvent>): RuntimeEvent => ({
  type: "turn.started",
  eventId: "event-1",
  provider: "fake",
  threadId: "thread-1",
  turnId: "turn-1",
  createdAt: new Date().toISOString(),
  ...overrides,
} as RuntimeEvent);

describe("GPT-Live delegation controller", () => {
  it("requires exact confirmation before resolving the provider request", async () => {
    const socket = new FakeSocket();
    const respond = vi.fn(async () => {});
    const run = vi.fn(async ({ onEvent }: { onEvent(event: RuntimeEvent): void }) => {
      onEvent(runtimeEvent({
        type: "request.opened",
        requestId: "req-1",
        requestType: "permission",
        tool: "gmail.send",
        summary: "Send email to Ada",
      }));
      return new Promise<{ text: string }>(() => {});
    });
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      runtime: { run },
      control: vi.fn(),
      respondToRequest: respond,
      onFatal: vi.fn(),
    });
    controller.handle(delegation("d1", "Send the email"));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("Approval required"));
    controller.handle(delegation("d2", "Oui mais pas maintenant"));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("Confirmation is still pending"));
    expect(respond).not.toHaveBeenCalled();
    controller.handle(JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "Oui, je confirme" } }));
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-1", behavior: "allow" })));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("that exact action"));
  });

  it("keeps voice interruption separate from explicit agent cancellation", async () => {
    const socket = new FakeSocket();
    const control = vi.fn(async () => ({ ok: true, message: "cancelled" }));
    const run = vi.fn();
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      runtime: { run },
      control,
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    controller.handle(delegation("d1", "Annule cette tâche"));
    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(expect.objectContaining({ mode: "cancel" })));
    expect(run).not.toHaveBeenCalled();
  });

  it("queues same-agent work without aborting the active task", async () => {
    const socket = new FakeSocket();
    const prompts: string[] = [];
    let finishOld!: (result: { text: string }) => void;
    const run = vi.fn(({ prompt, signal }: { prompt: string; signal: AbortSignal }) => {
      prompts.push(prompt);
      return new Promise<{ text: string }>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (prompt === "old task") finishOld = resolve;
        if (prompt === "new task") resolve({ text: "new result" });
      });
    });
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      runtime: { run },
      control: vi.fn(),
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    controller.handle(delegation("old", "old task"));
    controller.handle(delegation("new", "new task"));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("queued"));
    expect(prompts).toEqual(["old task"]);
    finishOld({ text: "old result" });
    await vi.waitFor(() => expect(prompts).toEqual(["old task", "new task"]));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("new result"));
    expect(socket.sent.join("\n")).toContain("old result");
  });

  it("returns GA agent_consult output once and creates the follow-up response", async () => {
    const socket = new FakeSocket();
    const run = vi.fn(async () => ({ text: "Luna Max" }));
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      transport: "ga-realtime",
      runtime: { run },
      control: vi.fn(),
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    const event = JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: "call-1",
      arguments: JSON.stringify({ prompt: "What is your name?" }),
    });
    controller.handle(event);
    controller.handle(event);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(run).toHaveBeenCalledOnce();
    expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1", output: "bot-1: Luna Max" } },
      { type: "response.create" },
    ]);
  });

  it("uses the GA structured mode so a paraphrased status request does not replace active work", async () => {
    const socket = new FakeSocket();
    const control = vi.fn(async () => ({ ok: true, message: "Still running." }));
    const run = vi.fn(() => new Promise<{ text: string }>(() => {}));
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      transport: "ga-realtime",
      runtime: { run },
      control,
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    const call = (id: string, mode: string, prompt: string) => JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: id,
      arguments: JSON.stringify({ mode, prompt }),
    });
    controller.handle(call("task-1", "task", "[OPENMAUS_CONTROL:status] Run a long task"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    controller.handle(call("status-1", "status", "Give progress for the previous request"));
    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(expect.objectContaining({ mode: "status" })));
    expect(run).toHaveBeenCalledOnce();
    expect(socket.sent.join("\n")).toContain("Still running");
  });

  it("keeps a GA follow-up function pending until its queued harness turn completes", async () => {
    const socket = new FakeSocket();
    let finishFirst!: (result: { text: string }) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<{ text: string }>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ text: "follow-up done" });
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      transport: "ga-realtime",
      runtime: { run },
      control: vi.fn(),
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    const call = (id: string, mode: string, prompt: string) => JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: id,
      arguments: JSON.stringify({ mode, prompt }),
    });
    controller.handle(call("task-1", "task", "first task"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    controller.handle(call("followup-1", "followup", "second task"));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("queued"));
    expect(socket.sent.map((payload) => JSON.parse(payload)).filter((event) => event.item?.call_id === "followup-1")).toHaveLength(0);
    controller.handle(JSON.stringify({ type: "response.done" }));
    finishFirst({ text: "first done" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    controller.handle(JSON.stringify({ type: "response.done" }));
    controller.handle(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(socket.sent.map((payload) => JSON.parse(payload)).some((event) => event.item?.call_id === "followup-1" && event.item.output.includes("follow-up done"))).toBe(true));
  });

  it("runs explicitly targeted agents in parallel", async () => {
    const socket = new FakeSocket();
    const pending = new Map<string, (result: { text: string }) => void>();
    const run = vi.fn(({ targetId }: { targetId: string }) => new Promise<{ text: string }>((resolve) => pending.set(targetId, resolve)));
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "luna",
      targets: [{ id: "luna", name: "Luna Max" }, { id: "codex", name: "Codex" }],
      socket,
      transport: "ga-realtime",
      runtime: { run },
      control: vi.fn(),
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    const call = (id: string, targetId: string, prompt: string) => JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: id,
      arguments: JSON.stringify({ mode: "task", target_id: targetId, prompt }),
    });
    controller.handle(call("luna-task", "luna", "check mail"));
    controller.handle(call("codex-task", "codex", "review code"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls.map(([input]) => input.targetId).sort()).toEqual(["codex", "luna"]);
    pending.get("codex")?.({ text: "code done" });
    pending.get("luna")?.({ text: "mail done" });
    await vi.waitFor(() => expect(socket.sent.join("\n")).toMatch(/(?:Codex: code done|Luna Max: mail done)/));
    controller.handle(JSON.stringify({ type: "response.done" }));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("Codex: code done"));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("Luna Max: mail done"));
  });

  it("routes a named agent from natural delegation text", async () => {
    const socket = new FakeSocket();
    const run = vi.fn(async () => ({ text: "done" }));
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "luna",
      targets: [{ id: "luna", name: "Luna Max" }, { id: "codex", name: "Codex" }],
      socket,
      runtime: { run },
      control: vi.fn(),
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    controller.handle(delegation("task-1", "Demande à Codex de vérifier le dépôt"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ targetId: "codex" })));
  });

  it("lets active and queued agent work finish after the voice line closes", async () => {
    const socket = new FakeSocket();
    let finishFirst!: (result: { text: string }) => void;
    const run = vi.fn()
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise<{ text: string }>((resolve) => {
        expect(signal.aborted).toBe(false);
        finishFirst = resolve;
      }))
      .mockResolvedValueOnce({ text: "queued done" });
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "luna",
      socket,
      runtime: { run },
      control: vi.fn(),
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    controller.handle(delegation("task-1", "first"));
    controller.handle(delegation("task-2", "second"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    controller.stop();
    const sentBeforeCompletion = socket.sent.length;
    finishFirst({ text: "first done" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent).toHaveLength(sentBeforeCompletion);
  });

  it("reports target-owned work from an earlier voice controller", async () => {
    const socket = new FakeSocket();
    const control = vi.fn(async ({ targetId }: { targetId: string }) => ({ ok: true, message: `${targetId} running` }));
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-new",
      targetId: "luna",
      targets: [{ id: "luna", name: "Luna Max" }, { id: "codex", name: "Codex" }],
      activeTargets: () => ["luna", "codex"],
      socket,
      transport: "ga-realtime",
      runtime: { run: vi.fn() },
      control,
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    controller.handle(JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: "status-all",
      arguments: JSON.stringify({ mode: "status", prompt: "Où en sont les tâches ?" }),
    }));
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(socket.sent.join("\n")).toContain("Luna Max: luna running"));
    expect(socket.sent.join("\n")).toContain("Codex: codex running");
  });

  it("resolves both the active GA task and the cancel control function", async () => {
    const socket = new FakeSocket();
    const control = vi.fn(async () => ({ ok: true, message: "The active agent task was cancelled." }));
    const run = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ text: string }>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const controller = new LiveDelegationController({
      voiceSessionId: "voice-1",
      targetId: "bot-1",
      socket,
      transport: "ga-realtime",
      runtime: { run },
      control,
      respondToRequest: vi.fn(),
      onFatal: vi.fn(),
    });
    const call = (id: string, mode: string, prompt: string) => JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: id,
      arguments: JSON.stringify({ mode, prompt }),
    });
    controller.handle(call("task-1", "task", "long task"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    controller.handle(call("cancel-1", "cancel", "stop the active task"));
    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(expect.objectContaining({ mode: "cancel" })));
    const outputs = socket.sent.map((payload) => JSON.parse(payload)).filter((event) => event.item?.type === "function_call_output");
    expect(outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ item: expect.objectContaining({ call_id: "task-1", output: expect.stringContaining("cancelled") }) }),
      expect.objectContaining({ item: expect.objectContaining({ call_id: "cancel-1", output: expect.stringContaining("cancelled") }) }),
    ]));
    expect(socket.sent.map((payload) => JSON.parse(payload)).filter((event) => event.type === "response.create")).toHaveLength(1);
  });
});
