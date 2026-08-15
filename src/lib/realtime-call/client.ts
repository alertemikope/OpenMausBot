export type RealtimeSessionCreated = {
  sessionId: string;
  offerToken: string;
  offerUrl: string;
  expiresAt: number;
};

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return Object.assign(new Error(body.error || `Realtime call failed (${response.status})`), { status: response.status });
}

export async function createRealtimeSession(input: {
  targetId: string;
  voice?: string;
  language?: string;
  initialText?: string;
  signal?: AbortSignal;
}): Promise<RealtimeSessionCreated> {
  const response = await fetch("/api/realtime/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: input.signal,
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function exchangeRealtimeOffer(input: {
  offerUrl: string;
  offerToken: string;
  offerSdp: string;
  signal?: AbortSignal;
}): Promise<{ answerSdp: string; transport: "gpt-live" | "ga-realtime"; model: string }> {
  const response = await fetch(input.offerUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${input.offerToken}`, "content-type": "application/sdp" },
    body: input.offerSdp,
    signal: input.signal,
  });
  if (!response.ok) throw await responseError(response);
  const transport = response.headers.get("x-openmaus-realtime-transport");
  return {
    answerSdp: await response.text(),
    transport: transport === "ga-realtime" ? "ga-realtime" : "gpt-live",
    model: response.headers.get("x-openmaus-realtime-model") || "gpt-live-1-codex",
  };
}

export async function deleteRealtimeSession(sessionId: string): Promise<void> {
  await fetch(`/api/realtime/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
}

export async function interruptRealtimeVoice(sessionId: string): Promise<void> {
  const response = await fetch(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/voice/interrupt`, { method: "POST" });
  if (!response.ok) throw await responseError(response);
}

export function subscribeRealtimeEvents(sessionId: string, onEvent: (event: Record<string, unknown>) => void): () => void {
  const source = new EventSource(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/events`);
  source.onmessage = (message) => {
    if (typeof message.data !== "string" || message.data.length > 1_000_000) return;
    try {
      const event = JSON.parse(message.data) as Record<string, unknown>;
      if (typeof event.type === "string") onEvent(event);
    } catch {}
  };
  return () => source.close();
}

export async function publishRealtimeEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw await responseError(response);
}
