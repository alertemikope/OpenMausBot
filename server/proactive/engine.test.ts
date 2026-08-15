import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProactiveSignal } from "./contracts.ts";
import { ProactiveEngine } from "./engine.ts";
import { inQuietHours } from "./policies.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function signal(overrides: Partial<ProactiveSignal> = {}): ProactiveSignal {
  return {
    source: "work",
    kind: "work.failed",
    entityId: "work-1",
    version: "failed",
    title: "Codex failed",
    body: "Provider unavailable",
    severity: "critical",
    occurredAt: Date.now(),
    ...overrides,
  };
}

describe("controlled proactive engine", () => {
  it("reports only policy and notification counts to runtime health", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const engine = new ProactiveEngine({ file: join(root, "proactive.json") });
    engine.ingest(signal());
    expect(engine.runtimeStatus()).toEqual({ enabled: true, unread: 1, snoozed: 0 });
  });
  it("deduplicates one hundred identical events into one notification", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    let now = new Date(2026, 7, 15, 12, 0).getTime();
    const emitted: unknown[] = [];
    const engine = new ProactiveEngine({ file: join(root, "proactive.json"), now: () => now++, emit: (frame) => emitted.push(frame) });
    for (let index = 0; index < 100; index++) engine.ingest(signal());

    expect(engine.list()).toHaveLength(1);
    expect(engine.list()[0]).toMatchObject({ status: "unread", deduplicatedCount: 99 });
    expect(engine.listReceipts().filter((item) => item.decision === "delivered")).toHaveLength(1);
    expect(emitted.filter((frame) => (frame as { deliver?: boolean }).deliver === true)).toHaveLength(1);
  });

  it("delivers only to the dock during cross-midnight quiet hours", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const at = new Date(2026, 7, 15, 23, 30).getTime();
    const engine = new ProactiveEngine({ file: join(root, "proactive.json"), now: () => at });
    engine.updatePolicy({ channels: ["dock", "system", "voice"], quietHours: { from: "22:00", to: "07:00" } });

    expect(inQuietHours(engine.policy(), at)).toBe(true);
    expect(engine.ingest(signal())?.channels).toEqual(["dock"]);
    expect(engine.list()[0]?.why).toContain("quiet hours");
  });

  it("never selects voice when no live user session can receive it", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const at = new Date(2026, 7, 15, 12, 0).getTime();
    const engine = new ProactiveEngine({ file: join(root, "proactive.json"), now: () => at });
    engine.updatePolicy({ channels: ["dock", "voice"] });

    expect(engine.ingest(signal())?.channels).toEqual(["dock"]);
    expect(engine.list()[0]?.why).toContain("no active voice session");
  });

  it("does not announce a voice-owned delegation twice", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const at = new Date(2026, 7, 15, 12, 0).getTime();
    const engine = new ProactiveEngine({ file: join(root, "proactive.json"), now: () => at, voiceAvailable: () => true });
    engine.updatePolicy({ channels: ["dock", "voice"] });

    const notification = engine.ingest(signal({ voiceEligible: false }))!;
    expect(notification.channels).toEqual(["dock"]);
    expect(notification.why).toContain("already owned by the active delegation");
  });

  it("persists snooze, dismissal and source disabling across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const file = join(root, "proactive.json");
    let now = new Date(2026, 7, 15, 12, 0).getTime();
    const engine = new ProactiveEngine({ file, now: () => now });
    const first = engine.ingest(signal())!;
    engine.snooze(first.id, now + 60_000);
    engine.updatePolicy({ sources: { ...engine.policy().sources, gmail: false } });

    const restored = new ProactiveEngine({ file, now: () => now });
    expect(restored.list()[0]).toMatchObject({ status: "snoozed", snoozedUntil: now + 60_000 });
    expect(restored.ingest(signal({ source: "gmail", entityId: "mail-1", kind: "gmail.urgent" }))).toBeUndefined();
    expect(restored.listReceipts()[0]).toMatchObject({ decision: "suppressed", reason: expect.stringContaining("disabled") });
    expect(new ProactiveEngine({ file, now: () => now }).listReceipts()[0]).toMatchObject({ decision: "suppressed" });
    restored.dismiss(first.id);
    expect(new ProactiveEngine({ file, now: () => now }).list()[0]?.status).toBe("dismissed");
  });

  it("wakes an expired snooze back into the unread dock", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    let now = new Date(2026, 7, 15, 12, 0).getTime();
    const file = join(root, "proactive.json");
    const engine = new ProactiveEngine({ file, now: () => now });
    const notification = engine.ingest(signal())!;
    engine.snooze(notification.id, now + 60_000);
    now += 60_001;

    expect(engine.list()[0]).toMatchObject({ id: notification.id, status: "unread" });
    expect(new ProactiveEngine({ file, now: () => now }).list()[0]).toMatchObject({ status: "unread" });
  });

  it("never creates work or actions and explains every delivery decision", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const engine = new ProactiveEngine({ file: join(root, "proactive.json") });
    const notification = engine.ingest(signal())!;
    expect(notification.why).toContain("Source: work");
    expect(engine.policy().requireConfirmationForActions).toBe(true);
    expect(JSON.stringify(notification)).not.toContain("prompt");
  });

  it("persists do-not-notify for one exact source rule", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-proactive-"));
    roots.push(root);
    const file = join(root, "proactive.json");
    const engine = new ProactiveEngine({ file });
    const first = engine.ingest(signal())!;
    engine.muteRule(first.id);

    const restored = new ProactiveEngine({ file });
    expect(restored.policy().mutedRules).toContain("work:work.failed");
    expect(restored.ingest(signal({ version: "failed-again" }))).toBeUndefined();
    expect(restored.listReceipts()[0]).toMatchObject({ decision: "suppressed", reason: expect.stringContaining("is muted") });
  });
});
