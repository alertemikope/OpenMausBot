import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { assertAudioOnlyOffer } from "./sdp.ts";
import { LiveDelegationController } from "./delegation-controller.ts";
import type {
  AgentControlMode,
  AgentControlResult,
  AgentConsultRuntime,
  LiveTargetDescriptor,
  LiveSessionCreateRequest,
  LiveSessionCreated,
  LiveSessionPublic,
  OAuthAccessProvider,
} from "./contracts.ts";
import { LIVE_MODEL } from "./contracts.ts";
import { buildLiveSession, createLiveCall, parseLiveEvent, type LiveRequestIds } from "./openai-live-wire.ts";
import { connectLiveSideband, type LiveSidebandSocket } from "./sideband.ts";
import { VoiceTranscriptStore, type VoiceTranscript, type VoiceTranscriptEntry } from "./transcript-store.ts";

const OFFER_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SDP_BYTES = 256 * 1024;

type Session = LiveSessionPublic & {
  offerToken?: string;
  offerExpiresAt: number;
  timer: NodeJS.Timeout;
  abort: AbortController;
  socket?: LiveSidebandSocket;
  delegations?: LiveDelegationController;
  request: LiveSessionCreateRequest;
  requestIds: LiveRequestIds;
  listeners: Set<(payload: string) => void>;
  outboundEvents: string[];
  startedAt: number;
  transcript: VoiceTranscriptEntry[];
};

type BrokerOptions = {
  targetExists: (targetId: string) => boolean;
  listTargets?: () => LiveTargetDescriptor[];
  oauth: OAuthAccessProvider;
  createCall?: typeof createLiveCall;
  connectSideband?: typeof connectLiveSideband;
  runAgentConsult: AgentConsultRuntime["run"];
  activeAgentTargets?: () => string[];
  controlAgent: (input: { voiceSessionId: string; targetId: string; mode: AgentControlMode; text: string }) => Promise<AgentControlResult>;
  respondToRequest: (input: { targetId: string; threadId: string; requestId: string; behavior: "allow" | "deny" }) => Promise<void>;
};

class BrowserRelaySocket extends EventEmitter {
  readyState = 1;
  private readonly deliver: (payload: string) => void;

  constructor(deliver: (payload: string) => void) {
    super();
    this.deliver = deliver;
  }

  send(payload: string): void {
    if (this.readyState === 1) this.deliver(payload);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

export class RealtimeSessionBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly offerSessions = new Map<string, string>();
  private readonly options: BrokerOptions;
  private readonly transcriptStore: VoiceTranscriptStore;

  constructor(options: BrokerOptions & { transcriptStore?: VoiceTranscriptStore }) {
    this.options = options;
    this.transcriptStore = options.transcriptStore ?? new VoiceTranscriptStore();
  }

  createSession(request: LiveSessionCreateRequest): LiveSessionCreated {
    this.prune();
    const targetId = request.targetId?.trim();
    if (!targetId || !this.options.targetExists(targetId)) throw Object.assign(new Error("No such realtime target"), { status: 404 });
    if (this.sessions.size) throw Object.assign(new Error("A realtime call is already active in this window"), { status: 409 });
    const sessionId = `voice-${randomUUID()}`;
    const offerToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: Session = {
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

  describe(sessionId: string): LiveSessionPublic | undefined {
    const session = this.sessions.get(sessionId);
    return session
      ? { sessionId: session.sessionId, targetId: session.targetId, state: session.state, expiresAt: session.expiresAt }
      : undefined;
  }

  list(): LiveSessionPublic[] {
    this.prune();
    return [...this.sessions.values()]
      .map((session) => this.describe(session.sessionId))
      .filter((session): session is LiveSessionPublic => Boolean(session));
  }

  async acceptOffer(offerToken: string, offerSdp: string): Promise<{ answerSdp: string; transport: "gpt-live" | "ga-realtime"; model: string }> {
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
              if (session.outboundEvents.length < 32 && Buffer.byteLength(payload) <= 1024 * 1024) session.outboundEvents.push(payload);
              return;
            }
            for (const listener of session.listeners) {
              try { listener(payload); } catch {}
            }
          }) as LiveSidebandSocket;
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
        onFatal: () => void this.closeSession(session.sessionId),
        onSessionStarted: (expiresAt) => {
          if (expiresAt) session.expiresAt = Math.min(session.expiresAt, expiresAt * 1_000);
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
        for (const event of buildGaRealtimeSetup(liveSession, targets)) socket.send(JSON.stringify(event));
      }
      return { answerSdp: call.answerSdp, transport: call.kind, model: call.model };
    } catch (error) {
      await this.closeSession(session.sessionId);
      throw error;
    }
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (session.offerToken) this.offerSessions.delete(session.offerToken);
    session.state = "closing";
    clearTimeout(session.timer);
    session.abort.abort(new Error("Realtime session closed"));
    session.delegations?.stop();
    session.socket?.close(1000, "session closed");
    this.transcriptStore.save({
      sessionId: session.sessionId,
      targetId: session.targetId,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      entries: session.transcript,
    });
    return true;
  }

  interruptVoice(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.socket || session.state !== "live" || session.socket.readyState !== 1) return false;
    session.socket.send(JSON.stringify({ type: "response.cancel" }));
    return true;
  }

  ingestEvent(sessionId: string, payload: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.delegations || session.state !== "live" || Buffer.byteLength(payload) > 1024 * 1024) return false;
    this.handleProviderPayload(session, payload);
    return true;
  }

  history(limit = 20): VoiceTranscript[] {
    return this.transcriptStore.list(limit);
  }

  transcript(sessionId: string): VoiceTranscript | undefined {
    return this.transcriptStore.get(sessionId);
  }

  removeTranscript(sessionId: string): boolean {
    return this.transcriptStore.remove(sessionId);
  }

  clearHistory(): number {
    return this.transcriptStore.clear();
  }

  subscribe(sessionId: string, listener: (payload: string) => void): (() => void) | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.listeners.add(listener);
    const queued = session.outboundEvents;
    session.outboundEvents = [];
    for (const payload of queued) listener(payload);
    return () => session.listeners.delete(listener);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
  }

  private prune(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if ((session.state === "pending" && session.offerExpiresAt <= now) || session.expiresAt <= now) {
        void this.closeSession(session.sessionId);
      }
    }
  }

  private handleProviderPayload(session: Session, payload: string): void {
    const event = parseLiveEvent(payload);
    if (event?.kind === "transcript" && event.done && event.text.trim()) {
      const entry: VoiceTranscriptEntry = { role: event.role, text: event.text.trim().slice(0, 8_000), at: Date.now() };
      const previous = session.transcript.at(-1);
      if (!previous || previous.role !== entry.role || previous.text !== entry.text) session.transcript.push(entry);
      if (session.transcript.length > 200) session.transcript.splice(0, session.transcript.length - 200);
    }
    session.delegations?.handle(payload);
  }
}

function buildGaRealtimeSetup(live: ReturnType<typeof buildLiveSession>, targets: LiveTargetDescriptor[] = []): Record<string, unknown>[] {
  const gaInstructions = live.instructions
    .split("\n")
    .filter((line) => !line.includes("[OPENMAUS_CONTROL:"))
    .join("\n");
  const events: Record<string, unknown>[] = [{
    type: "session.update",
    session: {
      type: "realtime",
      instructions: [
        gaInstructions,
        "For every request needing facts, reasoning, current state, or action, call agent_consult and then briefly speak its result.",
        "Use agent_consult for status, cancellation, steering, follow-ups, and permission decisions too.",
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
      tools: [{
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
      }],
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
