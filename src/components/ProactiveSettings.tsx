import { BellRing, Moon, Volume2 } from "lucide-react";

import type { ProactiveChannel, ProactiveSource } from "@/lib/proactive";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const SOURCES: Array<{ id: ProactiveSource; label: string; detail: string }> = [
  { id: "work", label: "Agent tasks", detail: "Completed, failed, blocked or awaiting you" },
  { id: "routine", label: "Routines", detail: "Scheduled work completed or failed" },
  { id: "calendar", label: "Calendar", detail: "Upcoming or changed meetings (connector phase)" },
  { id: "gmail", label: "Urgent email", detail: "Explicit urgency and VIP senders (connector phase)" },
  { id: "pennylane", label: "Pennylane", detail: "Bounded accounting anomalies (connector phase)" },
  { id: "ci", label: "CI / builds", detail: "Monitored project failures (connector phase)" },
];

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange(): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-raised")}
    >
      <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", checked ? "left-[21px]" : "left-[3px]")} />
    </button>
  );
}

export function ProactiveSettings() {
  const { state, dispatch } = useStore();
  const policy = state.proactivePolicy;
  if (!policy) return <div className="text-[13px] text-ink-secondary">Loading proactive policy…</div>;
  const patch = (value: Parameters<typeof dispatch>[0] & { type: "updateProactivePolicy" }) => dispatch(value);
  const toggleChannel = (channel: ProactiveChannel) => {
    const channels = policy.channels.includes(channel)
      ? policy.channels.filter((item) => item !== channel)
      : [...policy.channels, channel];
    patch({ type: "updateProactivePolicy", patch: { channels } });
  };
  const toggleSystemNotifications = () => {
    if (policy.channels.includes("system") || typeof Notification === "undefined" || Notification.permission === "granted") {
      toggleChannel("system");
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") toggleChannel("system");
    });
  };

  return (
    <>
      <Card title="Controlled proactivity" subtitle="Kenpachi observes and notifies. It never turns a signal into an action without an explicit routine or confirmation.">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BellRing size={17} className="text-accent" />
            <span className="text-[14px] text-ink">Enable proactive signals</span>
          </div>
          <Toggle checked={policy.enabled} label="Enable proactive signals" onChange={() => patch({ type: "updateProactivePolicy", patch: { enabled: !policy.enabled } })} />
        </div>
      </Card>

      <Card title="Quiet hours" subtitle="Mission Control still keeps a silent receipt. System and voice interruptions stop during this window.">
        <div className="flex items-center gap-3">
          <Moon size={17} className="text-ink-secondary" />
          <input
            type="time"
            value={policy.quietHours.from}
            onChange={(event) => patch({ type: "updateProactivePolicy", patch: { quietHours: { ...policy.quietHours, from: event.target.value } } })}
            className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink"
            aria-label="Quiet hours start"
          />
          <span className="text-[13px] text-ink-secondary">to</span>
          <input
            type="time"
            value={policy.quietHours.to}
            onChange={(event) => patch({ type: "updateProactivePolicy", patch: { quietHours: { ...policy.quietHours, to: event.target.value } } })}
            className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink"
            aria-label="Quiet hours end"
          />
        </div>
      </Card>

      <Card title="Channels" subtitle="Mission Control is always the durable fallback. Voice is used only when a live call can receive it.">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div><div className="text-[14px] text-ink">System notifications</div><div className="text-[12px] text-ink-secondary">Outside quiet hours and within the hourly limit</div></div>
            <Toggle checked={policy.channels.includes("system")} label="System notifications" onChange={toggleSystemNotifications} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2"><Volume2 size={15} className="text-ink-secondary" /><div><div className="text-[14px] text-ink">Voice interruption</div><div className="text-[12px] text-ink-secondary">Only while you are present in a call</div></div></div>
            <Toggle checked={policy.channels.includes("voice")} label="Voice proactive notifications" onChange={() => toggleChannel("voice")} />
          </div>
        </div>
      </Card>

      <Card title="Sources" subtitle="Disabled connector sources are not polled and cannot create notifications.">
        <div className="flex flex-col divide-y divide-hairline/40">
          {SOURCES.map((source) => (
            <div key={source.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div><div className="text-[14px] text-ink">{source.label}</div><div className="text-[12px] text-ink-secondary">{source.detail}</div></div>
              <Toggle
                checked={policy.sources[source.id]}
                label={`Enable ${source.label}`}
                onChange={() => patch({ type: "updateProactivePolicy", patch: { sources: { ...policy.sources, [source.id]: !policy.sources[source.id] } } })}
              />
            </div>
          ))}
        </div>
      </Card>

      {policy.mutedRules.length > 0 && (
        <Card title="Muted rules" subtitle={`${policy.mutedRules.length} exact signal rule${policy.mutedRules.length === 1 ? " is" : "s are"} muted.`}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 truncate text-[12px] text-ink-secondary">{policy.mutedRules.join(", ")}</div>
            <button
              type="button"
              onClick={() => patch({ type: "updateProactivePolicy", patch: { mutedRules: [] } })}
              className="shrink-0 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised"
            >
              Clear all
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
