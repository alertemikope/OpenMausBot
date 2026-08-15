// Which conversation is on a call, window-wide.
//
// It lives in lib rather than inside the call UI because two very
// different places need it: the overlay that renders the call, and the SSE
// fold that decides whether a settled reply should be read aloud. Call
// mode does its own speaking, in order, around its own microphone — so
// auto-speak has to stand down for the bot that is on the line, and the
// two would deadlock over the speaker otherwise.
import { useSyncExternalStore } from "react";

import { initialRealtimeCall, reduceRealtimeCall, type RealtimeCallAction, type RealtimeCallState } from "./realtime-call/state";

type CallRequest = { targetId: string; generation: number; initialText?: string };

let state: RealtimeCallState = initialRealtimeCall;
let request: CallRequest | null = null;
let generation = 0;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of [...watchers]) fn();
}

/** The bot or room on a call, or null. Safe to read outside React. */
export function currentCall(): string | null {
  return "targetId" in state ? (state.targetId ?? null) : null;
}

export function currentCallRequest(): CallRequest | null { return request; }

export function currentCallState(): RealtimeCallState { return state; }

export function updateCall(action: RealtimeCallAction): void {
  const next = reduceRealtimeCall(state, action);
  if (next === state) return;
  state = next;
  notify();
}

export function startCall(targetId: string, options?: { initialText?: string }): boolean {
  // One window owns one physical microphone and one Realtime session. Never
  // replace that owner implicitly: doing so used to unmount the old ChatView
  // controller before its server session had closed, then create a second
  // session and fail with HTTP 409.
  if (currentCall() !== null) return false;
  void window.ogb?.speechStop();
  void window.ogb?.wakeSetCallActive?.(true);
  const nextGeneration = ++generation;
  request = {
    targetId,
    generation: nextGeneration,
    ...(options?.initialText?.trim() ? { initialText: options.initialText.trim() } : {}),
  };
  state = reduceRealtimeCall(state, { type: "authorize", targetId, generation: nextGeneration });
  notify();
  return true;
}

/** End the current call. A targetId makes cleanup ownership-safe: an async
 * teardown from call A cannot hang up a newer call B. */
export function endCall(targetId?: string): boolean {
  const current = currentCall();
  if (targetId && current !== targetId) return false;
  if (current === null) return false;
  request = null;
  state = { type: "idle", generation: ++generation };
  void window.ogb?.speechStop();
  void window.ogb?.wakeSetCallActive?.(false);
  notify();
  return true;
}

/** React StrictMode probes effects with setup -> cleanup -> setup in
 * development. Defer ownership cleanup so that probe can remount first;
 * a genuine unmount remains inactive and releases the call. */
export function deferCallCleanup(targetId: string, isMounted: () => boolean): void {
  queueMicrotask(() => {
    if (!isMounted()) endCall(targetId);
  });
}

export function useOnCall(): string | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    currentCall,
    currentCall,
  );
}

export function useCallState(): RealtimeCallState {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    currentCallState,
    currentCallState,
  );
}
