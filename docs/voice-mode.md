# Jarvis realtime voice

Decision doc, updated 2026-08-15. OpenMausBot calls are full-duplex WebRTC
sessions through ChatGPT OAuth. They prefer `gpt-live-1-codex`; accounts for
which GPT-Live is not enabled automatically use `gpt-realtime-2.1` on the same
subscription OAuth profile, never a paid Platform-key fallback.

OpenClaw issue [#104683](https://github.com/openclaw/openclaw/issues/104683)
documents the same provider boundary: GPT-Live requires WebRTC and an
early-access entitlement, while GA Realtime remains available when that gate
returns `Voice session access denied`. GPT-Live receives no `server_vad`
configuration; only the GA fallback does.

## Ownership

```text
Kenpachi (local Apple Speech, macOS only)
  -> renderer WebRTC audio + oai-events data channel
  -> harness /api/realtime broker
  -> api.openai.com/v1/live + authenticated sideband (preferred)
     or /v1/realtime/calls?model=gpt-realtime-2.1 (subscription fallback)
  -> selected bot through sideband or the credential-free local event bridge
  -> selected OpenMaus bot through the normal startTurn owner
```

GPT-Live is the conversational surface, not the agent. It receives no MCP or
computer tools. A `delegation.created` event is executed by the selected bot
through its existing thread, model, persona, approvals, Gmail/Drive,
Pennylane, Pi Memory, CUA and `ask_bot` integrations. The result returns on a
bounded `speakable` channel; tool progress returns as silent `commentary`.

## OAuth and secrets

Voice settings starts Authorization Code + PKCE against `auth.openai.com`.
The callback binds to `localhost:1455`. Electron encrypts the profile with
`safeStorage` in a user-private file and refreshes it before expiry.

The harness requests a temporary access token through Electron's private
utility-process message channel. React sees only:

```json
{ "authenticated": true, "account": "ChatGPT", "model": "gpt-live-1-codex" }
```

The browser receives a random 256-bit, one-shot offer token. The ChatGPT bearer
is never returned by HTTP, placed in SDP, logged, or appended to a URL. There
is no OpenAI Platform-key path and no silent paid fallback.

## Session broker

`POST /api/realtime/sessions` reserves one 30-minute window session. Its offer
credential expires after 60 seconds. `POST /api/realtime/offers` accepts a
bounded audio + `oai-events` SDP and consumes the credential before network
work. It first creates the multipart call at `api.openai.com/v1/live`. A 403
from that feature-gated model is the only condition that activates the raw-SDP
`/v1/realtime/calls?model=gpt-realtime-2.1` fallback; both use the same ChatGPT
OAuth bearer and `chatgpt-account-id`.

GPT-Live keeps OAuth and delegation on the authenticated server sideband at
`wss://api.openai.com/v1/live/<callId>`. GA Realtime carries an
`agent_consult` function call over `oai-events`; the renderer relays bounded
events over loopback HTTP and receives tool outputs over a session-owned SSE
stream. `DELETE /api/realtime/sessions/:id` aborts setup, delegations, event
transport and media ownership.

The broker enforces loopback origins, one active window session, closed model
and voice lists, bounded SDP/provider errors/events/transcripts and results,
generation fencing and deterministic shutdown.

## Full-duplex behavior

Chromium captures the microphone with echo cancellation, noise suppression and
automatic gain control. The microphone remains open while GPT-Live speaks.
Provider turn detection handles normal barge-in. The **Stop voice** control
sends `response.cancel`; it never interrupts agent work.

The distinct spoken controls are:

- status: reports the real current tool, progress, duration or pending approval;
- cancel: calls the provider's `interruptTurn`;
- steer: uses a native primitive when available (Codex `turn/steer`); unsupported
  engines say so without cancel/restart;
- follow-up: waits for completion, then runs in the same bot thread.

On the GA fallback, `agent_consult` carries an explicit `mode` enum so model
paraphrasing cannot turn status into replacement work. GPT-Live uses an
explicit control envelope in delegated text. Codex steering sends both the
provider thread id and exact `expectedTurnId`. A cancellation resolves the
original task call and the cancel-control call together before creating one
new voice response; queued follow-ups remain pending until their real harness
turn completes.

## Confirmations

Sensitive permission events are held by a server-side confirmation controller.
Authority is bound to the exact `requestId`, thread, summary and expiry, is
single-use, and is cleared on hang-up. Only a closed French/English grammar
such as “Oui, je confirme” or “No, I deny” resolves it. Containment checks such
as finding `oui` inside a longer sentence are forbidden and ambiguous answers
cause the exact question to be repeated.

## Kenpachi handoff

The wake listener stays entirely local until it captures a wake phrase and
first command. It then releases Apple Speech before WebRTC starts. That command
is inserted once as GPT-Live initial context. If connection fails before the
call becomes live, it is sent once through normal text chat, with no voice or
paid fallback. Hang-up rearms the listener.

Rooms do not expose a call button: one voice must have one turn/approval owner.
Call a Chief of Staff bot and let its existing `ask_bot` tools coordinate the
team instead of opening simultaneous speaking sessions.

## Message playback

The optional **Read aloud** button is separate from Jarvis. It uses the free
operating-system `speechSynthesis` voice. The retired ElevenLabs key, routes,
server implementation and billing copy were removed; startup deletes any
dormant legacy `tts` credential from OpenMausBot's canonical config file.
