import { useState } from "react";
import { Brain, Check, CircleHelp, Clock3, ListChecks, Loader2, Pencil, RotateCcw, Trash2, X } from "lucide-react";

import type { CallInsight, CallMemoryCandidate, VoiceCallHistory } from "@/lib/call-memory";

type Props = {
  call: VoiceCallHistory;
  onUpdated(call: VoiceCallHistory): void;
  compact?: boolean;
};

const groups: Array<{ key: "decisions" | "commitments" | "openQuestions" | "deadlines"; label: string; icon: typeof ListChecks }> = [
  { key: "decisions", label: "Decisions", icon: ListChecks },
  { key: "commitments", label: "Commitments", icon: Check },
  { key: "openQuestions", label: "Open questions", icon: CircleHelp },
  { key: "deadlines", label: "Deadlines", icon: Clock3 },
];

export function CallMemoryReviewPanel({ call, onUpdated, compact = false }: Props) {
  const review = call.review;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!review) return null;
  if (review.status === "pending") {
    return <div className="flex items-center gap-2 py-2 text-[11.5px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Extracting local working notes…</div>;
  }
  if (review.status === "failed") return <div className="py-2 text-[11.5px] text-danger">Working-note extraction failed: {review.error ?? "unknown error"}</div>;

  const mutate = async (candidate: CallMemoryCandidate, action: "keep" | "correct" | "ignore" | "forget") => {
    let text: string | undefined;
    if (action === "correct") {
      text = window.prompt("Correct this memory before saving it:", candidate.text)?.trim();
      if (!text || text === candidate.text && candidate.status !== "kept") return;
    }
    if (action === "forget" && !window.confirm("Forget this confirmed memory? The transcript is not deleted.")) return;
    setBusy(candidate.id);
    setError(undefined);
    try {
      const response = await fetch(`/api/realtime/history/${call.sessionId}/memory-candidates/${candidate.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(text ? { text } : {}) }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Could not update call memory");
      onUpdated(value.call);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const hasWorkingState = groups.some(({ key }) => review.workingState[key].length);
  const visibleMemories = review.memoryCandidates.filter((candidate) => candidate.status !== "ignored" && candidate.status !== "forgotten");
  const hasAnything = hasWorkingState || visibleMemories.length || review.followUpCandidates.some((item) => item.status === "proposed");
  if (!hasAnything) return <div className="py-2 text-[11.5px] text-ink-secondary">Nothing unambiguous was retained from this call.</div>;

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {groups.map(({ key, label, icon: Icon }) => review.workingState[key].length > 0 && (
        <section key={key}>
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-secondary"><Icon size={11} /> {label}</div>
          <div className="mt-1 space-y-1">
            {review.workingState[key].slice(0, compact ? 3 : 8).map((item: CallInsight) => (
              <div key={item.id} className="rounded-lg bg-inset px-2.5 py-1.5 text-[11.5px] text-ink">{item.text}</div>
            ))}
          </div>
        </section>
      ))}

      {visibleMemories.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-secondary"><Brain size={11} /> Memory candidates — confirmation required</div>
          <div className="mt-1 space-y-1.5">
            {visibleMemories.map((candidate) => (
              <div key={candidate.id} className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-2">
                <div className="text-[11.5px] text-ink">{candidate.text}</div>
                <div className="mt-0.5 text-[10px] text-ink-secondary">{candidate.kind} · {Math.round(candidate.confidence * 100)}% · source: “{candidate.sourceQuote}”</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {candidate.status === "syncing" ? (
                    <span className="flex items-center gap-1 px-1.5 py-1 text-[10.5px] text-warning">{candidate.syncError ? <CircleHelp size={11} /> : <Loader2 size={11} className="animate-spin" />} {candidate.syncError ? "Update interrupted — verify Pi Memory" : "Pi Memory update in progress"}</span>
                  ) : candidate.status === "pending" ? (
                    <>
                      <Action icon={Check} label="Keep" disabled={busy === candidate.id} onClick={() => void mutate(candidate, "keep")} />
                      <Action icon={Pencil} label="Correct" disabled={busy === candidate.id} onClick={() => void mutate(candidate, "correct")} />
                      <Action icon={X} label="Ignore" disabled={busy === candidate.id} onClick={() => void mutate(candidate, "ignore")} />
                    </>
                  ) : (
                    <>
                      <span className="flex items-center gap-1 px-1.5 py-1 text-[10.5px] text-success"><Check size={11} /> Confirmed in Pi Memory</span>
                      <Action icon={Pencil} label="Correct" disabled={busy === candidate.id} onClick={() => void mutate(candidate, "correct")} />
                      <Action icon={Trash2} label="Forget" disabled={busy === candidate.id} onClick={() => void mutate(candidate, "forget")} danger />
                    </>
                  )}
                  {busy === candidate.id && <Loader2 size={12} className="m-1 animate-spin text-accent" />}
                </div>
                {candidate.syncError && <div className="mt-1 text-[10px] text-danger">Last sync failed: {candidate.syncError}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {review.followUpCandidates.some((item) => item.status === "proposed") && (
        <section>
          <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-secondary"><RotateCcw size={11} /> Suggested follow-ups — not scheduled</div>
          <div className="mt-1 space-y-1">
            {review.followUpCandidates.filter((item) => item.status === "proposed").slice(0, compact ? 3 : 8).map((item) => (
              <div key={item.id} className="rounded-lg bg-inset px-2.5 py-1.5 text-[11.5px] text-ink">{item.text}</div>
            ))}
          </div>
        </section>
      )}
      {error && <div className="text-[11px] text-danger">{error}</div>}
    </div>
  );
}

function Action({ icon: Icon, label, disabled, onClick, danger = false }: {
  icon: typeof Check;
  label: string;
  disabled: boolean;
  onClick(): void;
  danger?: boolean;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-[10.5px] hover:bg-raised-hover disabled:opacity-50 ${danger ? "text-danger" : "text-ink"}`}>
      <Icon size={11} /> {label}
    </button>
  );
}
