import { useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  Loader2,
  MessageCircleQuestion,
  OctagonX,
  ShieldQuestion,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { ACTIVE_WORK_STATES, type WorkItem, type WorkItemState } from "@/lib/work";
import { useStore } from "@/state/store";

function stateLabel(state: WorkItemState): string {
  switch (state) {
    case "queued": return "Queued";
    case "running": return "Working";
    case "waiting_approval": return "Approval needed";
    case "waiting_input": return "Needs your answer";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "interrupted_by_restart": return "Interrupted by restart";
  }
}

function StateIcon({ state }: { state: WorkItemState }) {
  if (state === "running") return <Loader2 size={14} className="animate-spin text-accent" />;
  if (state === "queued") return <Clock3 size={14} className="text-ink-secondary" />;
  if (state === "waiting_approval") return <ShieldQuestion size={14} className="text-warning" />;
  if (state === "waiting_input") return <MessageCircleQuestion size={14} className="text-warning" />;
  if (state === "completed") return <CheckCircle2 size={14} className="text-success" />;
  if (state === "cancelled") return <OctagonX size={14} className="text-ink-secondary" />;
  return <CircleAlert size={14} className="text-danger" />;
}

function itemDetail(item: WorkItem): string {
  if (item.requestSummary) return item.requestSummary;
  if (item.currentTool && ACTIVE_WORK_STATES.has(item.state)) return `Tool: ${item.currentTool}`;
  if (item.state === "completed" && item.result) return item.result;
  if ((item.state === "failed" || item.state === "interrupted_by_restart") && item.error) return item.error;
  return item.progress ?? stateLabel(item.state);
}

export function MissionControl() {
  const { state, dispatch } = useStore();
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => state.workItems
    .filter((item) => ACTIVE_WORK_STATES.has(item.state) || !item.seenAt)
    .sort((left, right) => {
      const activeDelta = Number(ACTIVE_WORK_STATES.has(right.state)) - Number(ACTIVE_WORK_STATES.has(left.state));
      return activeDelta || right.updatedAt - left.updatedAt;
    })
    .slice(0, 20), [state.workItems]);
  if (!items.length) return null;

  const active = items.filter((item) => ACTIVE_WORK_STATES.has(item.state));
  const needsYou = items.filter((item) => item.state === "waiting_approval" || item.state === "waiting_input");
  const unseen = items.filter((item) => !ACTIVE_WORK_STATES.has(item.state) && !item.seenAt);

  const openOwner = (item: WorkItem) => {
    const bot = state.bots.find((candidate) => candidate.id === item.targetBotId);
    if (!bot) return;
    dispatch({ type: "select", id: bot.id });
    if (item.threadId && bot.tasks?.some((task) => task.threadId === item.threadId) && bot.threadId !== item.threadId) {
      dispatch({ type: "switchTask", botId: bot.id, threadId: item.threadId });
    }
    if (!ACTIVE_WORK_STATES.has(item.state) && !item.seenAt) dispatch({ type: "markWorkSeen", workItemId: item.id });
  };

  return (
    <section
      aria-label="Mission Control"
      className="fixed bottom-4 left-4 z-30 w-[min(620px,calc(100vw-2rem))] md:left-[276px] md:w-[min(620px,calc(100vw-300px))]"
    >
      {expanded && (
        <div className="mb-2 max-h-[min(460px,60vh)] overflow-hidden rounded-2xl border border-hairline bg-panel/95 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-hairline/50 px-4 py-3">
            <Activity size={16} className="text-accent" />
            <h2 className="text-[13px] font-semibold text-ink">Mission Control</h2>
            <span className="text-[11px] text-ink-secondary">{active.length} active · {needsYou.length} need you</span>
            <button type="button" onClick={() => setExpanded(false)} aria-label="Close Mission Control" className="ml-auto rounded-lg p-1.5 text-ink-secondary hover:bg-raised">
              <X size={15} />
            </button>
          </div>
          <div className="max-h-[min(400px,52vh)] overflow-y-auto p-2">
            {items.map((item) => {
              const bot = state.bots.find((candidate) => candidate.id === item.targetBotId);
              const cancellable = ACTIVE_WORK_STATES.has(item.state) && !item.cancelRequestedAt;
              return (
                <div key={item.id} className="flex items-start gap-2.5 rounded-xl px-2.5 py-2 hover:bg-raised/70">
                  <span className="mt-0.5 shrink-0"><StateIcon state={item.state} /></span>
                  <button type="button" onClick={() => openOwner(item)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-medium text-ink">{bot?.name ?? "Deleted bot"}</span>
                      <span className={cn(
                        "shrink-0 text-[10px] font-medium uppercase tracking-wide",
                        item.state === "failed" || item.state === "interrupted_by_restart" ? "text-danger" :
                          item.state === "waiting_approval" || item.state === "waiting_input" ? "text-warning" :
                            item.state === "completed" ? "text-success" : "text-ink-secondary",
                      )}>{stateLabel(item.state)}</span>
                      <span className="shrink-0 text-[10px] text-ink-secondary/60">{item.origin}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary">{item.objective}</div>
                    <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary/70">{itemDetail(item)}</div>
                  </button>
                  {cancellable && (
                    <button
                      type="button"
                      onClick={() => dispatch({ type: "cancelWork", workItemId: item.id })}
                      aria-label={`Cancel ${item.objective}`}
                      className="mt-0.5 shrink-0 rounded-lg p-1.5 text-danger hover:bg-danger/10"
                    >
                      <OctagonX size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={cn(
          "flex h-11 max-w-full items-center gap-2 rounded-full border border-hairline bg-panel/95 px-3.5 text-[12px] shadow-xl backdrop-blur-xl hover:bg-raised",
          needsYou.length > 0 && "border-warning/50",
        )}
      >
        {active.length ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : <Activity size={14} className="shrink-0 text-success" />}
        <span className="font-medium text-ink">Mission Control</span>
        <span className="truncate text-ink-secondary">
          {needsYou.length ? `${needsYou.length} need you` : active.length ? `${active.length} working` : `${unseen.length} new result${unseen.length === 1 ? "" : "s"}`}
        </span>
        {expanded ? <ChevronDown size={14} className="shrink-0 text-ink-secondary" /> : <ChevronUp size={14} className="shrink-0 text-ink-secondary" />}
      </button>
    </section>
  );
}
