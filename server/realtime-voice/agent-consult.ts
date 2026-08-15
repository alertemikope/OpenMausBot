import type { ProviderAdapter, RuntimeEvent } from "../contracts.ts";
import type { AgentControlMode, AgentControlResult, AgentConsultRuntime } from "./contracts.ts";

type Target = {
  targetId: string;
  threadId: string;
  busy: boolean;
  adapter?: ProviderAdapter;
};

type ActiveRun = {
  generation: number;
  voiceSessionId: string;
  targetId: string;
  threadId: string;
  startedAt: number;
  turnId?: string;
  tool?: string;
  progress?: string;
  awaitingApproval?: string;
};

type HarnessAgentConsultDeps = {
  resolveTarget(targetId: string): Target | undefined;
  startTurn(targetId: string, prompt: string, onDispatchError: (message: string) => void): Promise<void> | void;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
};

export class HarnessAgentConsultRuntime implements AgentConsultRuntime {
  // A voice call is a controller, not the lifetime owner of agent work. Keep
  // one active run per target so different bots can work in parallel and a
  // reconnecting/new voice session can still query or cancel that work.
  private readonly active = new Map<string, ActiveRun>();
  private readonly deps: HarnessAgentConsultDeps;
  private generation = 0;

  constructor(deps: HarnessAgentConsultDeps) { this.deps = deps; }

  activeTargets(): string[] {
    return [...this.active.keys()];
  }

  run(input: Parameters<AgentConsultRuntime["run"]>[0]): Promise<{ text: string }> {
    const target = this.deps.resolveTarget(input.targetId);
    if (!target) return Promise.reject(new Error("The selected OpenMaus bot no longer exists"));
    if (target.busy) return Promise.reject(new Error("The selected bot is already working; ask for status, steer it, or cancel first"));
    const generation = ++this.generation;
    const run: ActiveRun = {
      generation,
      voiceSessionId: input.voiceSessionId,
      targetId: input.targetId,
      threadId: target.threadId,
      startedAt: Date.now(),
      progress: "Starting the selected OpenMaus bot",
    };
    this.active.set(input.targetId, run);

    return new Promise((resolve, reject) => {
      let text = "";
      let settled = false;
      let abortTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(abortTimer);
        unsubscribe();
        input.signal.removeEventListener("abort", onAbort);
        if (this.active.get(input.targetId)?.generation === generation) this.active.delete(input.targetId);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve({ text: text.trim() });
      };
      const onAbort = () => {
        void target.adapter?.interruptTurn(target.threadId, run.turnId).catch(() => {});
        abortTimer = setTimeout(() => finish(new Error("Agent task cancelled")), 5_000);
        abortTimer.unref?.();
      };
      const unsubscribe = this.deps.subscribe((event) => {
        if (event.threadId !== target.threadId) return;
        if (run.turnId && event.turnId && event.turnId !== run.turnId) return;
        if (event.type === "turn.started") run.turnId = event.turnId;
        if (run.turnId && event.turnId !== run.turnId) return;
        input.onEvent(event);
        if (event.type === "item.started" && event.itemType === "tool") {
          run.tool = event.title ?? "tool";
          run.progress = `Using ${run.tool}`;
        } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
          text += `${text ? "\n" : ""}${event.text}`;
          run.progress = "Preparing the final answer";
        } else if (event.type === "request.opened") {
          run.awaitingApproval = event.summary;
          run.progress = "Waiting for approval";
        } else if (event.type === "request.resolved") {
          run.awaitingApproval = undefined;
          run.progress = "Continuing after the user's decision";
        } else if (event.type === "runtime.error") {
          run.progress = `Error: ${event.message.slice(0, 140)}`;
        } else if (event.type === "turn.completed") {
          finish(event.ok ? undefined : new Error(event.stopReason || "The agent turn failed"));
        }
      });
      const timeout = setTimeout(() => {
        void target.adapter?.interruptTurn(target.threadId, run.turnId).catch(() => {});
        finish(new Error("Agent consultation timed out"));
      }, 5 * 60_000);
      timeout.unref?.();
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      Promise.resolve(this.deps.startTurn(input.targetId, input.prompt, (message) => finish(new Error(message)))).catch(
        (error) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  async control(input: {
    voiceSessionId: string;
    targetId: string;
    mode: AgentControlMode;
    text: string;
  }): Promise<AgentControlResult> {
    const run = this.active.get(input.targetId);
    if (!run) {
      return { ok: false, message: "There is no active delegated task." };
    }
    const target = this.deps.resolveTarget(run.targetId);
    if (!target?.adapter) return { ok: false, message: "The selected agent provider is unavailable." };
    if (input.mode === "status") {
      const seconds = Math.max(0, Math.round((Date.now() - run.startedAt) / 1_000));
      return {
        ok: true,
        message: run.awaitingApproval
          ? `The agent has worked for ${seconds} seconds and is awaiting approval: ${run.awaitingApproval}.`
          : `The agent has worked for ${seconds} seconds. ${run.progress ?? "It is still running."}`,
      };
    }
    if (input.mode === "cancel") {
      await target.adapter.interruptTurn(run.threadId, run.turnId);
      return { ok: true, message: "The active agent task was cancelled." };
    }
    if (input.mode === "steer") {
      if (!target.adapter.steerTurn || !run.turnId) {
        return { ok: false, message: "This agent engine cannot steer an active turn. I did not cancel or restart it." };
      }
      const result = await target.adapter.steerTurn(run.threadId, run.turnId, input.text);
      return result.accepted
        ? { ok: true, message: "I redirected the active agent turn." }
        : { ok: false, message: result.reason || "The agent engine rejected steering; the task is still running unchanged." };
    }
    return { ok: true, message: "I queued that follow-up after the current task." };
  }

  async respondToRequest(input: {
    targetId: string;
    threadId: string;
    requestId: string;
    behavior: "allow" | "deny";
  }): Promise<void> {
    const target = this.deps.resolveTarget(input.targetId);
    if (!target?.adapter || target.threadId !== input.threadId) throw new Error("The approval request is no longer owned by this bot");
    await target.adapter.respondToRequest(input.threadId, input.requestId, { behavior: input.behavior });
  }
}
