import type { RuntimeEvent } from "../contracts.ts";

export const LIVE_MODEL = "gpt-live-1-codex" as const;
export const LIVE_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

export type LiveVoice = (typeof LIVE_VOICES)[number];
export type LivePhase =
  | "connecting"
  | "listening"
  | "hearing"
  | "speaking"
  | "working"
  | "awaiting-approval"
  | "reconnecting"
  | "muted";

export type OAuthAccess = { accessToken: string; accountId: string };
export interface OAuthAccessProvider {
  resolveAccess(signal?: AbortSignal): Promise<OAuthAccess>;
}

export type LiveSessionCreateRequest = {
  targetId: string;
  voice?: string;
  language?: string;
  initialText?: string;
};

export type LiveSessionPublic = {
  sessionId: string;
  targetId: string;
  state: "pending" | "connecting" | "live" | "closing";
  expiresAt: number;
};

export type LiveSessionCreated = {
  sessionId: string;
  offerToken: string;
  offerUrl: "/api/realtime/offers";
  expiresAt: number;
};

export interface AgentConsultRuntime {
  run(input: {
    voiceSessionId: string;
    targetId: string;
    prompt: string;
    signal: AbortSignal;
    onEvent(event: RuntimeEvent): void;
  }): Promise<{ text: string }>;
}

export type AgentControlMode = "status" | "cancel" | "steer" | "followup";
export type AgentControlResult = { ok: boolean; message: string };

export type VoiceConfirmation =
  | { type: "none" }
  | {
      type: "pending";
      requestId: string;
      threadId: string;
      exactSummary: string;
      expiresAt: number;
    };
