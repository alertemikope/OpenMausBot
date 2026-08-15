import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Captions, ChevronDown, ChevronUp, Loader2, Mic, MicOff, Phone, PhoneOff, VolumeX, X } from "lucide-react";

import { track } from "@/lib/analytics";
import {
  currentCallRequest,
  endCall,
  startCall,
  updateCall,
  useCallState,
  useOnCall,
} from "@/lib/call";
import { cn } from "@/lib/cn";
import { RealtimeCallController } from "@/lib/realtime-call/controller";
import { voiceNavigationTarget } from "@/lib/voice-navigation";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { pendingApprovals } from "./PendingApproval";

const VOICES = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];

function voicePreference(): string {
  const value = localStorage.getItem("openmaus.realtime.voice") ?? "marin";
  return VOICES.includes(value) ? value : "marin";
}

function languagePreference(): string {
  return (localStorage.getItem("openmaus.realtime.language") ?? "fr-FR").slice(0, 32);
}

function microphonePreference(): string | undefined {
  return localStorage.getItem("openmaus.realtime.microphone") || undefined;
}

export function CallButton({ bot }: { bot: Bot }) {
  return (
    <CallTargetButton
      targetId={bot.id}
      targetName={bot.name}
      voices={[bot.voice]}
      onStart={() => track("call_started", { driver: bot.modelSelection?.instanceId, engine: "gpt-live" })}
    />
  );
}

export function CallTargetButton({
  targetId,
  targetName,
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  onStart: () => void;
}) {
  const { dispatch } = useStore();
  const activeTarget = useOnCall();
  const active = activeTarget === targetId;
  const busyElsewhere = activeTarget !== null && !active;
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();

  useEffect(() => {
    let alive = true;
    const bridge = window.ogb?.chatgptOAuth;
    if (!bridge) {
      setAuthenticated(false);
      return;
    }
    void bridge.status().then((status) => alive && setAuthenticated(status.authenticated)).catch(() => alive && setAuthenticated(false));
    const refresh = () => void bridge.status().then((status) => alive && setAuthenticated(status.authenticated));
    window.addEventListener("openmaus:oauth-changed", refresh);
    return () => {
      alive = false;
      window.removeEventListener("openmaus:oauth-changed", refresh);
    };
  }, []);

  const unavailable = !active && !busyElsewhere && authenticated !== true;
  const label = active
    ? `Hang up on ${targetName}`
    : busyElsewhere
      ? "Show the bot owning the active Jarvis call"
    : authenticated === null
      ? "Checking ChatGPT voice availability"
      : authenticated
        ? `Call ${targetName}`
        : "Connect ChatGPT in Voice settings to make calls";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          if (active) return endCall(targetId);
          if (busyElsewhere && activeTarget) return dispatch({ type: "select", id: activeTarget });
          if (unavailable) return setHelpOpen((open) => !open);
          if (startCall(targetId)) onStart();
        }}
        aria-label={label}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        title={label}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-full transition-colors",
          active
            ? "bg-danger text-white"
            : busyElsewhere
              ? "text-accent hover:bg-raised"
              : unavailable
                ? "text-ink-secondary/50 hover:bg-raised"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        {active ? <PhoneOff size={17} /> : <Phone size={17} />}
        {unavailable && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />}
      </button>
      {unavailable && helpOpen && (
        <div id={helpId} role="group" aria-label="Call unavailable" className="absolute right-0 z-30 mt-1.5 w-[280px] rounded-xl border border-hairline bg-panel p-3 shadow-2xl">
          <div className="text-[13px] font-medium text-ink">ChatGPT voice is not connected</div>
          <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            Realtime calls use your ChatGPT subscription through encrypted OAuth. No OpenAI API key or ElevenLabs account is used.
          </div>
          <button
            type="button"
            onClick={() => {
              setHelpOpen(false);
              dispatch({ type: "toggleAppSettings", open: true, section: "voice" });
            }}
            className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white"
          >
            Open Voice settings
          </button>
        </div>
      )}
    </div>
  );
}

export function CallOverlay({ bot }: { bot?: Bot }) {
  const active = useOnCall();
  return bot && active === bot.id ? <RealtimeCall bot={bot} /> : null;
}

