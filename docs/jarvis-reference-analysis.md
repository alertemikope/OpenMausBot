# Jarvis reference repository analysis

Research date: 2026-08-15. The three repositories below were shallow-cloned
cleanly under `/Users/mrsachou/Frameworks`; they are reference-only and were not
modified.

## OpenAssist

- Repository: `https://github.com/manikv12/OpenAssist`
- Local checkout: `/Users/mrsachou/Frameworks/OpenAssist`
- Revision inspected: `a175cfa`

The strongest transferable pattern is that the audio session is not the owner
of background work. `RealtimeTaskCoordinator` keeps separate task identity,
scope, target/worker, progress, result, delivery and timestamps, prevents
duplicate prompts, and caps concurrency (`apps/desktop/electron/realtimeTaskCoordinator.ts:22-58,88-147`).
Its public voice surface separates delegation, authoritative status, explicit
cancellation and navigation instead of hiding every intent behind one generic
tool (`apps/desktop/electron/liveVoice/providerAdapters.ts:43-114`). Results are
kept in a bounded FIFO outbox (`apps/desktop/electron/liveVoice/resultOutbox.ts:15-71`).
Finally, session, turn and background-task state are independent reducer fields,
so closing audio does not erase work (`apps/desktop/electron/liveVoice/state.ts:27-35,49-121`).

Adopted in OpenMausBot:

- call lifetime no longer owns harness task lifetime;
- one active task per bot, with different bots running in parallel;
- explicit `target_id` in the GA Realtime tool plus a bounded bot catalog;
- status/cancel remain target-owned across a later voice session;
- concurrent spoken completions pass through a serialized GA result outbox;
- the Jarvis dock shows every busy bot and opens its conversation.

Not copied: OpenAssist's separate capability registry and alternate Gemini
transport. OpenMausBot already has provider adapters, MCP/plugins, permissions
and GPT-Live/GA transport; replacing those would duplicate the harness.

## OpenYabby

- Repository: `https://github.com/OpenYabby/OpenYabby`
- Local checkout: `/Users/mrsachou/Frameworks/OpenYabby`
- Revision inspected: `5c2dcaf`

OpenYabby persists a queue per agent with source, priority, target, state and
result, then consumes priority-first/FIFO within that agent
(`db/queries/agent-task-queue.js:3-52,55-140`). Its processor prevents two
processors from owning the same agent and deliberately separates raw results,
completion status and voice-friendly summaries
(`lib/agent-task-processor.js:11-25,125-188`). It also delays plan/voice
notifications until the authoritative task exit instead of announcing the same
milestone several times (`routes/plan-reviews.js:69-104`).

Adopted now: same-bot requests queue instead of aborting the running turn;
different bots may run concurrently; task completion is the only final result.
Later persistence can reuse OpenMausBot's existing bot task records rather than
adding PostgreSQL/Redis solely for voice.

## Hermano

- Repository: `https://github.com/brklyngg/hermano`
- Local checkout: `/Users/mrsachou/Frameworks/hermano`
- Revision inspected: `5988f28`

Hermano stores a compact recent-call index and injects only a map into the next
session; full transcript recall is on demand (`voice_memory.py:204-300`). Its
post-call job asynchronously extracts decisions, commitments, open questions,
durable voice learnings and a one-line call summary, never blocking the live
path (`dossier.py:482-547,550-581`).

This is the next memory milestone for Kenpachi: persist committed transcripts
and derived working state, not raw audio, and inject a bounded index instead of
replaying entire calls. It is intentionally after reliable multi-bot ownership;
memory must not be used to paper over ambiguous task identity.

## Resulting OpenMausBot sequence

1. Global non-blocking voice dock and stable WebRTC owner — delivered.
2. Named multi-bot routing, parallel target work, same-target queue, continuity
   after hang-up, authoritative cross-session status, and serialized results —
   implemented and covered by protocol tests.
3. Durable completed-transcript timeline plus compact recent-call map —
   delivered locally without raw audio.
4. Post-call extraction of decisions, commitments and durable preferences —
   next; transcript persistence is now the authoritative input.
5. Fast deterministic capabilities for frequent local reads/actions, while the
   existing harness remains the slow reasoning/action path — later, capability
   by capability with approval tests.
