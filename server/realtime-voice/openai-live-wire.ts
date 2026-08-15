import { randomBytes } from "node:crypto";
import { LIVE_MODEL, LIVE_VOICES, type LiveTargetDescriptor, type LiveVoice, type OAuthAccess, type VoiceRoutineRequest } from "./contracts.ts";

const LIVE_URL = "https://api.openai.com/v1/live";
const GA_MODEL = "gpt-realtime-2.1";
const GA_CALL_URL = `https://api.openai.com/v1/realtime/calls?model=${GA_MODEL}`;
const WIRE_VERSION = "0.1.17";
const CALL_ID = /^(?:rtc_[\w-]+|[0-9a-f-]{36})$/iu;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_ANSWER_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CHARS = 8_000;

export type LiveRequestIds = { realtimeSessionId: string; sessionId: string; threadId: string };
export type LiveSession = {
  model: typeof LIVE_MODEL;
  instructions: string;
  audio: { output: { voice: LiveVoice } };
  delegation: { type: "client" };
  initial_items?: Array<{
    type: "message";
    role: "user";
    content: Array<{ type: "input_text"; text: string }>;
  }>;
};

export type LiveInboundEvent =
  | { kind: "ignored"; eventType: string }
  | { kind: "session-started"; expiresAt?: number }
  | { kind: "transcript"; role: "user" | "assistant"; text: string; done: boolean }
  | { kind: "delegation"; id: string; prompt: string; targetId?: string; mode?: "task" | "status" | "cancel" | "steer" | "followup" }
  | ({ kind: "routine"; id: string } & VoiceRoutineRequest)
  | { kind: "response-started" }
  | { kind: "response-finished" }
  | { kind: "error"; message: string; fatalAuth: boolean }
  | { kind: "unknown"; eventType: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, max = MAX_TRANSCRIPT_CHARS): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

export function resolveLiveVoice(value: unknown): LiveVoice {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return LIVE_VOICES.includes(normalized as LiveVoice) ? (normalized as LiveVoice) : "marin";
}

export function buildLiveSession(params: {
  model?: string;
  voice?: string;
  instructions?: string;
  language?: string;
  initialText?: string;
  targets?: LiveTargetDescriptor[];
  defaultTargetId?: string;
  recentCallContext?: string;
}): LiveSession {
  if ((params.model ?? LIVE_MODEL) !== LIVE_MODEL) throw new Error("Unsupported GPT-Live model");
  const initialText = params.initialText?.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  const language = params.language?.trim().slice(0, 32);
  const targets = (params.targets ?? []).slice(0, 24);
  const targetCatalog = targets.length
    ? `Available OpenMaus agents (use the exact id): ${targets.map((target) => `${target.name}=${target.id}`).join(", ")}. Default: ${params.defaultTargetId ?? targets[0]?.id}.`
    : "";
  return {
    model: LIVE_MODEL,
    instructions: [
      "You are OpenMausBot's realtime voice layer. You have no tools of your own.",
      "Delegate requests requiring reasoning, current information, or actions to the client.",
      "For active-task controls, begin delegated text with exactly one marker: [OPENMAUS_CONTROL:status], [OPENMAUS_CONTROL:cancel], [OPENMAUS_CONTROL:steer], or [OPENMAUS_CONTROL:followup]. Preserve the user's request after it.",
      "For an explicit scheduling/routine request, delegate exactly [OPENMAUS_ROUTINE] followed by one compact JSON object using routine_manage fields: action, routine_name, prompt, target_id, schedule_type, at, time, weekdays. Never use this marker for ordinary immediate work.",
      "Commentary context is silent. Speakable context is delivered naturally and briefly.",
      "Never claim an action succeeded before the delegated agent reports completion.",
      "Speaking over you only interrupts speech; it never cancels delegated work.",
      "Simple requests to open, show, or switch to a bot conversation are handled locally by the app. Briefly acknowledge them and do not delegate them as agent work.",
      targetCatalog,
      targets.length ? "When the user names an agent for work, route to that agent. For client delegation, prefix the delegated text with [OPENMAUS_TARGET:exact-id]. Omit the marker only when the default agent is intended." : "",
      params.recentCallContext?.trim() ? `Recent local voice-call map (no raw audio; use only when relevant):\n${params.recentCallContext.trim().slice(0, 1_500)}` : "",
      language ? `Use ${language} as the primary spoken language.` : "",
      params.instructions?.trim().slice(0, 2_000) ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
    audio: { output: { voice: resolveLiveVoice(params.voice) } },
    delegation: { type: "client" },
    ...(initialText
      ? {
          initial_items: [
            { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: initialText }] },
          ],
        }
      : {}),
  };
}

