import type { RuntimeEvent } from "../contracts.ts";
import { classifyAgentControl } from "./agent-control.ts";
import { VoiceConfirmationController } from "./confirmation-controller.ts";
import type { AgentControlMode, AgentControlResult, AgentConsultRuntime, LiveTargetDescriptor, VoiceRoutineRequest } from "./contracts.ts";
import { chunkDelegationText, parseLiveEvent } from "./openai-live-wire.ts";
import type { LiveSidebandSocket } from "./sideband.ts";

const MAX_RESULT_CHARS = 1_800;

type Delegation = { id: string; prompt: string; targetId?: string; mode?: "task" | AgentControlMode; workItemId?: string };
type ActiveDelegation = { delegation: Delegation; targetId: string; controller: AbortController; generation: number };
type GaDelivery = { outputs?: Array<{ delegationId: string; text: string }>; instructions?: string };
type ControllerOptions = {
  voiceSessionId: string;
  targetId: string;
  targets?: LiveTargetDescriptor[];
  socket: LiveSidebandSocket;
  transport?: "gpt-live" | "ga-realtime";
  runtime: AgentConsultRuntime;
  activeTargets?: () => string[];
  control: (input: { voiceSessionId: string; targetId: string; mode: AgentControlMode; text: string }) => Promise<AgentControlResult>;
  respondToRequest: (input: { targetId: string; threadId: string; requestId: string; behavior: "allow" | "deny" }) => Promise<void>;
  manageRoutine?: (input: VoiceRoutineRequest) => Promise<{ ok: boolean; message: string }>;
  onFatal: (error: Error) => void;
  onSessionStarted?: (expiresAt?: number) => void;
};

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export class LiveDelegationController {
  private readonly active = new Map<string, ActiveDelegation>();
  private readonly followups = new Map<string, Delegation[]>();
  private generation = 0;
  private readonly seenDelegations = new Set<string>();
  private readonly confirmations = new VoiceConfirmationController();
  private pendingApproval?: { targetId: string; delegationId: string };
  private readonly gaOutbox: GaDelivery[] = [];
  private gaResponseInFlight = false;
  private readonly options: ControllerOptions;
  private readonly targets: LiveTargetDescriptor[];
  private stopped = false;

  constructor(options: ControllerOptions) {
    this.options = options;
    const targets = options.targets?.filter((target) => target.id && target.name) ?? [];
    this.targets = targets.some((target) => target.id === options.targetId)
      ? targets
      : [{ id: options.targetId, name: options.targetId }, ...targets];
  }

  handle(payload: string): void {
    const event = parseLiveEvent(payload);
    if (!event || this.stopped || event.kind === "ignored") return;
    if (event.kind === "transcript") {
      if (event.done && event.role === "user") void this.resolveConfirmationTranscript(event.text);
      return;
    }
    if (event.kind === "session-started") return this.options.onSessionStarted?.(event.expiresAt);
    // GA Realtime emits response.created for every response, including the
    // model's acknowledgement that contains agent_consult. Track those
    // provider-owned responses too: a fast delegated agent can finish while
    // that acknowledgement is still being spoken, and response.create is
    // rejected if sent over it. Keep the result queued until response.done.
    if (event.kind === "response-started") {
      this.gaResponseInFlight = true;
      return;
    }
    if (event.kind === "response-finished") {
      this.gaResponseInFlight = false;
      this.drainGaOutbox();
      return;
    }
    if (event.kind === "error") {
      if (event.fatalAuth) this.options.onFatal(new Error(`GPT-Live authentication failed: ${event.message}`));
      return;
    }
    if (event.kind === "unknown") return;
    if (this.seenDelegations.has(event.id)) return;
    this.seenDelegations.add(event.id);
    if (event.kind === "routine") {
      void this.routeRoutine(event.id, event);
      return;
    }
    void this.route({
      id: event.id,
      prompt: event.prompt,
      ...(event.targetId ? { targetId: event.targetId } : {}),
      ...(event.mode ? { mode: event.mode } : {}),
    });
  }

  /** Closing the audio line must not cancel background agent work. The runtime
   * owns those turns until completion; this controller merely stops delivery
   * to the closed voice socket. */
  stop(_reason = new Error("GPT-Live session closed")): void {
    if (this.stopped) return;
    this.stopped = true;
    this.seenDelegations.clear();
    this.confirmations.clear();
    this.pendingApproval = undefined;
    this.gaOutbox.length = 0;
  }

  private target(delegation: Delegation): string | undefined {
    if (delegation.targetId) {
      return this.targets.some((target) => target.id === delegation.targetId) ? delegation.targetId : undefined;
    }
    const prompt = normalized(delegation.prompt);
    const named = [...this.targets]
      .sort((left, right) => right.name.length - left.name.length)
      .find((target) => {
        const name = normalized(target.name);
        if (!name) return false;
        return prompt === name
          || prompt.startsWith(`${name} `)
          || ["demande a", "dis a", "confie a", "ask", "tell", "have", "use"]
            .some((prefix) => (` ${prompt} `).includes(` ${prefix} ${name} `));
      });
    return named?.id ?? this.options.targetId;
  }

  private targetName(targetId: string): string {
    return this.targets.find((target) => target.id === targetId)?.name ?? targetId;
  }

  private knownActiveTargets(): string[] {
    return [...new Set([
      ...this.active.keys(),
      ...(this.options.activeTargets?.() ?? []),
    ])].filter((targetId) => this.targets.some((target) => target.id === targetId));
  }

  private controlTarget(delegation: Delegation): string | undefined {
    if (delegation.targetId || this.targets.some((target) => (` ${normalized(delegation.prompt)} `).includes(` ${normalized(target.name)} `))) {
      return this.target(delegation);
    }
    const activeTargets = this.knownActiveTargets();
    if (activeTargets.length === 1) return activeTargets[0];
    return activeTargets.length === 0 ? this.options.targetId : undefined;
  }

  private async route(delegation: Delegation): Promise<void> {
    const pending = this.confirmations.current();
    if (pending.type === "pending") {
      this.send(delegation.id, `Confirmation is still pending for: ${pending.exactSummary}. Say “Oui, je confirme” or “Non, je refuse”.`, "speakable", true);
      return;
    }

    const intent = delegation.mode
      ? delegation.mode === "task" ? null : { mode: delegation.mode, text: delegation.prompt }
      : classifyAgentControl(delegation.prompt);
    const targetId = intent ? this.controlTarget(delegation) : this.target(delegation);
    const knownActiveTargets = this.knownActiveTargets();
    if (intent?.mode === "status" && !delegation.targetId && knownActiveTargets.length > 1) {
      const statuses = await Promise.all(knownActiveTargets.map(async (id) => ({
        id,
        result: await this.options.control({ voiceSessionId: this.options.voiceSessionId, targetId: id, mode: "status", text: intent.text }),
      })));
      this.send(delegation.id, statuses.map(({ id, result }) => `${this.targetName(id)}: ${result.message}`).join(" "), "speakable", true);
      return;
    }
    if (!targetId) {
      const choices = knownActiveTargets.length
        ? knownActiveTargets.map((id) => this.targetName(id)).join(", ")
        : this.targets.map((target) => target.name).join(", ");
      this.send(delegation.id, `Name the agent to control. Available active agents: ${choices || "none"}.`, "speakable", true);
      return;
    }
    if (delegation.targetId && !this.targets.some((target) => target.id === delegation.targetId)) {
      this.send(delegation.id, `Unknown OpenMaus agent id: ${delegation.targetId}.`, "speakable", true);
      return;
    }

    if (intent?.mode === "followup") {
      const queued = this.enqueue({ ...delegation, prompt: intent.text, targetId });
      const queue = this.followups.get(targetId) ?? [];
      queue.push(queued);
      this.followups.set(targetId, queue);
      this.send(delegation.id, `I queued that follow-up for ${this.targetName(targetId)}.`, "speakable", this.options.transport !== "ga-realtime");
      if (!this.active.has(targetId)) this.launch(targetId, queue.shift()!);
      return;
    }

    if (intent) {
      const result = await this.options.control({
        voiceSessionId: this.options.voiceSessionId,
        targetId,
        mode: intent.mode,
        text: intent.text,
      });
      const active = this.active.get(targetId);
      if (intent.mode === "cancel" && result.ok && active) {
        this.followups.delete(targetId);
        active.controller.abort(new Error("Agent task cancelled by user"));
        if (this.options.transport === "ga-realtime" && this.options.socket.readyState === 1) {
          this.enqueueGa({ outputs: [
            { delegationId: active.delegation.id, text: `The delegated ${this.targetName(targetId)} task was cancelled by the user.` },
            { delegationId: delegation.id, text: result.message },
          ] });
          return;
        }
      }
      this.send(delegation.id, result.message, "speakable", true);
      return;
    }

    if (this.active.has(targetId) || knownActiveTargets.includes(targetId)) {
      const queue = this.followups.get(targetId) ?? [];
      queue.push(this.enqueue({ ...delegation, targetId }));
      this.followups.set(targetId, queue);
      this.send(delegation.id, `${this.targetName(targetId)} is already working. I queued this request next.`, "speakable", this.options.transport !== "ga-realtime");
      return;
    }
    this.launch(targetId, { ...delegation, targetId });
  }

  private async resolveConfirmationTranscript(text: string): Promise<void> {
    const pending = this.confirmations.current();
    const owner = this.pendingApproval;
    if (pending.type !== "pending" || !owner) return;
    const decision = this.confirmations.resolve(text, {
      requestId: pending.requestId,
      threadId: pending.threadId,
      exactSummary: pending.exactSummary,
    });
    if (decision !== "allow" && decision !== "deny") return;
    this.pendingApproval = undefined;
    try {
      await this.options.respondToRequest({
        targetId: owner.targetId,
        threadId: pending.threadId,
        requestId: pending.requestId,
        behavior: decision,
      });
      this.send(owner.delegationId, decision === "allow"
        ? "Confirmed. The agent may continue with that exact action."
        : "Denied. The agent will skip that exact action.", "speakable");
    } catch {
      this.send(owner.delegationId, "That approval request changed or expired, so I did not authorize it.", "speakable");
    }
  }

  private async routeRoutine(id: string, request: VoiceRoutineRequest): Promise<void> {
    if (!this.options.manageRoutine) {
      this.send(id, "Routine management is unavailable in this OpenMausBot session.", "speakable", true);
      return;
    }
    try {
      const result = await this.options.manageRoutine({
        ...request,
        targetId: request.targetId ?? this.options.targetId,
      });
      this.send(id, result.message, "speakable", true);
    } catch (error) {
      this.send(id, `I did not change the routine: ${error instanceof Error ? error.message.slice(0, 220) : "unknown error"}`, "speakable", true);
    }
  }

  private launch(targetId: string, delegation: Delegation): void {
    const controller = new AbortController();
    const generation = ++this.generation;
    this.active.set(targetId, { delegation, targetId, controller, generation });
    void this.options.runtime.run({
      voiceSessionId: this.options.voiceSessionId,
      targetId,
      prompt: delegation.prompt,
      workItemId: delegation.workItemId,
      signal: controller.signal,
      onEvent: (event) => this.onRuntimeEvent(targetId, generation, delegation.id, event),
    }).then((result) => {
      if (!controller.signal.aborted && this.active.get(targetId)?.generation === generation) {
        const text = result.text.length > MAX_RESULT_CHARS
          ? `${result.text.slice(0, MAX_RESULT_CHARS - 14).trimEnd()} [truncated]`
          : result.text;
        this.send(delegation.id, `${this.targetName(targetId)}: ${text || "The agent finished without a speakable result."}`, "speakable", true);
      }
    }).catch((error) => {
      if (!controller.signal.aborted && this.active.get(targetId)?.generation === generation) {
        this.send(delegation.id, `${this.targetName(targetId)} failed: ${error instanceof Error ? error.message.slice(0, 180) : "unknown error"}`, "speakable", true);
      }
    }).finally(() => {
      if (this.active.get(targetId)?.generation !== generation) return;
      this.active.delete(targetId);
      const queue = this.followups.get(targetId);
      const next = queue?.shift();
      if (!queue?.length) this.followups.delete(targetId);
      if (next) this.launch(targetId, next);
    });
  }

  private enqueue(delegation: Delegation & { targetId: string }): Delegation {
    if (delegation.workItemId || !this.options.runtime.enqueue) return delegation;
    const queued = this.options.runtime.enqueue({
      voiceSessionId: this.options.voiceSessionId,
      targetId: delegation.targetId,
      prompt: delegation.prompt,
    });
    return { ...delegation, workItemId: queued.workItemId };
  }

  private onRuntimeEvent(targetId: string, generation: number, delegationId: string, event: RuntimeEvent): void {
    if (this.stopped || this.active.get(targetId)?.generation !== generation) return;
    if (event.type === "request.opened" && event.requestType === "permission" && event.requestId) {
      this.confirmations.open({ requestId: event.requestId, threadId: event.threadId, exactSummary: event.summary });
      this.pendingApproval = { targetId, delegationId };
      this.send(delegationId, `Approval required for ${this.targetName(targetId)}: ${event.summary}. Say “Oui, je confirme” or “Non, je refuse”.`, "speakable");
    } else if (event.type === "item.started" && event.itemType === "tool") {
      this.send(delegationId, `${this.targetName(targetId)} current tool: ${event.title ?? "tool"}.`, "commentary");
    } else if (event.type === "runtime.error") {
      this.send(delegationId, `${this.targetName(targetId)} recoverable error: ${event.message.slice(0, 180)}`, "commentary");
    }
  }

  private send(delegationId: string, text: string, channel: "speakable" | "commentary", complete = false): void {
    if (this.stopped || this.options.socket.readyState !== 1 || !text.trim()) return;
    if (this.options.transport === "ga-realtime") {
      if (channel === "commentary") return;
      if (complete) {
        this.enqueueGa({ outputs: [{ delegationId, text }] });
      } else {
        this.enqueueGa({ instructions: `Briefly say this exact status without adding claims: ${text.trim()}` });
      }
      return;
    }
    for (const chunk of chunkDelegationText(text.trim())) {
      this.options.socket.send(JSON.stringify({
        type: "delegation.context.append",
        delegation_item_id: delegationId,
        channel,
        content: [{ type: "input_text", text: chunk }],
      }));
    }
  }

  private sendGaFunctionOutput(delegationId: string, text: string): void {
    this.options.socket.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: delegationId, output: text.trim() },
    }));
  }

  private enqueueGa(delivery: GaDelivery): void {
    if (this.stopped) return;
    this.gaOutbox.push(delivery);
    this.drainGaOutbox();
  }

  private drainGaOutbox(): void {
    if (this.stopped || this.gaResponseInFlight || this.options.socket.readyState !== 1) return;
    const delivery = this.gaOutbox.shift();
    if (!delivery) return;
    for (const output of delivery.outputs ?? []) this.sendGaFunctionOutput(output.delegationId, output.text);
    this.options.socket.send(JSON.stringify(delivery.instructions
      ? { type: "response.create", response: { instructions: delivery.instructions } }
      : { type: "response.create" }));
    this.gaResponseInFlight = true;
  }
}
