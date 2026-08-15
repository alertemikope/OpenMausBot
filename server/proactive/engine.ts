import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import type { ProactiveNotification, ProactivePolicy, ProactiveReceipt, ProactiveSignal } from "./contracts.ts";
import { DEFAULT_PROACTIVE_POLICY, deliveryChannels, normalizePolicy } from "./policies.ts";

type ProactiveFile = {
  version: 1;
  policy: ProactivePolicy;
  notifications: ProactiveNotification[];
  receipts: ProactiveReceipt[];
};

export type ProactiveEngineOptions = {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  voiceAvailable?: () => boolean;
};

export class ProactiveEngine {
  private readonly file: string;
  private readonly now: () => number;
  private readonly emit?: (payload: unknown) => void;
  private readonly voiceAvailable: () => boolean;
  private policyValue: ProactivePolicy = DEFAULT_PROACTIVE_POLICY;
  private notifications: ProactiveNotification[] = [];
  private receipts: ProactiveReceipt[] = [];

  constructor(options: ProactiveEngineOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "proactive.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.voiceAvailable = options.voiceAvailable ?? (() => false);
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ProactiveFile>;
      this.policyValue = normalizePolicy(disk.policy ?? {});
      this.notifications = Array.isArray(disk.notifications) ? disk.notifications.filter((item) => this.validNotification(item)) : [];
      this.receipts = Array.isArray(disk.receipts) ? disk.receipts.filter((item) => Boolean(item?.id && item?.signalKey)) : [];
      chmodSync(this.file, 0o600);
    } catch {
      this.policyValue = normalizePolicy({});
    }
  }

  policy(): ProactivePolicy {
    return structuredClone(this.policyValue);
  }

  updatePolicy(patch: Partial<ProactivePolicy>): ProactivePolicy {
    this.policyValue = normalizePolicy({
      ...this.policyValue,
      ...patch,
      quietHours: { ...this.policyValue.quietHours, ...patch.quietHours },
      sources: { ...this.policyValue.sources, ...patch.sources },
    });
    this.save();
    this.emit?.({ kind: "proactive.policy", policy: this.policy() });
    return this.policy();
  }

  ingest(signal: ProactiveSignal): ProactiveNotification | undefined {
    const at = this.now();
    const signalKey = `${signal.source}:${signal.entityId}:${signal.kind}:${signal.version}`;
    const ruleKey = `${signal.source}:${signal.kind}`.toLowerCase();
    const suppressedReason = !this.policyValue.enabled
      ? "Proactive notifications are disabled"
      : !this.policyValue.sources[signal.source]
        ? `Source ${signal.source} is disabled`
        : this.policyValue.mutedRules.includes(ruleKey)
          ? `Rule ${ruleKey} is muted`
          : undefined;
    if (suppressedReason) {
      this.receipt(signalKey, "suppressed", suppressedReason, []);
      this.save();
      return undefined;
    }

    const dedupeKey = `${signal.source}:${signal.entityId}:${signal.kind}:${signal.version}`;
    const windowStart = at - this.policyValue.dedupeWindowMinutes * 60_000;
    const existing = this.notifications.find((item) => item.dedupeKey === dedupeKey && item.updatedAt >= windowStart);
    if (existing) {
      existing.deduplicatedCount += 1;
      existing.updatedAt = at;
      if (existing.status === "snoozed" && (existing.snoozedUntil ?? 0) <= at) {
        existing.status = "unread";
        existing.snoozedUntil = undefined;
      }
      this.receipt(signalKey, "deduplicated", existing.status === "snoozed" ? "Signal remains snoozed" : "Signal matched an existing notification", existing.channels, existing.id);
      this.persistAndEmit(existing, false);
      return { ...existing, signal: { ...existing.signal } };
    }

    const interruptionsLastHour = this.notifications.filter((item) =>
      item.createdAt >= at - 60 * 60_000 && item.channels.some((channel) => channel === "system" || channel === "voice"),
    ).length;
    const policyDelivery = deliveryChannels(this.policyValue, at, interruptionsLastHour, this.voiceAvailable());
    const delivery = signal.voiceEligible === false && policyDelivery.channels.includes("voice")
      ? {
          channels: policyDelivery.channels.filter((channel) => channel !== "voice"),
          reason: `${policyDelivery.reason}; voice delivery is already owned by the active delegation`,
        }
      : policyDelivery;
    if (!delivery.channels.length) {
      this.receipt(signalKey, "suppressed", delivery.reason, []);
      this.save();
      return undefined;
    }
    const notification: ProactiveNotification = {
      id: randomUUID(),
      dedupeKey,
      signal: { ...signal, title: signal.title.slice(0, 160), body: signal.body.slice(0, 500) },
      status: "unread",
      channels: delivery.channels,
      why: `${delivery.reason}. Source: ${signal.source}; rule: ${signal.kind}.`,
      createdAt: at,
      updatedAt: at,
      deduplicatedCount: 0,
    };
    this.notifications.unshift(notification);
    this.trim();
    this.receipt(signalKey, "delivered", delivery.reason, delivery.channels, notification.id);
    this.persistAndEmit(notification, true);
    return { ...notification, signal: { ...notification.signal } };
  }

  list(limit = 200): ProactiveNotification[] {
    this.wakeExpiredSnoozes();
    return this.notifications.slice(0, Math.max(1, Math.min(1_000, limit))).map((item) => ({ ...item, signal: { ...item.signal } }));
  }

  listReceipts(limit = 200): ProactiveReceipt[] {
    return this.receipts.slice(0, Math.max(1, Math.min(1_000, limit))).map((item) => ({ ...item, channels: [...item.channels] }));
  }

  markSeen(id: string): ProactiveNotification | undefined {
    return this.patch(id, (item, at) => { item.status = "seen"; item.seenAt = at; });
  }

  dismiss(id: string): ProactiveNotification | undefined {
    return this.patch(id, (item, at) => { item.status = "dismissed"; item.dismissedAt = at; });
  }

  snooze(id: string, until: number): ProactiveNotification | undefined {
    if (!Number.isFinite(until) || until <= this.now()) throw new Error("Choose a future snooze time");
    return this.patch(id, (item) => { item.status = "snoozed"; item.snoozedUntil = until; });
  }

  muteRule(id: string): ProactiveNotification | undefined {
    const item = this.notifications.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    const rule = `${item.signal.source}:${item.signal.kind}`.toLowerCase();
    this.updatePolicy({ mutedRules: [...this.policyValue.mutedRules, rule] });
    return this.dismiss(id);
  }

  private patch(id: string, mutate: (item: ProactiveNotification, at: number) => void): ProactiveNotification | undefined {
    const item = this.notifications.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    const at = this.now();
    mutate(item, at);
    item.updatedAt = at;
    this.persistAndEmit(item, false);
    return { ...item, signal: { ...item.signal } };
  }

  private wakeExpiredSnoozes(): void {
    const at = this.now();
    let changed = false;
    for (const item of this.notifications) {
      if (item.status !== "snoozed" || (item.snoozedUntil ?? Number.POSITIVE_INFINITY) > at) continue;
      item.status = "unread";
      item.snoozedUntil = undefined;
      item.updatedAt = at;
      changed = true;
      this.emit?.({ kind: "proactive.notification", notification: { ...item, signal: { ...item.signal } }, deliver: false });
    }
    if (changed) this.save();
  }

  private receipt(signalKey: string, decision: ProactiveReceipt["decision"], reason: string, channels: ProactiveReceipt["channels"], notificationId?: string): void {
    this.receipts.unshift({
      id: randomUUID(),
      signalKey,
      decision,
      reason,
      channels: [...channels],
      createdAt: this.now(),
      ...(notificationId ? { notificationId } : {}),
    });
    this.trim();
  }

  private persistAndEmit(item: ProactiveNotification, deliver: boolean): void {
    this.save();
    this.emit?.({ kind: "proactive.notification", notification: { ...item, signal: { ...item.signal } }, deliver });
  }

  private trim(): void {
    this.notifications = this.notifications.slice(0, 2_000);
    this.receipts = this.receipts.slice(0, 4_000);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({
      version: 1,
      policy: this.policyValue,
      notifications: this.notifications,
      receipts: this.receipts,
    } satisfies ProactiveFile, null, 2), 0o600);
  }

  private validNotification(value: unknown): value is ProactiveNotification {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<ProactiveNotification>;
    return typeof item.id === "string" && typeof item.dedupeKey === "string" && typeof item.createdAt === "number" && Boolean(item.signal?.source);
  }
}
