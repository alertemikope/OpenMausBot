import { describe, expect, it } from "vitest";

import { initialRealtimeCall, reduceRealtimeCall } from "./state";

describe("realtime call state", () => {
  it("moves through authorization, connection, live and close", () => {
    const authorizing = reduceRealtimeCall(initialRealtimeCall, { type: "authorize", targetId: "bot-1", generation: 1 });
    const connecting = reduceRealtimeCall(authorizing, { type: "session", targetId: "bot-1", sessionId: "voice-1", generation: 1 });
    const live = reduceRealtimeCall(connecting, {
      type: "connected",
      sessionId: "voice-1",
      generation: 1,
      transport: "ga-realtime",
      model: "gpt-realtime-2.1",
      latencyMs: 412,
    });
    expect(live).toMatchObject({
      type: "live",
      targetId: "bot-1",
      phase: "listening",
      transport: "ga-realtime",
      model: "gpt-realtime-2.1",
      latencyMs: 412,
    });
    expect(reduceRealtimeCall(live, { type: "phase", sessionId: "voice-1", generation: 1, phase: "speaking" })).toMatchObject({ phase: "speaking" });
    expect(reduceRealtimeCall(live, { type: "reconnecting", sessionId: "voice-1", generation: 1 })).toMatchObject({
      type: "reconnecting",
      transport: "ga-realtime",
      model: "gpt-realtime-2.1",
      latencyMs: 412,
    });
  });

  it("ignores stale generations and sessions", () => {
    const newer = reduceRealtimeCall(initialRealtimeCall, { type: "authorize", targetId: "bot-new", generation: 2 });
    expect(reduceRealtimeCall(newer, { type: "failed", targetId: "bot-old", generation: 1, message: "late" })).toEqual(newer);
    expect(reduceRealtimeCall(newer, {
      type: "connected",
      sessionId: "old",
      generation: 2,
      transport: "gpt-live",
      model: "gpt-live-1-codex",
      latencyMs: 1,
    })).toEqual(newer);
  });
});
