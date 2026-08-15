export type ProactiveSource = "work" | "routine" | "calendar" | "gmail" | "pennylane" | "ci";
export type ProactiveChannel = "dock" | "system" | "voice";
export type ProactiveSeverity = "info" | "warning" | "critical";

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
  /** False when another live voice path already owns delivery of this result. */
  voiceEligible?: boolean;
}

export type ProactiveNotificationStatus = "unread" | "seen" | "snoozed" | "dismissed";

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

export interface ProactiveReceipt {
  id: string;
  signalKey: string;
  notificationId?: string;
  decision: "delivered" | "suppressed" | "deduplicated";
  reason: string;
  channels: ProactiveChannel[];
  createdAt: number;
}

export interface ProactiveRuntimeStatus {
  enabled: boolean;
  unread: number;
  snoozed: number;
}
