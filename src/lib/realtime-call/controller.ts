import { createRealtimeSession, deleteRealtimeSession, exchangeRealtimeOffer, publishRealtimeEvent, subscribeRealtimeEvents } from "./client";
import { RealtimeMediaPeer, type RealtimePeerEvent } from "./media-peer";
import type { LivePhase, RealtimeCallAction } from "./state";
import type { RealtimeConnectionInfo } from "./state";

type RealtimeControllerOptions = {
  targetId: string;
  generation: number;
  audio: HTMLAudioElement;
  voice?: string;
  language?: string;
  initialText?: string;
  deviceId?: string;
  onState(action: RealtimeCallAction): void;
  onCaption(role: "user" | "assistant", text: string, done: boolean): void;
  onInitialFallback?(text: string): void;
  createMediaPeer?: (options: ConstructorParameters<typeof RealtimeMediaPeer>[0]) => RealtimeMediaPeer;
};

export function peerPhase(event: RealtimePeerEvent): LivePhase | undefined {
  if (event.type === "input_transcript.added" || event.type === "input_audio_buffer.speech_started") return "hearing";
  if (
    event.type === "output_transcript.added"
    || event.type === "output_audio.delta"
    || event.type === "output_audio_buffer.started"
    || event.type === "response.output_audio_transcript.delta"
    || event.type === "response.audio_transcript.delta"
  ) return "speaking";
  if (event.type === "delegation.created" || event.type === "response.function_call_arguments.done") return "working";
  if (event.type === "turn.done" || event.type === "response.done" || event.type === "output_audio_buffer.stopped") return "listening";
  return undefined;
}

function needsHarnessRelay(event: RealtimePeerEvent): boolean {
  return event.type === "response.function_call_arguments.done"
    || event.type === "response.output_item.done"
    || event.type === "conversation.item.input_audio_transcription.completed"
    || event.type === "error";
}

export class RealtimeCallController {
  private readonly abort = new AbortController();
  private media?: RealtimeMediaPeer;
  private sessionId?: string;
  private connected = false;
  private closed = false;
  private unsubscribeEvents?: () => void;
  private transport?: "gpt-live" | "ga-realtime";
  private connectionInfo?: RealtimeConnectionInfo;
  private userTranscript = "";
  private assistantTranscript = "";

  constructor(private readonly options: RealtimeControllerOptions) {}

