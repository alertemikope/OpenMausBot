import { describe, expect, it, vi } from "vitest";

import {
  buildLiveSession,
  createLiveCall,
  parseLiveEvent,
  resolveChatGptIdentity,
  resolveLiveVoice,
} from "./openai-live-wire.ts";

const jwt = (payload: object) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("GPT-Live wire", () => {
  it("validates the closed model and voice lists", () => {
    expect(resolveLiveVoice("CEDAR")).toBe("cedar");
    expect(resolveLiveVoice("untrusted")).toBe("marin");
    expect(buildLiveSession({ model: "gpt-live-1-codex", voice: "marin" }).model).toBe(
      "gpt-live-1-codex",
    );
    expect(() => buildLiveSession({ model: "gpt-4o", voice: "marin" })).toThrow(/model/i);
  });

  it("extracts account id and expiry without exposing the token", () => {
    const token = jwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    expect(resolveChatGptIdentity(token)).toEqual({ accountId: "acct_123", expiresAt: 2_000_000_000_000 });
    expect(() => resolveChatGptIdentity("not-a-jwt")).toThrow(/token/i);
  });

  it("uses the public GPT-Live multipart endpoint with OAuth only on the server", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", {
        status: 201,
        headers: { location: "/v1/live/rtc_test" },
      }),
    );
    const result = await createLiveCall({
      auth: { accessToken: "oauth-secret", accountId: "acct_123" },
      offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      session: buildLiveSession({ model: "gpt-live-1-codex", voice: "marin" }),
      requestIds: { realtimeSessionId: "r", sessionId: "s", threadId: "t" },
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/live");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer oauth-secret",
      "chatgpt-account-id": "acct_123",
      "OpenAI-Alpha": "quicksilver=v2",
      "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
      originator: "openmausbot",
    });
    expect(String(init?.body)).toContain('name="sdp"');
    expect(String(init?.body)).toContain('name="session"');
    expect(result.answerSdp).toContain("m=audio");
    expect(result).toMatchObject({ kind: "gpt-live", sidebandUrl: "wss://api.openai.com/v1/live/rtc_test" });
  });

  it("falls back to subscription-backed GA realtime when GPT-Live is not enabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"code":"forbidden"}}', { status: 403 }))
      .mockResolvedValueOnce(new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", { status: 201 }));
    const result = await createLiveCall({
      auth: { accessToken: "oauth-secret", accountId: "acct_123" },
      offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      session: buildLiveSession({ model: "gpt-live-1-codex", voice: "marin" }),
      requestIds: { realtimeSessionId: "r", sessionId: "s", threadId: "t" },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2.1");
    expect(result).toMatchObject({ kind: "ga-realtime", model: "gpt-realtime-2.1" });
  });

  it("parses bounded transcripts, delegation, lifecycle and auth failures", () => {
    expect(parseLiveEvent(JSON.stringify({ type: "session.started", session: { expires_at: 123 } }))).toEqual({
      kind: "session-started",
      expiresAt: 123,
    });
    expect(
      parseLiveEvent(
        JSON.stringify({
          type: "delegation.created",
          item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: "Do it" }] },
        }),
      ),
    ).toEqual({ kind: "delegation", id: "d1", prompt: "Do it" });
    expect(parseLiveEvent(JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: "call-1",
      arguments: JSON.stringify({ mode: "status", prompt: "Check the agent" }),
    }))).toEqual({ kind: "delegation", id: "call-1", prompt: "Check the agent", mode: "status" });
    expect(parseLiveEvent(JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "agent_consult",
      call_id: "call-2",
      arguments: JSON.stringify({ mode: "task", target_id: "codex", prompt: "Review this" }),
    }))).toEqual({ kind: "delegation", id: "call-2", prompt: "Review this", targetId: "codex", mode: "task" });
    expect(parseLiveEvent(JSON.stringify({
      type: "delegation.created",
      item: { type: "delegation", target: "client", id: "d2", content: [{ type: "input_text", text: "[OPENMAUS_TARGET:codex] Review this" }] },
    }))).toEqual({ kind: "delegation", id: "d2", prompt: "Review this", targetId: "codex" });
    expect(parseLiveEvent(JSON.stringify({
      type: "response.function_call_arguments.done",
      name: "routine_manage",
      call_id: "routine-1",
      arguments: JSON.stringify({
        action: "create",
        routine_name: "Morning brief",
        prompt: "Summarize urgent mail",
        target_id: "codex",
        schedule_type: "daily",
        time: "08:30",
        weekdays: [1, 2, 3, 4, 5, 99],
      }),
    }))).toEqual({
      kind: "routine",
      id: "routine-1",
      action: "create",
      name: "Morning brief",
      prompt: "Summarize urgent mail",
      targetId: "codex",
      scheduleType: "daily",
      time: "08:30",
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(parseLiveEvent(JSON.stringify({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "routine-live",
        content: [{ type: "input_text", text: '[OPENMAUS_ROUTINE] {"action":"pause","routine_name":"Morning brief"}' }],
      },
    }))).toEqual({ kind: "routine", id: "routine-live", action: "pause", name: "Morning brief" });
    expect(parseLiveEvent(JSON.stringify({ type: "response.created", response: { id: "resp-1", status: "in_progress" } }))).toEqual({ kind: "response-started" });
    expect(parseLiveEvent(JSON.stringify({ type: "response.done", response: { status: "completed" } }))).toEqual({ kind: "response-finished" });
    expect(parseLiveEvent(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Terminé" }))).toEqual({
      kind: "transcript",
      role: "assistant",
      text: "Terminé",
      done: true,
    });
    expect(parseLiveEvent(JSON.stringify({ type: "error", status: 401, error: { message: "expired" } }))).toEqual({
      kind: "error",
      message: "expired",
      fatalAuth: true,
    });
  });
});
