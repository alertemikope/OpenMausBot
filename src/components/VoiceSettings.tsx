import { useEffect, useState } from "react";
import { Check, Clock3, Loader2, LogIn, LogOut, Phone, Trash2 } from "lucide-react";

import { startCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import type { ChatGptOAuthStatus } from "@/types/ogb";
import type { VoiceCallHistory } from "@/lib/call-memory";
import { CallMemoryReviewPanel } from "@/components/CallMemoryReview";

const VOICES = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];

export function VoiceSettings() {
  const { state, dispatch } = useStore();
  const [oauth, setOauth] = useState<ChatGptOAuthStatus | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState(() => localStorage.getItem("openmaus.realtime.voice") ?? "marin");
  const [language, setLanguage] = useState(() => localStorage.getItem("openmaus.realtime.language") ?? "fr-FR");
  const [microphone, setMicrophone] = useState(() => localStorage.getItem("openmaus.realtime.microphone") ?? "");
  const [output, setOutput] = useState(() => localStorage.getItem("openmaus.realtime.output") ?? "");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [wake, setWake] = useState<WakeWordState | null>(null);
  const [wakePhrase, setWakePhrase] = useState("Salut Kenpachi");
  const [savingWake, setSavingWake] = useState(false);
  const [history, setHistory] = useState<VoiceCallHistory[]>([]);
  const [clearingHistory, setClearingHistory] = useState(false);

  const refreshOauth = async () => {
    const bridge = window.ogb?.chatgptOAuth;
    setOauth(bridge ? await bridge.status() : { authenticated: false, account: "ChatGPT", model: "gpt-live-1-codex", error: "Desktop app required" });
  };

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setDevices(await navigator.mediaDevices.enumerateDevices());
  };

  useEffect(() => {
    void refreshOauth().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    void refreshDevices().catch(() => {});
    void fetch("/api/realtime/history?limit=10")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Voice history unavailable")))
      .then((value: { calls?: VoiceCallHistory[] }) => setHistory(value.calls ?? []))
      .catch(() => {});
    const changed = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", changed);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", changed);
  }, []);

  useEffect(() => {
    const bridge = window.ogb;
    if (!bridge?.wakeGet) return;
    let alive = true;
    void bridge.wakeGet().then((value) => {
      if (!alive) return;
      setWake(value);
      setWakePhrase(value.phrase);
    });
    const off = bridge.onWakeState?.((value) => {
      if (!alive) return;
      setWake(value);
      setWakePhrase(value.phrase);
    });
    return () => { alive = false; off?.(); };
  }, []);

  const oauthAction = async (action: "connect" | "disconnect") => {
    const bridge = window.ogb?.chatgptOAuth;
    if (!bridge) return;
    setOauthBusy(true);
    setError(null);
    try {
      setOauth(await bridge[action]());
      window.dispatchEvent(new Event("openmaus:oauth-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOauthBusy(false);
    }
  };

  const savePreference = (key: string, value: string, setter: (value: string) => void) => {
    setter(value);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  };

  const saveWake = async (patch: { enabled?: boolean; phrase?: string }) => {
    const bridge = window.ogb;
    if (!bridge?.wakeConfigure) return;
    setSavingWake(true);
    setError(null);
    try {
      const value = await bridge.wakeConfigure(patch);
      setWake(value);
      setWakePhrase(value.phrase);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingWake(false);
    }
  };

  const selectedBot = state.bots.find((bot) => bot.id === state.selectedId) ?? state.bots[0];
  const microphones = devices.filter((device) => device.kind === "audioinput");
  const outputs = devices.filter((device) => device.kind === "audiooutput");

  return (
    <div className="space-y-3">
      <section aria-labelledby="voice-settings-heading" className="rounded-xl bg-card p-4">
        <h2 id="voice-settings-heading" className="text-[15px] font-medium text-ink">Jarvis voice</h2>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          Full-duplex ChatGPT Realtime conversation. GPT-Live is preferred when enabled for the account; otherwise the app uses the subscription-backed GA realtime model. OAuth stays encrypted in Electron.
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg bg-inset p-3">
          <div>
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <span className={cn("size-1.5 rounded-full", oauth?.authenticated ? "bg-success" : "bg-raised-hover")} />
              ChatGPT OAuth
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-secondary">
              {oauth?.authenticated ? "Connected · gpt-live-1-codex" : oauth?.error || "Not connected"}
            </div>
          </div>
          <button
            type="button"
            aria-label={oauth?.authenticated ? "Disconnect ChatGPT" : "Connect ChatGPT"}
            onClick={() => void oauthAction(oauth?.authenticated ? "disconnect" : "connect")}
            disabled={oauthBusy || !window.ogb?.chatgptOAuth}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {oauthBusy ? <Loader2 size={13} className="animate-spin" /> : oauth?.authenticated ? <LogOut size={13} /> : <LogIn size={13} />}
            {oauth?.authenticated ? "Disconnect" : "Connect"}
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-[12px] text-ink-secondary">
            Model
            <input value="gpt-live-1-codex" readOnly aria-label="Realtime voice model" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink" />
          </label>
          <label className="text-[12px] text-ink-secondary">
            Voice
            <select value={voice} onChange={(event) => savePreference("openmaus.realtime.voice", event.target.value, setVoice)} aria-label="GPT-Live voice" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink">
              {VOICES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-ink-secondary">
            Primary language
            <select value={language} onChange={(event) => savePreference("openmaus.realtime.language", event.target.value, setLanguage)} aria-label="Primary voice language" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink">
              <option value="fr-FR">Français</option><option value="en-US">English</option>
            </select>
          </label>
          <label className="text-[12px] text-ink-secondary">
            Microphone
            <select value={microphone} onChange={(event) => savePreference("openmaus.realtime.microphone", event.target.value, setMicrophone)} aria-label="Call microphone" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink">
              <option value="">System default</option>
              {microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-ink-secondary">
            Audio output
            <select value={output} onChange={(event) => savePreference("openmaus.realtime.output", event.target.value, setOutput)} aria-label="Call audio output" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink">
              <option value="">System default</option>
              {outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${index + 1}`}</option>)}
            </select>
          </label>
        </div>

        <button
          type="button"
          aria-label="Start a real ChatGPT Realtime test conversation"
          disabled={!oauth?.authenticated || !selectedBot}
          onClick={() => selectedBot && startCall(selectedBot.id)}
          className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white disabled:opacity-50"
        >
          <Phone size={13} /> Test conversation with {selectedBot?.name ?? "selected bot"}
        </button>
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      </section>

      {wake?.available && (
        <section aria-labelledby="wake-word-heading" className="rounded-xl bg-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="wake-word-heading" className="text-[15px] font-medium text-ink">Wake word</h2>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Listen locally, then release the Apple Speech microphone before the realtime call starts. Audio before activation stays on this Mac.
              </div>
            </div>
            <button type="button" role="switch" aria-label="Enable wake word" aria-checked={wake.enabled} onClick={() => void saveWake({ enabled: !wake.enabled, phrase: wakePhrase })} disabled={savingWake} className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", wake.enabled ? "bg-accent" : "bg-raised-hover")}>
              <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-all", wake.enabled ? "left-[22px]" : "left-0.5")} />
            </button>
          </div>
          <div className="mt-4 flex gap-2">
            <input value={wakePhrase} onChange={(event) => setWakePhrase(event.target.value)} onKeyDown={(event) => event.key === "Enter" && wakePhrase.trim() && void saveWake({ phrase: wakePhrase })} maxLength={48} aria-label="Wake phrase" className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink" />
            <button type="button" aria-label="Save wake phrase" onClick={() => void saveWake({ phrase: wakePhrase })} disabled={savingWake || !wakePhrase.trim() || wakePhrase.trim() === wake.phrase} className="flex w-[72px] items-center justify-center gap-1.5 rounded-lg bg-raised text-[13px] text-ink disabled:opacity-50">
              {savingWake ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
            </button>
          </div>
          <div className="mt-2 text-[12px] text-ink-secondary">
            {wake.error ? wake.error : wake.listening ? `Listening for “${wake.phrase}”` : wake.enabled && wake.suspended ? "Paused while realtime voice owns the microphone" : "Off"}
          </div>
        </section>
      )}

      <section aria-labelledby="voice-history-heading" className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock3 size={15} className="text-ink-secondary" />
            <h2 id="voice-history-heading" className="text-[15px] font-medium text-ink">Recent voice calls</h2>
          </div>
          {history.length > 0 && (
            <button
              type="button"
              disabled={clearingHistory}
              onClick={() => {
                if (!window.confirm("Delete all local voice transcripts? Confirmed Pi memories are separate and will not be forgotten.")) return;
                setClearingHistory(true);
                void fetch("/api/realtime/history", { method: "DELETE" })
                  .then((response) => { if (!response.ok) throw new Error("Could not clear voice history"); setHistory([]); dispatch({ type: "dismissCallReview" }); })
                  .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                  .finally(() => setClearingHistory(false));
              }}
              className="rounded-lg px-2.5 py-1 text-[11.5px] text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              {clearingHistory ? "Clearing…" : "Clear history"}
            </button>
          )}
        </div>
        <div className="mt-1 text-[12px] text-ink-secondary">Finalized text stays on this Mac. Raw microphone audio is never stored.</div>
        {history.length ? (
          <div className="mt-3 space-y-2">
            {history.map((call) => {
              const target = state.bots.find((bot) => bot.id === call.targetId)?.name ?? "Jarvis";
              const duration = Math.max(0, Math.round((call.endedAt - call.startedAt) / 1_000));
              return (
                <details key={call.sessionId} className="rounded-lg bg-inset px-3 py-2">
                  <summary className="cursor-pointer list-none text-[12.5px] text-ink">
                    <span className="font-medium">{target}</span>
                    <span className="ml-2 text-ink-secondary">{new Date(call.startedAt).toLocaleString()} · {duration}s</span>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary">{call.summary || "Voice conversation"}</div>
                  </summary>
                  <div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto border-t border-hairline/40 pt-2">
                    {call.entries.map((entry, index) => (
                      <div key={`${entry.at}-${index}`} className="text-[11.5px] leading-relaxed text-ink-secondary">
                        <span className="font-medium text-ink">{entry.role === "user" ? "You" : "Jarvis"}:</span> {entry.text}
                      </div>
                    ))}
                  </div>
                  {call.review && (
                    <div className="mt-2 border-t border-hairline/40 pt-2">
                      <CallMemoryReviewPanel
                        call={call}
                        onUpdated={(updated) => {
                          setHistory((calls) => calls.map((candidate) => candidate.sessionId === updated.sessionId ? updated : candidate));
                          dispatch({ type: "voiceCallPatched", call: updated });
                        }}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm("Delete this local transcript? Confirmed Pi memories are separate and will not be forgotten.")) return;
                      void fetch(`/api/realtime/history/${call.sessionId}`, { method: "DELETE" })
                        .then((response) => {
                          if (!response.ok) throw new Error("Could not delete voice transcript");
                          setHistory((calls) => calls.filter((candidate) => candidate.sessionId !== call.sessionId));
                          if (state.recentCallReview?.sessionId === call.sessionId) dispatch({ type: "dismissCallReview" });
                        })
                        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                    className="mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] text-danger hover:bg-danger/10"
                  >
                    <Trash2 size={11} /> Delete transcript only
                  </button>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="mt-3 rounded-lg bg-inset px-3 py-3 text-[12px] text-ink-secondary">No completed voice call has been recorded yet.</div>
        )}
      </section>
    </div>
  );
}
