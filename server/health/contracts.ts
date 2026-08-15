export type RuntimeHealthLevel = "ok" | "warning" | "error" | "disabled";

export type RuntimeHealthFindingCode =
  | "providers.none_loaded"
  | "providers.unavailable"
  | "work.stale"
  | "work.cancellation_stuck"
  | "routines.scheduler_stopped"
  | "routines.overdue";

export interface RuntimeHealthFinding {
  code: RuntimeHealthFindingCode;
  severity: "warning" | "error";
  message: string;
  action: string;
}

export interface RuntimeHealthSnapshot {
  app: "openmausbot";
  pid: number;
  static: boolean;
  status: "ready" | "degraded";
  checkedAt: number;
  uptimeSeconds: number;
  components: {
    providers: { level: RuntimeHealthLevel; configured: number; loaded: number; unavailable: number };
    work: {
      level: RuntimeHealthLevel;
      active: number;
      queued: number;
      waiting: number;
      stale: number;
      cancellationStuck: number;
    };
    routines: {
      level: RuntimeHealthLevel;
      schedulerRunning: boolean;
      enabled: number;
      active: number;
      queued: number;
      overdue: number;
    };
    proactivity: {
      level: RuntimeHealthLevel;
      enabled: boolean;
      unread: number;
      snoozed: number;
    };
    voice: { level: RuntimeHealthLevel; active: boolean };
    integrations: {
      level: RuntimeHealthLevel;
      googleWorkspace: boolean;
      piMemory: boolean;
      composio: boolean;
      pennylane: boolean;
    };
  };
  findings: RuntimeHealthFinding[];
}
