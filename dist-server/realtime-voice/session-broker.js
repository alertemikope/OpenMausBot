import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { assertAudioOnlyOffer } from "./sdp.js";
import { LiveDelegationController } from "./delegation-controller.js";
import { LIVE_MODEL } from "./contracts.js";
import { buildLiveSession, createLiveCall, parseLiveEvent } from "./openai-live-wire.js";
import { connectLiveSideband } from "./sideband.js";
import { VoiceTranscriptStore } from "./transcript-store.js";
import { CallMemoryService, pendingCallMemoryReview } from "./call-memory.js";
import { PiMemoryMcpClient } from "../pi-memory-client.js";
const OFFER_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SDP_BYTES = 256 * 1024;
class BrowserRelaySocket extends EventEmitter {
    readyState = 1;
    deliver;
    constructor(deliver) {
        super();
        this.deliver = deliver;
    }
    send(payload) {
        if (this.readyState === 1)
            this.deliver(payload);
    }
    close() {
        if (this.readyState === 3)
            return;
        this.readyState = 3;
        this.emit("close");
    }
}
export class RealtimeSessionBroker {
    sessions = new Map();
    offerSessions = new Map();
    options;
    transcriptStore;
    callMemory;
    onTranscriptUpdated;
    constructor(options) {
        this.options = options;
        this.transcriptStore = options.transcriptStore ?? new VoiceTranscriptStore();
        this.callMemory = options.callMemory ?? new CallMemoryService(this.transcriptStore, new PiMemoryMcpClient());
        this.onTranscriptUpdated = options.onTranscriptUpdated;
        queueMicrotask(() => {
            for (const call of this.transcriptStore.list(20).filter((candidate) => !candidate.review || candidate.review.status === "pending")) {
                void this.callMemory.process(call.sessionId).then((updated) => {
                    if (updated)
                        this.onTranscriptUpdated?.(updated);
                }).catch(() => { });
            }
        });
    }
    createSession(request) {
        this.prune();
        const targetId = request.targetId?.trim();
        if (!targetId || !this.options.targetExists(targetId))
            throw Object.assign(new Error("No such realtime target"), { status: 404 });
        if (this.sessions.size)
            throw Object.assign(new Error("A realtime call is already active in this window"), { status: 409 });
        const sessionId = `voice-${randomUUID()}`;
        const offerToken = randomBytes(32).toString("base64url");
        const now = Date.now();
        const session = {
            sessionId,
            targetId,
            state: "pending",
            expiresAt: now + SESSION_TTL_MS,
            offerExpiresAt: now + OFFER_TTL_MS,
            offerToken,
            abort: new AbortController(),
            request: { ...request, targetId },
            requestIds: { realtimeSessionId: randomUUID(), sessionId: randomUUID(), threadId: randomUUID() },
            listeners: new Set(),
            outboundEvents: [],
            startedAt: now,
            transcript: [],
            timer: setTimeout(() => void this.closeSession(sessionId), OFFER_TTL_MS),
        };
        session.timer.unref?.();
        this.sessions.set(sessionId, session);
        this.offerSessions.set(offerToken, sessionId);
        return { sessionId, offerToken, offerUrl: "/api/realtime/offers", expiresAt: session.offerExpiresAt };
    }
    describe(sessionId) {
        const session = this.sessions.get(sessionId);
        return session
            ? { sessionId: session.sessionId, targetId: session.targetId, state: session.state, expiresAt: session.expiresAt }
            : undefined;
    }
    list() {
        this.prune();
        return [...this.sessions.values()]
            .map((session) => this.describe(session.sessionId))
            .filter((session) => Boolean(session));
    }
    hasLiveSession() {
        return [...this.sessions.values()].some((session) => session.state === "live" && Boolean(session.delegations));
    }
    announce(text) {
        const session = [...this.sessions.values()].find((candidate) => candidate.state === "live" && candidate.delegations);
        return session?.delegations?.announce(text) ?? false;
    }
    async acceptOffer(offerToken, offerSdp) {
        this.prune();
        const sessionId = this.offerSessions.get(offerToken);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session || session.offerToken !== offerToken || session.offerExpiresAt <= Date.now()) {
            throw Object.assign(new Error("Invalid or expired realtime session token"), { status: 401 });
        }
        this.offerSessions.delete(offerToken);
        delete session.offerToken;
        clearTimeout(session.timer);
        if (Buffer.byteLength(offerSdp) > MAX_SDP_BYTES) {
            await this.closeSession(session.sessionId);
            throw Object.assign(new Error("Realtime SDP offer is too large"), { status: 413 });
        }
        try {
            assertAudioOnlyOffer(offerSdp);
            session.state = "connecting";
            const auth = await this.options.oauth.resolveAccess(session.abort.signal);
            const targets = (this.options.listTargets?.() ?? [])
                .filter((target) => target.id && target.name && this.options.targetExists(target.id))
                .slice(0, 24);
            const liveSession = buildLiveSession({
                model: LIVE_MODEL,
                voice: session.request.voice,
                language: session.request.language,
                initialText: session.request.initialText,
                targets,
                defaultTargetId: session.targetId,
                recentCallContext: this.transcriptStore.recentContext(),
            });
            const call = await (this.options.createCall ?? createLiveCall)({
                auth,
                offerSdp,
                session: liveSession,
                requestIds: session.requestIds,
                signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(30_000)]),
            });
            const socket = call.kind === "gpt-live"
                ? await (this.options.connectSideband ?? connectLiveSideband)({
                    url: call.sidebandUrl,
                    auth,
                    requestIds: session.requestIds,
                    signal: session.abort.signal,
                })
                : new BrowserRelaySocket((payload) => {
                    if (!session.listeners.size) {
                        if (session.outboundEvents.length < 32 && Buffer.byteLength(payload) <= 1024 * 1024)
                            session.outboundEvents.push(payload);
                        return;
                    }
                    for (const listener of session.listeners) {
                        try {
                            listener(payload);
                        }
                        catch { }
                    }
                });
            const delegations = new LiveDelegationController({
                voiceSessionId: session.sessionId,
                targetId: session.targetId,
                targets,
                socket,
                transport: call.kind,
                runtime: { run: this.options.runAgentConsult },
                activeTargets: this.options.activeAgentTargets,
                control: this.options.controlAgent,
                respondToRequest: this.options.respondToRequest,
                manageRoutine: this.options.manageRoutine,
                onFatal: () => void this.closeSession(session.sessionId),
                onSessionStarted: (expiresAt) => {
                    if (expiresAt)
                        session.expiresAt = Math.min(session.expiresAt, expiresAt * 1_000);
                },
            });
            if (call.kind === "gpt-live") {
                socket.on("message", (payload) => this.handleProviderPayload(session, String(payload)));
                socket.on("error", () => void this.closeSession(session.sessionId));
                socket.on("close", () => void this.closeSession(session.sessionId));
            }
            session.socket = socket;
            session.delegations = delegations;
            session.state = "live";
            const remaining = Math.max(0, session.expiresAt - Date.now());
            session.timer = setTimeout(() => void this.closeSession(session.sessionId), remaining);
            session.timer.unref?.();
            if (call.kind === "ga-realtime") {
                for (const event of buildGaRealtimeSetup(liveSession, targets))
                    socket.send(JSON.stringify(event));
            }
            return { answerSdp: call.answerSdp, transport: call.kind, model: call.model };
        }
        catch (error) {
            await this.closeSession(session.sessionId);
            throw error;
        }
    }
    async closeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        this.sessions.delete(sessionId);
        if (session.offerToken)
            this.offerSessions.delete(session.offerToken);
        session.state = "closing";
        clearTimeout(session.timer);
        session.abort.abort(new Error("Realtime session closed"));
        session.delegations?.stop();
        session.socket?.close(1000, "session closed");
        const transcript = this.transcriptStore.save({
            sessionId: session.sessionId,
            targetId: session.targetId,
            startedAt: session.startedAt,
            endedAt: Date.now(),
            entries: session.transcript,
        });
        if (transcript) {
            const pending = this.transcriptStore.updateReview(session.sessionId, pendingCallMemoryReview());
            if (pending)
                this.onTranscriptUpdated?.(pending);
            queueMicrotask(() => {
                void this.callMemory.process(session.sessionId).then((updated) => {
                    if (updated)
                        this.onTranscriptUpdated?.(updated);
                }).catch(() => { });
            });
        }
        return true;
    }
    interruptVoice(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session?.socket || session.state !== "live" || session.socket.readyState !== 1)
            return false;
        session.socket.send(JSON.stringify({ type: "response.cancel" }));
        return true;
    }
    ingestEvent(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session?.delegations || session.state !== "live" || Buffer.byteLength(payload) > 1024 * 1024)
            return false;
        this.handleProviderPayload(session, payload);
        return true;
    }
    history(limit = 20) {
        return this.transcriptStore.list(limit);
    }
    transcript(sessionId) {
        return this.transcriptStore.get(sessionId);
    }
    removeTranscript(sessionId) {
        return this.transcriptStore.remove(sessionId);
    }
    clearHistory() {
        return this.transcriptStore.clear();
    }
    async reviewMemoryCandidate(input) {
        const updated = await this.callMemory.review(input);
        this.onTranscriptUpdated?.(updated);
        return updated;
    }
    subscribe(sessionId, listener) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return undefined;
        session.listeners.add(listener);
        const queued = session.outboundEvents;
        session.outboundEvents = [];
        for (const payload of queued)
            listener(payload);
        return () => session.listeners.delete(listener);
    }
    async closeAll() {
        await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    }
    prune() {
        const now = Date.now();
        for (const session of this.sessions.values()) {
            if ((session.state === "pending" && session.offerExpiresAt <= now) || session.expiresAt <= now) {
                void this.closeSession(session.sessionId);
            }
        }
    }
    handleProviderPayload(session, payload) {
        const event = parseLiveEvent(payload);
        if (event?.kind === "transcript" && event.done && event.text.trim()) {
            const entry = { role: event.role, text: event.text.trim().slice(0, 8_000), at: Date.now() };
            const previous = session.transcript.at(-1);
            if (!previous || previous.role !== entry.role || previous.text !== entry.text)
                session.transcript.push(entry);
            if (session.transcript.length > 200)
                session.transcript.splice(0, session.transcript.length - 200);
        }
        session.delegations?.handle(payload);
    }
}
function buildGaRealtimeSetup(live, targets = []) {
    const gaInstructions = live.instructions
        .split("\n")
        .filter((line) => !line.includes("[OPENMAUS_CONTROL:"))
        .join("\n");
    const events = [{
            type: "session.update",
            session: {
                type: "realtime",
                instructions: [
                    gaInstructions,
                    "For every request needing facts, reasoning, current state, or action, call agent_consult and then briefly speak its result.",
                    "Use agent_consult for status, cancellation, steering, follow-ups, and permission decisions too.",
                    "Use routine_manage only when the user explicitly asks to schedule, repeat, pause, resume, delete, list, or immediately run autonomous recurring work. Never silently turn an ordinary task into a routine.",
                    "Set agent_consult.mode from the user's intent: task for new work, status for progress, cancel to stop, steer to redirect now, followup to queue later. Never turn a status request into a new task.",
                    "When the layer asks the user for an exact yes/no permission confirmation, do not call agent_consult for the confirmation utterance. The trusted transcript handler resolves it; only acknowledge naturally.",
                    targets.length ? `For work assigned to a named agent, set target_id to its exact id from this catalog: ${targets.map((target) => `${target.name}=${target.id}`).join(", ")}.` : "",
                ].join("\n"),
                audio: {
                    input: {
                        transcription: { model: "gpt-4o-mini-transcribe" },
                        turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
                    },
                    output: { voice: live.audio.output.voice },
                },
                tools: [
                    {
                        type: "function",
                        name: "agent_consult",
                        description: "Delegate reasoning, current information, status, controls, permissions, or actions to the selected OpenMausBot agent.",
                        parameters: {
                            type: "object",
                            properties: {
                                mode: {
                                    type: "string",
                                    enum: ["task", "status", "cancel", "steer", "followup"],
                                    description: "Use task for new work, status/cancel/steer for the active delegated task, and followup for work to run afterward.",
                                },
                                prompt: { type: "string", description: "The complete user request for the selected agent. Preserve its control intent." },
                                target_id: {
                                    type: "string",
                                    ...(targets.length ? { enum: targets.map((target) => target.id) } : {}),
                                    description: "Exact OpenMaus agent id. Omit only to use the default call agent.",
                                },
                            },
                            required: ["mode", "prompt"],
                            additionalProperties: false,
                        },
                    },
                    {
                        type: "function",
                        name: "routine_manage",
                        description: "Create or manage explicit autonomous OpenMausBot routines. Use only for a clear scheduling or routine-management request.",
                        parameters: {
                            type: "object",
                            properties: {
                                action: { type: "string", enum: ["create", "list", "pause", "resume", "delete", "run_now"] },
                                routine_name: { type: "string", description: "Short routine name; required except for list." },
                                prompt: { type: "string", description: "Complete autonomous task instructions; required for create." },
                                target_id: {
                                    type: "string",
                                    ...(targets.length ? { enum: targets.map((target) => target.id) } : {}),
                                    description: "Exact agent id. Omit only to use the default call agent.",
                                },
                                schedule_type: { type: "string", enum: ["once", "daily"], description: "Required for create." },
                                at: { type: "string", description: "ISO-8601 local or offset timestamp for a one-time routine." },
                                time: { type: "string", description: "Local 24-hour HH:MM time for a daily routine." },
                                weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "0=Sunday through 6=Saturday; omit for every day." },
                            },
                            required: ["action"],
                            additionalProperties: false,
                        },
                    },
                ],
                tool_choice: "auto",
            },
        }];
    const initialText = live.initial_items?.[0]?.content?.[0]?.text;
    if (initialText) {
        events.push({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text: initialText }] },
        });
        events.push({ type: "response.create" });
    }
    return events;
}