function delegationTarget(prompt: string): { prompt: string; targetId?: string } {
  const match = prompt.match(/^\s*\[OPENMAUS_TARGET:([\w-]{1,128})\]\s*/u);
  return match
    ? { prompt: prompt.slice(match[0].length).trim(), targetId: match[1] }
    : { prompt: prompt.trim() };
}

function routineEvent(id: string, value: unknown): LiveInboundEvent | undefined {
  const decodedArgs = record(value);
  const action = boundedText(decodedArgs?.action, 32);
  if (action !== "create" && action !== "list" && action !== "pause" && action !== "resume" && action !== "delete" && action !== "run_now") return undefined;
  const nameArg = boundedText(decodedArgs?.routine_name, 120)?.trim();
  const prompt = boundedText(decodedArgs?.prompt)?.trim();
  const targetId = boundedText(decodedArgs?.target_id, 128)?.trim();
  const scheduleCandidate = boundedText(decodedArgs?.schedule_type, 32);
  const scheduleType = scheduleCandidate === "once" || scheduleCandidate === "daily" ? scheduleCandidate : undefined;
  const at = boundedText(decodedArgs?.at, 128)?.trim();
  const time = boundedText(decodedArgs?.time, 16)?.trim();
  const weekdays = Array.isArray(decodedArgs?.weekdays)
    ? decodedArgs.weekdays.filter((item): item is number => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 6).slice(0, 7)
    : undefined;
  return {
    kind: "routine",
    id,
    action,
    ...(nameArg ? { name: nameArg } : {}),
    ...(prompt ? { prompt } : {}),
    ...(targetId ? { targetId } : {}),
    ...(scheduleType ? { scheduleType } : {}),
    ...(at ? { at } : {}),
    ...(time ? { time } : {}),
    ...(weekdays?.length ? { weekdays } : {}),
  };
}

export function resolveChatGptIdentity(accessToken: string): { accountId: string; expiresAt?: number } {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("ChatGPT access token is not a JWT");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("ChatGPT access token payload is invalid");
  }
  const auth = record(payload["https://api.openai.com/auth"]);
  const accountId = boundedText(auth?.chatgpt_account_id, 256)?.trim();
  if (!accountId) throw new Error("ChatGPT access token is missing chatgpt-account-id");
  const exp = typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1_000 : undefined;
  return { accountId, ...(exp ? { expiresAt: exp } : {}) };
}

export function liveAuthHeaders(auth: OAuthAccess, ids: LiveRequestIds): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "OpenAI-Alpha": "quicksilver=v2",
    "session-id": ids.sessionId,
    "thread-id": ids.threadId,
    "x-session-id": ids.realtimeSessionId,
    originator: "openmausbot",
    version: WIRE_VERSION,
    "User-Agent": `openmausbot/${WIRE_VERSION}`,
  };
}