  async start(): Promise<void> {
    const { targetId, generation } = this.options;
    const startedAt = performance.now();
    this.options.onState({ type: "authorize", targetId, generation });
    try {
      const session = await createRealtimeSession({
        targetId,
        voice: this.options.voice,
        language: this.options.language,
        initialText: this.options.initialText,
        signal: this.abort.signal,
      });
      this.abort.signal.throwIfAborted();
      this.sessionId = session.sessionId;
      this.unsubscribeEvents = subscribeRealtimeEvents(session.sessionId, (event) => this.media?.sendEvent(event as RealtimePeerEvent));
      this.options.onState({ type: "session", targetId, sessionId: session.sessionId, generation });
      const createPeer = this.options.createMediaPeer ?? ((peerOptions) => new RealtimeMediaPeer(peerOptions));
      this.media = createPeer({
        audio: this.options.audio,
        deviceId: this.options.deviceId,
        onEvent: (event) => this.onPeerEvent(event),
        onConnectionState: (state) => {
          if (!this.sessionId || this.closed) return;
          if (state === "disconnected") this.options.onState({ type: "reconnecting", sessionId: this.sessionId, generation });
          if (state === "connected" && this.connected && this.connectionInfo) {
            this.options.onState({ type: "connected", sessionId: this.sessionId, generation, ...this.connectionInfo });
          }
          if (state === "failed") void this.fail(new Error("The WebRTC voice connection failed"));
        },
      });
      const offerSdp = await this.media.createOffer();
      const answer = await exchangeRealtimeOffer({
        offerUrl: session.offerUrl,
        offerToken: session.offerToken,
        offerSdp,
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(45_000)]),
      });
      this.transport = answer.transport;
      this.connectionInfo = {
        transport: answer.transport,
        model: answer.model,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
      await this.media.applyAnswer(answer.answerSdp);
      this.abort.signal.throwIfAborted();
      this.connected = true;
      this.options.onState({
        type: "connected",
        sessionId: session.sessionId,
        generation,
        ...this.connectionInfo,
      });
    } catch (error) {
      if (!this.abort.signal.aborted) await this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  setMuted(muted: boolean): void {
    this.media?.setMuted(muted);
    if (this.sessionId) {
      this.options.onState({
        type: "phase",
        sessionId: this.sessionId,
        generation: this.options.generation,
        phase: muted ? "muted" : "listening",
      });
    }
  }

  interruptVoice(): void {
    this.media?.interruptVoice();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort(new Error("Realtime call closed"));
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    await this.media?.close();
    if (this.sessionId) await deleteRealtimeSession(this.sessionId);
    this.options.onState({ type: "closed", generation: this.options.generation });
  }

  private onPeerEvent(event: RealtimePeerEvent): void {
    if (!this.sessionId || this.closed) return;
    if (event.type === "input_audio_buffer.speech_started") this.userTranscript = "";
    if (event.type === "response.created") this.assistantTranscript = "";
    // Provider events originate on the renderer-owned V3 data channel; the
    // local harness receives the same bounded event for delegation and exact
    // confirmation handling. OAuth never crosses this bridge.
    if (this.transport === "ga-realtime" && needsHarnessRelay(event)) {
      void publishRealtimeEvent(this.sessionId, event).catch((error) => {
        if (!this.closed && (event.type === "response.function_call_arguments.done" || event.type === "response.output_item.done")) {
          void this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    const phase = peerPhase(event);
    if (phase) this.options.onState({ type: "phase", sessionId: this.sessionId, generation: this.options.generation, phase });
    if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
      const item = event.item as { text?: unknown } | undefined;
      if (typeof item?.text === "string") {
        this.caption(event.type.startsWith("input") ? "user" : "assistant", item.text, false, false);
      }
    } else if (event.type === "turn.done") {
      const turn = event.turn as { role?: unknown; transcript?: unknown } | undefined;
      if ((turn?.role === "user" || turn?.role === "assistant") && typeof turn.transcript === "string") {
        this.caption(turn.role, turn.transcript, true, false);
      }
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      this.caption("user", event.transcript, true, false);
    } else if ((event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") && typeof event.delta === "string") {
      this.caption("assistant", event.delta, false, true);
    } else if ((event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") && typeof event.transcript === "string") {
      this.caption("assistant", event.transcript, true, false);
    }
  }

  private caption(role: "user" | "assistant", text: string, done: boolean, delta: boolean): void {
    const bounded = text.slice(0, 8_000);
    if (role === "user") {
      this.userTranscript = delta ? `${this.userTranscript}${bounded}`.slice(-8_000) : bounded;
      this.options.onCaption(role, this.userTranscript, done);
    } else {
      this.assistantTranscript = delta ? `${this.assistantTranscript}${bounded}`.slice(-8_000) : bounded;
      this.options.onCaption(role, this.assistantTranscript, done);
    }
  }

  private async fail(error: Error): Promise<void> {
    if (this.closed) return;
    if (!this.connected && this.options.initialText?.trim()) this.options.onInitialFallback?.(this.options.initialText.trim());
    this.options.onState({
      type: "failed",
      targetId: this.options.targetId,
      generation: this.options.generation,
      message: error.message.slice(0, 300),
      recoverable: true,
    });
    this.abort.abort(error);
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    await this.media?.close();
    if (this.sessionId) await deleteRealtimeSession(this.sessionId);
  }
}
