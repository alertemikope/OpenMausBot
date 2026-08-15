import { Brain, X } from "lucide-react";

import { CallMemoryReviewPanel } from "@/components/CallMemoryReview";
import { useStore } from "@/state/store";

export function CallMemoryCard() {
  const { state, dispatch } = useStore();
  const call = state.recentCallReview;
  if (!call) return null;
  return (
    <aside aria-label="Retained from this call" className="fixed right-4 top-16 z-30 max-h-[70vh] w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-hairline bg-panel/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center gap-2 border-b border-hairline/50 px-4 py-3">
        <Brain size={15} className="text-accent" />
        <div>
          <h2 className="text-[12.5px] font-semibold text-ink">Retained from this call</h2>
          <div className="text-[10.5px] text-ink-secondary">Local working notes. Durable memories require your confirmation.</div>
        </div>
        <button type="button" onClick={() => dispatch({ type: "dismissCallReview" })} aria-label="Dismiss call memory review" className="ml-auto rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={14} /></button>
      </div>
      <div className="max-h-[calc(70vh-60px)] overflow-y-auto p-3">
        <CallMemoryReviewPanel call={call} compact onUpdated={(updated) => dispatch({ type: "voiceCallPatched", call: updated })} />
      </div>
    </aside>
  );
}