function multipartBody(offerSdp: string, session: LiveSession): { body: string; contentType: string } {
  const sessionJson = JSON.stringify(session);
  let boundary: string;
  do boundary = `openmaus-quicksilver-${randomBytes(18).toString("hex")}`;
  while (offerSdp.includes(boundary) || sessionJson.includes(boundary));
  return {
    body: [
      `--${boundary}\r\nContent-Disposition: form-data; name="sdp"\r\nContent-Type: application/sdp\r\n\r\n${offerSdp}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="session"\r\nContent-Type: application/json\r\n\r\n${sessionJson}\r\n`,
      `--${boundary}--\r\n`,
    ].join(""),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function sanitizeProviderError(value: string): string {
  return value
    .replaceAll(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
    .replaceAll(/(?:access|refresh)[_-]?token["'=:\s]+[A-Za-z0-9._~-]+/giu, "token [redacted]")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("GPT-Live response exceeded the size limit");
  return new TextDecoder().decode(bytes);
}

export async function createLiveCall(params: {
  auth: OAuthAccess;
  offerSdp: string;
  session: LiveSession;
  requestIds: LiveRequestIds;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<
  | { kind: "gpt-live"; model: typeof LIVE_MODEL; answerSdp: string; sidebandUrl: string }
  | { kind: "ga-realtime"; model: typeof GA_MODEL; answerSdp: string }
> {
  const multipart = multipartBody(params.offerSdp, params.session);
  const response = await (params.fetchImpl ?? fetch)(LIVE_URL, {
    method: "POST",
    headers: { ...liveAuthHeaders(params.auth, params.requestIds), "Content-Type": multipart.contentType },
    body: multipart.body,
    signal: params.signal,
  });
  // GPT-Live availability is not currently uniform across ChatGPT
  // subscriptions. GA Realtime is subscription-backed on the same OAuth
  // profile, so a precise 403 falls back without ever using a Platform key.
  if (response.status === 403) {
    await readBounded(response, MAX_ERROR_BYTES).catch(() => "");
    const headers = liveAuthHeaders(params.auth, params.requestIds);
    delete headers["OpenAI-Alpha"];
    const fallback = await (params.fetchImpl ?? fetch)(GA_CALL_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/sdp" },
      body: params.offerSdp,
      signal: params.signal,
    });
    if (!fallback.ok) {
      const detail = sanitizeProviderError(await readBounded(fallback, MAX_ERROR_BYTES).catch(() => ""));
      throw Object.assign(new Error(`ChatGPT realtime fallback failed (${fallback.status}).${detail ? ` ${detail}` : ""}`), { status: fallback.status });
    }
    const answerSdp = await readBounded(fallback, MAX_ANSWER_BYTES);
    if (!answerSdp.trim()) throw new Error("ChatGPT realtime fallback returned an empty SDP answer");
    return { kind: "ga-realtime", model: GA_MODEL, answerSdp };
  }
  if (!response.ok) {
    const detail = sanitizeProviderError(await readBounded(response, MAX_ERROR_BYTES).catch(() => ""));
    const hint = response.status === 403
      ? " Verify ChatGPT access, gpt-live-1-codex, the selected voice, and chatgpt-account-id."
      : "";
    throw Object.assign(new Error(`GPT-Live call failed (${response.status}).${hint}${detail ? ` ${detail}` : ""}`), {
      status: response.status,
    });
  }
  const answerSdp = await readBounded(response, MAX_ANSWER_BYTES);
  if (!answerSdp.trim()) throw new Error("GPT-Live returned an empty SDP answer");
  const location = response.headers.get("location");
  const headerId = response.headers.get("openai-session-id")?.trim() ?? "";
  let callId = "";
  try { callId = new URL(location ?? "", LIVE_URL).pathname.split("/").filter(Boolean).find((value) => CALL_ID.test(value)) ?? ""; } catch {}
  if (!CALL_ID.test(callId) && CALL_ID.test(headerId)) callId = headerId;
  if (!CALL_ID.test(callId)) throw new Error("GPT-Live response is missing a valid call id");
  return { kind: "gpt-live", model: LIVE_MODEL, answerSdp, sidebandUrl: `wss://api.openai.com/v1/live/${callId}` };
}

export function parseLiveEvent(payload: string): LiveInboundEvent | null {
  let decoded: unknown;
  try { decoded = JSON.parse(payload); } catch { return null; }
  const event = record(decoded);
  const type = boundedText(event?.type, 128);
  if (!event || !type) return null;
  if (type === "session.started") {
    const expiresAt = record(event.session)?.expires_at;
    return { kind: "session-started", ...(typeof expiresAt === "number" ? { expiresAt } : {}) };
  }
  if (type === "input_transcript.added" || type === "output_transcript.added") {
    const text = boundedText(record(event.item)?.text);
    return text === undefined
      ? { kind: "ignored", eventType: type }
      : { kind: "transcript", role: type.startsWith("input") ? "user" : "assistant", text, done: false };
  }
  if (type === "turn.done") {
    const turn = record(event.turn);
    const role = turn?.role;
    const text = boundedText(turn?.transcript);
    return (role === "user" || role === "assistant") && text !== undefined
      ? { kind: "transcript", role, text, done: true }
      : { kind: "ignored", eventType: type };
  }
  if (type === "delegation.created") {
    const item = record(event.item);
    const id = boundedText(item?.id, 256);
    const content = Array.isArray(item?.content) ? item.content : [];
    const prompt = content
      .map(record)
      .filter((part) => part?.type === "input_text")
      .map((part) => boundedText(part?.text) ?? "")
      .join("");
    if (item?.type === "delegation" && item.target === "client" && id && prompt.trim().startsWith("[OPENMAUS_ROUTINE]")) {
      try {
        return routineEvent(id, JSON.parse(prompt.trim().slice("[OPENMAUS_ROUTINE]".length).trim()))
          ?? { kind: "ignored", eventType: type };
      } catch {
        return { kind: "ignored", eventType: type };
      }
    }
    const routed = delegationTarget(prompt);
    return item?.type === "delegation" && item.target === "client" && id && routed.prompt
      ? { kind: "delegation", id, ...routed }
      : { kind: "ignored", eventType: type };
  }
  if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
    const item = type === "response.output_item.done" ? record(event.item) : event;
    const name = boundedText(item?.name, 128);
    const id = boundedText(item?.call_id, 256);
    const args = boundedText(item?.arguments, MAX_TRANSCRIPT_CHARS);
    if (name === "agent_consult" && id && args) {
      try {
        const decodedArgs = record(JSON.parse(args));
        const prompt = boundedText(decodedArgs?.prompt)?.trim();
        const targetId = boundedText(decodedArgs?.target_id, 128)?.trim();
        const candidateMode = boundedText(decodedArgs?.mode, 32);
        const mode = candidateMode === "task" || candidateMode === "status" || candidateMode === "cancel" || candidateMode === "steer" || candidateMode === "followup"
          ? candidateMode
          : undefined;
        if (prompt) return { kind: "delegation", id, prompt, ...(targetId ? { targetId } : {}), ...(mode ? { mode } : {}) };
      } catch {}
    }
    if (name === "routine_manage" && id && args) {
      try {
        const routine = routineEvent(id, JSON.parse(args));
        if (routine) return routine;
      } catch {}
    }
    return { kind: "ignored", eventType: type };
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = boundedText(event.transcript);
    return text === undefined ? { kind: "ignored", eventType: type } : { kind: "transcript", role: "user", text, done: true };
  }
  if ((type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done") && typeof event.transcript === "string") {
    const text = boundedText(event.transcript);
    return text === undefined ? { kind: "ignored", eventType: type } : { kind: "transcript", role: "assistant", text, done: true };
  }
  if (type === "response.created") return { kind: "response-started" };
  if (type === "response.done") return { kind: "response-finished" };
  if (type === "error") {
    const error = record(event.error);
    const message = boundedText(error?.message, 1_000) ?? boundedText(event.message, 1_000) ?? "GPT-Live sideband error";
    const status = event.status ?? error?.status;
    const code = String(event.code ?? error?.code ?? "").toLowerCase();
    return { kind: "error", message: sanitizeProviderError(message), fatalAuth: status === 401 || code.includes("token") || code.includes("auth") };
  }
  if (type === "output_audio.delta" || type === "session.updated") return { kind: "ignored", eventType: type };
  return { kind: "unknown", eventType: type };
}

export function chunkDelegationText(text: string, maxBytes = 500): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (current && bytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}
