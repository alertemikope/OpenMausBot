export type LivePhase =
  | "listening"
  | "hearing"
  | "speaking"
  | "working"
  | "awaiting-approval"
  | "muted";

export type RealtimeTransport = "gpt-live" | "ga-realtime";
export type RealtimeConnectionInfo = { transport: RealtimeTransport; model: string; latencyMs: number };

export type RealtimeCallState =
  | { type: "idle"; generation: number }
  | { type: "authorizing"; targetId: string; generation: number }
  | { type: "connecting"; targetId: string; sessionId: string; generation: number }
  | ({ type: "live"; targetId: string; sessionId: string; phase: LivePhase; generation: number } & RealtimeConnectionInfo)
  | ({ type: "reconnecting"; targetId: string; sessionId: string; generation: number } & Partial<RealtimeConnectionInfo>)
  | { type: "closing"; targetId: string; generation: number }
  | { type: "failed"; targetId?: string; message: string; recoverable: boolean; generation: number };

export type RealtimeCallAction =
  | { type: "authorize"; targetId: string; generation: number }
  | { type: "session"; targetId: string; sessionId: string; generation: number }
  | ({ type: "connected"; sessionId: string; generation: number } & RealtimeConnectionInfo)
  | { type: "phase"; sessionId: string; phase: LivePhase; generation: number }
  | { type: "reconnecting"; sessionId: string; generation: number }
  | { type: "closing"; targetId: string; generation: number }
  | { type: "closed"; generation: number }
  | { type: "failed"; targetId?: string; message: string; recoverable?: boolean; generation: number };

export const initialRealtimeCall: RealtimeCallState = { type: "idle", generation: 0 };

function sameSession(state: RealtimeCallState, sessionId: string): state is Extract<RealtimeCallState, { sessionId: string }> {
  return "sessionId" in state && state.sessionId === sessionId;
}

export function reduceRealtimeCall(state: RealtimeCallState, action: RealtimeCallAction): RealtimeCallState {
  if (action.generation < state.generation) return state;
  switch (action.type) {
    case "authorize":
      return { type: "authorizing", targetId: action.targetId, generation: action.generation };
    case "session":
      return state.type === "authorizing" && state.targetId === action.targetId
        ? { type: "connecting", targetId: action.targetId, sessionId: action.sessionId, generation: action.generation }
        : state;
    case "connected":
      return sameSession(state, action.sessionId)
        ? {
            type: "live",
            targetId: state.targetId,
            sessionId: action.sessionId,
            phase: "listening",
            generation: action.generation,
            transport: action.transport,
            model: action.model,
            latencyMs: action.latencyMs,
          }
        : state;
    case "phase":
      return state.type === "live" && sameSession(state, action.sessionId) ? { ...state, phase: action.phase } : state;
    case "reconnecting":
      return sameSession(state, action.sessionId)
        ? {
            type: "reconnecting",
            targetId: state.targetId,
            sessionId: action.sessionId,
            generation: action.generation,
            ...(state.type === "live"
              ? { transport: state.transport, model: state.model, latencyMs: state.latencyMs }
              : {}),
          }
        : state;
    case "closing":
      return { type: "closing", targetId: action.targetId, generation: action.generation };
    case "closed":
      return { type: "idle", generation: action.generation };
    case "failed":
      return {
        type: "failed",
        ...(action.targetId ? { targetId: action.targetId } : {}),
        message: action.message,
        recoverable: action.recoverable ?? true,
        generation: action.generation,
      };
  }
}
