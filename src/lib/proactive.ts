export type ProactiveSource = "work" | "routine" | "calendar" | "gmail" | "pennylane" | "ci";
export type ProactiveChannel = "dock" | "system" | "voice";
export type ProactiveSeverity = "info" | "warning" | "critical";
export type ProactiveNotificationStatus = "unread" | "seen" | "snoozed" | "dismissed";

export interface ProactiveSignal {
  source: ProactiveSource;
  kind: string;
  entityId: string;
  version: string;
  title: string;
  body: string;
  severity: ProactiveSeverity;
  occurredAt: number;
  targetBotId?: string;
  workItemId?: string;
  sourceUrl?: string;
  voiceEligible?: boolean;
}

export interface ProactiveNotification {
  id: string;
  dedupeKey: string;
  signal: ProactiveSignal;
  status: ProactiveNotificationStatus;
  channels: ProactiveChannel[];
  why: string;
  createdAt: number;
  updatedAt: number;
  snoozedUntil?: number;
  seenAt?: number;
  dismissedAt?: number;
  deduplicatedCount: number;
}

export interface ProactivePolicy {
  enabled: boolean;
  quietHours: { from: string; to: string };
  vipSenders: string[];
  mutedRules: string[];
  channels: ProactiveChannel[];
  maxInterruptionsPerHour: number;
  dedupeWindowMinutes: number;
  requireConfirmationForActions: true;
  sources: Record<ProactiveSource, boolean>;
}
