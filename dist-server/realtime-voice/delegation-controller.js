import { classifyAgentControl } from "./agent-control.js";
import { VoiceConfirmationController } from "./confirmation-controller.js";
import { chunkDelegationText, parseLiveEvent } from "./openai-live-wire.js";
const MAX_RESULT_CHARS = 1_800;
function normalized(value) {
    return value
        .normalize("NFKD")
        .replaceAll(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replaceAll(/[^\p{Letter}\p{Number}]+/gu, " ")
        .trim();
}
export class LiveDelegationController {
    active = new Map();
    followups = new Map();
    generation = 0;
    seenDelegations = new Set();
    confirmations = new VoiceConfirmationController();
    pendingApproval;
    gaOutbox = [];
    gaResponseInFlight = false;
    options;
    targets;
    stopped = false;
    constructor(options) {
        this.options = options;
        const targets = options.targets?.filter((target) => target.id && target.name) ?? [];
        this.targets = targets.some((target) => target.id === options.targetId)
            ? targets
            : [{ id: options.targetId, name: options.targetId }, ...targets];
    }
    handle(payload) {
        const event = parseLiveEvent(payload);
        if (!event || this.stopped || event.kind === "ignored")
            return;
        if (event.kind === "transcript") {
            if (event.done && event.role === "user")
                void this.resolveConfirmationTranscript(event.text);
            return;
        }
        if (event.kind === "session-started")
            return this.options.onSessionStarted?.(event.expiresAt);
        if (event.kind === "response-finished") {
            this.gaResponseInFlight = false;
            this.drainGaOutbox();
            return;
        }
        if (event.kind === "error") {
            if (event.fatalAuth)
                this.options.onFatal(new Error(`GPT-Live authentication failed: ${event.message}`));
            return;
        }
        if (event.kind === "unknown")
            return;
        if (this.seenDelegations.has(event.id))
            return;
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
    stop(_reason = new Error("GPT-Live session closed")) {
        if (this.stopped)
            return;
        this.stopped = true;
        this.seenDelegations.clear();
        this.confirmations.clear();
        this.pendingApproval = undefined;
        this.gaOutbox.length = 0;
    }
    target(delegation) {
        if (delegation.targetId) {
            return this.targets.some((target) => target.id === delegation.targetId) ? delegation.targetId : undefined;
        }
        const prompt = normalized(delegation.prompt);
        const named = [...this.targets]
            .sort((left, right) => right.name.length - left.name.length)
            .find((target) => {
            const name = normalized(target.name);
            if (!name)
                return false;
            return prompt === name
                || prompt.startsWith(`${name} `)
                || ["demande a", "dis a", "confie a", "ask", "tell", "have", "use"]
                    .some((prefix) => (` ${prompt} `).includes(` ${prefix} ${name} `));
        });
        return named?.id ?? this.options.targetId;
    }
    targetName(targetId) {
        return this.targets.find((target) => target.id === targetId)?.name ?? targetId;
    }
    knownActiveTargets() {
        return [...new Set([
                ...this.active.keys(),
                ...(this.options.activeTargets?.() ?? []),
            ])].filter((targetId) => this.targets.some((target) => target.id === targetId));
    }
    controlTarget(delegation) {
        if (delegation.targetId || this.targets.some((target) => (` ${normalized(delegation.prompt)} `).includes(` ${normalized(target.name)} `))) {
            return this.target(delegation);
        }
        const activeTargets = this.knownActiveTargets();
        if (activeTargets.length === 1)
            return activeTargets[0];
        return activeTargets.length === 0 ? this.options.targetId : undefined;
    }
    async route(delegation) {
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
            const queued = { ...delegation, prompt: intent.text, targetId };
            const queue = this.followups.get(targetId) ?? [];
            queue.push(queued);
            this.followups.set(targetId, queue);
            this.send(delegation.id, `I queued that follow-up for ${this.targetName(targetId)}.`, "speakable", this.options.transport !== "ga-realtime");
            if (!this.active.has(targetId))
                this.launch(targetId, queue.shift());
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
        if (this.active.has(targetId)) {
            const queue = this.followups.get(targetId) ?? [];
            queue.push({ ...delegation, targetId });
            this.followups.set(targetId, queue);
            this.send(delegation.id, `${this.targetName(targetId)} is already working. I queued this request next.`, "speakable", this.options.transport !== "ga-realtime");
            return;
        }
        this.launch(targetId, { ...delegation, targetId });
    }
    async resolveConfirmationTranscript(text) {
        const pending = this.confirmations.current();
        const owner = this.pendingApproval;
        if (pending.type !== "pending" || !owner)
            return;
        const decision = this.confirmations.resolve(text, {
            requestId: pending.requestId,
            threadId: pending.threadId,
            exactSummary: pending.exactSummary,
        });
        if (decision !== "allow" && decision !== "deny")
            return;
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
        }
        catch {
            this.send(owner.delegationId, "That approval request changed or expired, so I did not authorize it.", "speakable");
        }
    }
    async routeRoutine(id, request) {
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
        }
        catch (error) {
            this.send(id, `I did not change the routine: ${error instanceof Error ? error.message.slice(0, 220) : "unknown error"}`, "speakable", true);
        }
    }
    launch(targetId, delegation) {
        const controller = new AbortController();
        const generation = ++this.generation;
        this.active.set(targetId, { delegation, targetId, controller, generation });
        void this.options.runtime.run({
            voiceSessionId: this.options.voiceSessionId,
            targetId,
            prompt: delegation.prompt,
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
            if (this.active.get(targetId)?.generation !== generation)
                return;
            this.active.delete(targetId);
            const queue = this.followups.get(targetId);
            const next = queue?.shift();
            if (!queue?.length)
                this.followups.delete(targetId);
            if (next)
                this.launch(targetId, next);
        });
    }
    onRuntimeEvent(targetId, generation, delegationId, event) {
        if (this.stopped || this.active.get(targetId)?.generation !== generation)
            return;
        if (event.type === "request.opened" && event.requestType === "permission" && event.requestId) {
            this.confirmations.open({ requestId: event.requestId, threadId: event.threadId, exactSummary: event.summary });
            this.pendingApproval = { targetId, delegationId };
            this.send(delegationId, `Approval required for ${this.targetName(targetId)}: ${event.summary}. Say “Oui, je confirme” or “Non, je refuse”.`, "speakable");
        }
        else if (event.type === "item.started" && event.itemType === "tool") {
            this.send(delegationId, `${this.targetName(targetId)} current tool: ${event.title ?? "tool"}.`, "commentary");
        }
        else if (event.type === "runtime.error") {
            this.send(delegationId, `${this.targetName(targetId)} recoverable error: ${event.message.slice(0, 180)}`, "commentary");
        }
    }
    send(delegationId, text, channel, complete = false) {
        if (this.stopped || this.options.socket.readyState !== 1 || !text.trim())
            return;
        if (this.options.transport === "ga-realtime") {
            if (channel === "commentary")
                return;
            if (complete) {
                this.enqueueGa({ outputs: [{ delegationId, text }] });
            }
            else {
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
    sendGaFunctionOutput(delegationId, text) {
        this.options.socket.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: delegationId, output: text.trim() },
        }));
    }
    enqueueGa(delivery) {
        if (this.stopped)
            return;
        this.gaOutbox.push(delivery);
        this.drainGaOutbox();
    }
    drainGaOutbox() {
        if (this.stopped || this.gaResponseInFlight || this.options.socket.readyState !== 1)
            return;
        const delivery = this.gaOutbox.shift();
        if (!delivery)
            return;
        for (const output of delivery.outputs ?? [])
            this.sendGaFunctionOutput(output.delegationId, output.text);
        this.options.socket.send(JSON.stringify(delivery.instructions
            ? { type: "response.create", response: { instructions: delivery.instructions } }
            : { type: "response.create" }));
        this.gaResponseInFlight = true;
    }
}
