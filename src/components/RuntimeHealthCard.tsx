import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";

type HealthLevel = "ok" | "warning" | "error" | "disabled";

interface RuntimeHealth {
  status: "ready" | "degraded";
  checkedAt: number;
  uptimeSeconds: number;
  components: {
    providers: { level: HealthLevel; configured: number; loaded: number; unavailable: number };
    work: { level: HealthLevel; active: number; stale: number; cancellationStuck: number };
    routines: { level: HealthLevel; schedulerRunning: boolean; enabled: number; active: number; overdue: number };
    proactivity: { level: HealthLevel; enabled: boolean; unread: number; snoozed: number };
    voice: { level: HealthLevel; active: boolean };
  };
  findings: Array<{ code: string; severity: "warning" | "error"; message: string; action: string }>;
}

function StatusDot({ level }: { level: HealthLevel }) {
  return <span className={cn(
    "size-2 rounded-full",
    level === "error" ? "bg-red-500" : level === "warning" ? "bg-amber-400" : level === "ok" ? "bg-emerald-500" : "bg-ink-secondary/40",
  )} />;
}

function HealthRow({ label, detail, level }: { label: string; detail: string; level: HealthLevel }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-[13px]">
      <StatusDot level={level} />
      <span className="font-medium text-ink">{label}</span>
      <span className="ml-auto text-right text-ink-secondary">{detail}</span>
    </div>
  );
}

export function RuntimeHealthCard() {
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error(`health request failed (${response.status})`);
      setHealth(await response.json() as RuntimeHealth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime health is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const ready = health?.status === "ready";
  const subtitle = error
    ? error
    : health
      ? ready ? "All required runtime owners are healthy." : `${health.findings.length} item${health.findings.length === 1 ? " needs" : "s need"} attention.`
      : "Checking providers, work, routines and local delivery…";

  return (
    <Card title="Runtime health" subtitle={subtitle}>
      <div className="flex flex-col gap-2">
        {health && (
          <>
            <div className={cn(
              "mb-1 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium",
              ready ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
            )}>
              {ready ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              {ready ? "Ready" : "Needs attention"}
              <span className="ml-auto text-[11px] font-normal opacity-75">up {Math.floor(health.uptimeSeconds / 60)}m</span>
            </div>
            <HealthRow
              label="Providers"
              level={health.components.providers.level}
              detail={`${health.components.providers.loaded}/${health.components.providers.configured} loaded`}
            />
            <HealthRow
              label="Work"
              level={health.components.work.level}
              detail={health.components.work.active ? `${health.components.work.active} active · ${health.components.work.stale} stale` : "idle"}
            />
            <HealthRow
              label="Routines"
              level={health.components.routines.level}
              detail={`${health.components.routines.enabled} enabled · ${health.components.routines.overdue} overdue`}
            />
            <HealthRow
              label="Proactivity"
              level={health.components.proactivity.level}
              detail={health.components.proactivity.enabled ? `${health.components.proactivity.unread} unread` : "disabled"}
            />
            <HealthRow
              label="Voice"
              level={health.components.voice.level}
              detail={health.components.voice.active ? "live" : "idle"}
            />
            {health.findings.map((finding) => (
              <div key={finding.code} className="mt-1 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                <div className="text-[12.5px] font-medium text-ink">{finding.message}</div>
                <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{finding.action}</div>
              </div>
            ))}
          </>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          Refresh
        </button>
      </div>
    </Card>
  );
}
