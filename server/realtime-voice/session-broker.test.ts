import { describe, expect, it, vi } from "vitest";

import { RealtimeSessionBroker } from "./session-broker.ts";

const AUDIO_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

describe("realtime session broker", () => {
  it("consumes a 256-bit offer token once and never returns OAuth", async () => {
    const broker = new RealtimeSessionBroker({
      targetExists: (id) => id === "bot-1",
      oauth: { resolveAccess: vi.fn(async () => ({ accessToken: "oauth-secret", accountId: "acct" })) },
      createCall: vi.fn(async () => ({ kind: "ga-realtime" as const, model: "gpt-realtime-2.1" as const, answerSdp: AUDIO_SDP })),
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      controlAgent: vi.fn(async () => ({ ok: false, message: "none" })),
      respondToRequest: vi.fn(async () => {}),
    });
    const created = broker.createSession({ targetId: "bot-1", voice: "marin" });
    expect(Buffer.from(created.offerToken, "base64url")).toHaveLength(32);
    expect(JSON.stringify(created)).not.toContain("oauth-secret");
    await expect(broker.acceptOffer(created.offerToken, AUDIO_SDP)).resolves.toEqual({
      answerSdp: AUDIO_SDP,
      transport: "ga-realtime",
      model: "gpt-realtime-2.1",
    });
    await expect(broker.acceptOffer(created.offerToken, AUDIO_SDP)).rejects.toThrow(/expired|invalid/i);
    expect(JSON.stringify(broker.describe(created.sessionId))).not.toContain("oauth-secret");
    await broker.closeSession(created.sessionId);
    expect(broker.describe(created.sessionId)).toBeUndefined();
  });

  it("refuses a second active window session and invalid media", async () => {
    const broker = new RealtimeSessionBroker({
      targetExists: () => true,
      oauth: { resolveAccess: vi.fn() },
      createCall: vi.fn(),
      runAgentConsult: vi.fn(),
      controlAgent: vi.fn(),
      respondToRequest: vi.fn(),
    });
    const created = broker.createSession({ targetId: "bot-1" });
    expect(() => broker.createSession({ targetId: "bot-2" })).toThrow(/active/i);
    await expect(broker.acceptOffer(created.offerToken, "v=0\r\nm=video 9 RTP/AVP 96\r\n")).rejects.toThrow(/audio|video/i);
  });

  it("expires pending offers and fences stale cleanup", async () => {
    vi.useFakeTimers();
    try {
      const broker = new RealtimeSessionBroker({
        targetExists: () => true,
        oauth: { resolveAccess: vi.fn() },
        createCall: vi.fn(),
        runAgentConsult: vi.fn(),
        controlAgent: vi.fn(),
        respondToRequest: vi.fn(),
      });
      const old = broker.createSession({ targetId: "bot-1" });
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(broker.acceptOffer(old.offerToken, AUDIO_SDP)).rejects.toThrow(/expired|invalid/i);
      expect(() => broker.createSession({ targetId: "bot-2" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