function RealtimeCall({ bot }: { bot: Bot }) {
  const { state: storeState, dispatch } = useStore();
  const state = useCallState();
  const request = currentCallRequest();
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<RealtimeCallController | null>(null);
  const alive = useRef(true);
  const fallbackSent = useRef(false);
  const botsRef = useRef(storeState.bots);
  botsRef.current = storeState.bots;
  const [muted, setMuted] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [userCaption, setUserCaption] = useState("");
  const [assistantCaption, setAssistantCaption] = useState("");

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const activeAgents = storeState.bots.flatMap((candidate) => {
    const candidateMessages = visibleMessages(candidate);
    const candidateApproval = pendingApprovals(candidateMessages)[0];
    let lastUserIndex = -1;
    for (let index = candidateMessages.length - 1; index >= 0; index -= 1) {
      if (candidateMessages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const tool = candidateMessages
      .slice(lastUserIndex + 1)
      .reverse()
      .find((message) => message.kind === "activity" && message.tool)?.tool?.name;
    return candidate.busy || candidateApproval
      ? [{ bot: candidate, approval: candidateApproval, tool }]
      : [];
  });

  useEffect(() => {
    alive.current = true;
    if (!request || request.targetId !== bot.id || !audioRef.current) return;
    if (!controllerRef.current) {
      const outputId = localStorage.getItem("openmaus.realtime.output");
      const audioWithSink = audioRef.current as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
      if (outputId && audioWithSink.setSinkId) void audioWithSink.setSinkId(outputId).catch(() => {});
      const controller = new RealtimeCallController({
        targetId: bot.id,
        generation: request.generation,
        audio: audioRef.current,
        voice: VOICES.includes(bot.voice ?? "") ? bot.voice : voicePreference(),
        language: languagePreference(),
        initialText: request.initialText,
        deviceId: microphonePreference(),
        onState: updateCall,
        onCaption: (role, text, done) => {
          if (role === "user") setUserCaption(text);
          else setAssistantCaption(text);
          if (role === "user" && done) {
            const targetId = voiceNavigationTarget(text, botsRef.current);
            if (targetId) dispatch({ type: "select", id: targetId });
          }
        },
        onInitialFallback: (text) => {
          if (fallbackSent.current) return;
          fallbackSent.current = true;
          dispatch({ type: "send", botId: bot.id, text });
        },
      });
      controllerRef.current = controller;
      void controller.start();
    }
    return () => {
      alive.current = false;
      queueMicrotask(() => {
        if (alive.current) return;
        const controller = controllerRef.current;
        controllerRef.current = null;
        void controller?.close();
      });
    };
  }, [bot.id, bot.voice, dispatch, request]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Chat, search and composer remain fully usable during a global call.
      // The Space shortcut only applies when no interactive element owns it.
      if (event.code === "Space" && event.target === document.body && state.type === "live" && state.phase === "speaking") {
        event.preventDefault();
        controllerRef.current?.interruptVoice();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, state]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    controllerRef.current?.setMuted(next);
  }, [muted]);

  const phase = state.type === "live"
    ? approval
      ? "awaiting-approval"
      : bot.busy && state.phase === "listening"
        ? "working"
        : state.phase
    : state.type;
  const status: Record<string, string> = {
    authorizing: "Authorizing",
    connecting: "Connecting",
    listening: "Listening",
    hearing: "Hearing you",
    speaking: "Speaking",
    working: "Working",
    "awaiting-approval": "Awaiting approval",
    reconnecting: "Reconnecting",
    muted: "Muted",
    failed: "Failed",
  };
  const caption = phase === "hearing" ? userCaption : assistantCaption;

  return (
    <section
      className="fixed bottom-5 right-5 z-40 w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-hairline bg-panel/95 p-4 shadow-2xl backdrop-blur-xl"
      aria-label={`Jarvis call with ${bot.name}`}
    >
      <audio ref={audioRef} autoPlay aria-hidden="true" />
      <div className="flex items-center gap-3">
        <MausAvatar color={bot.color} state={phase === "listening" || phase === "hearing" ? "listening" : phase === "speaking" ? "sending" : "working"} size={54} animated />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium text-ink">Jarvis · {bot.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-secondary" aria-live="polite">
          {["authorizing", "connecting", "working", "reconnecting"].includes(phase) && <Loader2 size={13} className="animate-spin" />}
          {status[phase] ?? "Jarvis"}
            <span aria-hidden="true">·</span>
            <span className={state.type === "live" && !muted ? "text-success" : ""}>{muted ? "Mic off" : state.type === "live" ? "Mic on" : "Mic idle"}</span>
          </div>
        </div>
        <button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "Expand Jarvis controls" : "Minimize Jarvis controls"} className="rounded-lg p-2 text-ink-secondary hover:bg-raised">
          {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <button type="button" onClick={() => endCall(bot.id)} aria-label="Hang up" className="rounded-lg p-2 text-danger hover:bg-danger/10">
          <X size={17} />
        </button>
      </div>

      {!minimized && <>
      {(state.type === "live" || state.type === "reconnecting") && state.model && (
        <div className="mt-2 text-[10.5px] text-ink-secondary/70" aria-label="Realtime transport">
          {state.transport === "gpt-live" ? "GPT-Live" : "ChatGPT subscription fallback"}
          {` · ${state.model}`}
          {typeof state.latencyMs === "number" ? ` · ${state.latencyMs} ms` : ""}
        </div>
      )}

      <div className="mt-3 max-h-28 min-h-12 overflow-y-auto rounded-xl bg-app/55 px-3 py-2 text-[13px] leading-relaxed text-ink" aria-live="polite">
        {state.type === "failed" ? (
          <span className="text-danger">{state.message}</span>
        ) : captions && caption ? (
          caption
        ) : (
          <span className="text-ink-secondary">{muted ? "Microphone muted" : "Speak naturally — you can interrupt the voice at any time."}</span>
        )}
      </div>

      {activeAgents.length > 0 && (
        <div className="mt-3 space-y-1.5" aria-label="Active Jarvis agent work">
          {activeAgents.map(({ bot: activeBot, approval: activeApproval, tool }) => (
            <div key={activeBot.id} className="flex items-center gap-2 rounded-xl bg-raised px-3 py-1.5 text-[11.5px] text-ink-secondary">
              <Loader2 size={11} className="shrink-0 animate-spin" />
              <button type="button" onClick={() => dispatch({ type: "select", id: activeBot.id })} className="shrink-0 font-medium text-ink hover:text-accent">
                {activeBot.name}
              </button>
              <span className="min-w-0 flex-1 truncate">{activeApproval ? `Approval: ${activeApproval.detail}` : tool ? `Tool: ${tool}` : "Working"}</span>
              {activeApproval && (
                <button
                  type="button"
                  aria-label={`Deny ${activeBot.name} pending approval`}
                  onClick={() => dispatch({
                    type: "decideRequest",
                    threadId: activeBot.threadId,
                    requestId: activeApproval.requestId,
                    behavior: "deny",
                    message: "Denied by the user from the Jarvis dock.",
                  })}
                  className="rounded-full border border-danger/40 px-2 py-0.5 text-danger hover:bg-danger/10"
                >
                  Deny
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute microphone" : "Mute microphone"} className="flex items-center gap-1.5 rounded-full border border-hairline/50 px-3 py-1.5 text-[12px] text-ink hover:bg-raised">
          {muted ? <MicOff size={15} /> : <Mic size={15} />} {muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" onClick={() => controllerRef.current?.interruptVoice()} aria-label="Interrupt Jarvis voice only" className="flex items-center gap-1.5 rounded-full border border-hairline/50 px-3 py-1.5 text-[12px] text-ink hover:bg-raised">
          <VolumeX size={15} /> Stop voice
        </button>
        <button type="button" onClick={() => setCaptions((value) => !value)} aria-label={captions ? "Hide captions" : "Show captions"} aria-pressed={captions} className="flex items-center gap-1.5 rounded-full border border-hairline/50 px-3 py-1.5 text-[12px] text-ink hover:bg-raised">
          <Captions size={15} /> Captions
        </button>
        <button type="button" onClick={() => endCall(bot.id)} aria-label="Hang up call" className="ml-auto flex items-center gap-1.5 rounded-full bg-danger px-3 py-1.5 text-[12px] font-medium text-white">
          <PhoneOff size={16} /> Hang up
        </button>
      </div>
      <div className="mt-2 text-[10.5px] text-ink-secondary/60">Chat stays available · “Demande à Codex…” routes work · “Planifie chaque jour…” creates an autonomous routine</div>
      </>}
    </section>
  );
}
