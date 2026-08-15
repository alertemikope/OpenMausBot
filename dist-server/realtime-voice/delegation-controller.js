import { classifyAgentControl } from "./agent-control.js";
import { VoiceConfirmationController } from "./confirmation-controller.js";
import { chunkDelegationText, parseLiveEvent } from "./openai-live-wire.js";
const MAX_RESULT_CHARS = 1_800;
export class LiveDelegationController {
    active;
    generation = 0;
    followups = [];
    replacement;
    seenDelegations = new Set();
    confirmations = new VoiceConfirmationController();
    options;
    stopped = false;
    constructor(options) { this.options = options; }
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
        void this.route({ id: event.id, prompt: event.prompt, ...(event.mode ? { mode: event.mode } : {}) });
    }
    stop(reason = new Error("GPT-Live session closed")) {
        if (this.stopped)
            return;
        this.stopped = true;
        this.generation += 1;
        this.active?.controller.abort(reason);
        this.active = undefined;
        this.followups = [];
        this.replacement = undefined;
        this.seenDelegations.clear();
        this.confirmations.clear();
    }
    async route(delegation) {
        const pending = this.confirmations.current();
        if (pending.type === "pending") {
            // The model-created delegation is never authorization. Only the raw,
            // completed user transcript handled below can consume this request.
            this.send(delegation.id, `Confirmation is still pending for: ${pending.exactSummary}. Say “Oui, je confirme” or “Non, je refuse”.`, "speakable", true);
            return;
        }
        const intent = delegation.mode
            ? delegation.mode === "task" ? null : { mode: delegation.mode, text: delegation.prompt }
            : classifyAgentControl(delegation.prompt);
        if (intent?.mode === "followup") {
            this.followups.push({ id: delegation.id, prompt: intent.text });
            // GA function calls must receive exactly one function_call_output. Keep
            // this call pending until its queued harness turn actually completes;
            // a separate response.create may announce that it was queued.
            this.send(delegation.id, "I queued that follow-up after the current task.", "speakable", this.options.transport !== "ga-realtime");
            if (!this.active)
                this.launch(this.followups.shift());
            return;
        }
        if (intent) {
            const result = await this.options.control({
                voiceSessionId: this.options.voiceSessionId,
                targetId: this.options.targetId,
                mode: intent.mode,
                text: intent.text,
            });
            if (intent.mode === "cancel" && result.ok && this.active) {
                const cancelled = this.active.delegation;
                this.active.controller.abort(new Error("Agent task cancelled by user"));
                if (this.options.transport === "ga-realtime") {
                    if (this.options.socket.readyState === 1) {
                        this.sendGaFunctionOutput(cancelled.id, "The delegated agent task was cancelled by the user.");
                        this.sendGaFunctionOutput(delegation.id, result.message);
                        this.options.socket.send(JSON.stringify({ type: "response.create" }));
                    }
                    return;
                }
            }
            this.send(delegation.id, result.message, "speakable", true);
            return;
        }
        if (this.active) {
            this.replacement = delegation;
            this.active.controller.abort(new Error("GPT-Live delegation superseded"));
            return;
        }
        this.launch(delegation);
    }
    async resolveConfirmationTranscript(text) {
        const pending = this.confirmations.current();
        if (pending.type !== "pending")
            return;
        const decision = this.confirmations.resolve(text, {
            requestId: pending.requestId,
            threadId: pending.threadId,
            exactSummary: pending.exactSummary,
        });
        if (decision !== "allow" && decision !== "deny")
            return;
        try {
            await this.options.respondToRequest({
                targetId: this.options.targetId,
                threadId: pending.threadId,
                requestId: pending.requestId,
                behavior: decision,
            });
            const message = decision === "allow"
                ? "Confirmed. The agent may continue with that exact action."
                : "Denied. The agent will skip that exact action.";
            if (this.active)
                this.send(this.active.delegation.id, message, "speakable");
        }
        catch {
            if (this.active) {
                this.send(this.active.delegation.id, "That approval request changed or expired, so I did not authorize it.", "speakable");
            }
        }
    }
    launch(delegation) {
        if (this.stopped)
            return;
        const controller = new AbortController();
        const generation = ++this.generation;
        this.active = { delegation, controller, generation };
        void this.options.runtime
            .run({
            voiceSessionId: this.options.voiceSessionId,
            targetId: this.options.targetId,
            prompt: delegation.prompt,
            signal: controller.signal,
            onEvent: (event) => this.onRuntimeEvent(generation, delegation.id, event),
        })
            .then((result) => {
            if (!controller.signal.aborted && this.active?.generation === generation) {
                const text = result.text.length > MAX_RESULT_CHARS
                    ? `${result.text.slice(0, MAX_RESULT_CHARS - 14).trimEnd()} [truncated]`
                    : result.text;
                this.send(delegation.id, text || "The agent finished without a speakable result.", "speakable", true);
            }
        })
            .catch((error) => {
            if (!controller.signal.aborted && this.active?.generation === generation) {
                this.send(delegation.id, `The agent task failed: ${error instanceof Error ? error.message.slice(0, 180) : "unknown error"}`, "speakable", true);
            }
        })
            .finally(() => {
            if (this.active?.generation !== generation)
                return;
            this.active = undefined;
            const next = this.replacement ?? this.followups.shift();
            this.replacement = undefined;
            if (next)
                this.launch(next);
        });
    }
    onRuntimeEvent(generation, delegationId, event) {
        if (this.stopped || this.active?.generation !== generation)
            return;
        if (event.type === "request.opened" && event.requestType === "permission" && event.requestId) {
            this.confirmations.open({ requestId: event.requestId, threadId: event.threadId, exactSummary: event.summary });
            this.send(delegationId, `Approval required: ${event.summary}. Say “Oui, je confirme” or “Non, je refuse”.`, "speakable");
        }
        else if (event.type === "item.started" && event.itemType === "tool") {
            this.send(delegationId, `Current tool: ${event.title ?? "tool"}.`, "commentary");
        }
        else if (event.type === "runtime.error") {
            this.send(delegationId, `Recoverable agent error: ${event.message.slice(0, 180)}`, "commentary");
        }
    }
    send(delegationId, text, channel, complete = false) {
        if (this.stopped || this.options.socket.readyState !== 1 || !text.trim())
            return;
        if (this.options.transport === "ga-realtime") {
            if (channel === "commentary")
                return;
            if (complete) {
                this.sendGaFunctionOutput(delegationId, text);
                this.options.socket.send(JSON.stringify({ type: "response.create" }));
            }
            else {
                this.options.socket.send(JSON.stringify({
                    type: "response.create",
                    response: { instructions: `Briefly say this exact status without adding claims: ${text.trim()}` },
                }));
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
}
