import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import type { CallMemoryReview } from "./call-memory.ts";

export type VoiceTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

export type VoiceTranscript = {
  version: 1 | 2;
  sessionId: string;
  targetId: string;
  startedAt: number;
  endedAt: number;
  summary: string;
  entries: VoiceTranscriptEntry[];
  review?: CallMemoryReview;
};

export type VoiceTranscriptInput = Omit<VoiceTranscript, "version" | "summary" | "review">;

function safeId(value: string): string {
  return value.replace(/[^\w-]/g, "").slice(0, 160);
}

function summary(entries: VoiceTranscriptEntry[]): string {
  const userText = entries.filter((entry) => entry.role === "user").map((entry) => entry.text).join(" ").replace(/\s+/g, " ").trim();
  return userText.length > 180 ? `${userText.slice(0, 177).trimEnd()}…` : userText;
}

export class VoiceTranscriptStore {
  private readonly directory: string;

  constructor(directory = join(DATA_DIR, "voice-calls")) {
    this.directory = directory;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try { chmodSync(this.directory, 0o700); } catch { /* surfaced on actual read/write */ }
    }
    this.recoverInterruptedMemorySyncs();
  }

  save(input: VoiceTranscriptInput): VoiceTranscript | undefined {
    const entries = input.entries
      .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.trim())
      .slice(-200)
      .map((entry) => ({ ...entry, text: entry.text.replace(/\s+/g, " ").trim().slice(0, 8_000) }));
    if (!entries.length) return undefined;
    const transcript: VoiceTranscript = { ...input, version: 2, summary: summary(entries), entries };
    writeFileAtomic(join(this.directory, `${safeId(input.sessionId)}.json`), JSON.stringify(transcript, null, 2));
    this.prune();
    return transcript;
  }

  get(sessionId: string): VoiceTranscript | undefined {
    try {
      return JSON.parse(readFileSync(join(this.directory, `${safeId(sessionId)}.json`), "utf8")) as VoiceTranscript;
    } catch {
      return undefined;
    }
  }

  list(limit = 20): VoiceTranscript[] {
    let files: string[] = [];
    try { files = readdirSync(this.directory).filter((file) => file.endsWith(".json")); } catch { return []; }
    return files
      .map((file) => {
        try { return JSON.parse(readFileSync(join(this.directory, file), "utf8")) as VoiceTranscript; } catch { return undefined; }
      })
      .filter((value): value is VoiceTranscript => Boolean(value?.sessionId && Array.isArray(value.entries)))
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, Math.max(0, Math.min(limit, 100)));
  }

  recentContext(limit = 5): string {
    const calls = this.list(limit).filter((call) => call.summary);
    if (!calls.length) return "";
    return calls.map((call) => {
      const working = call.review?.workingState;
      const context = [
        ...(working?.decisions ?? []).slice(0, 2).map((item) => `decision: ${item.text}`),
        ...(working?.commitments ?? []).slice(0, 2).map((item) => `commitment: ${item.text}`),
        ...(working?.openQuestions ?? []).slice(0, 1).map((item) => `open question: ${item.text}`),
      ].join("; ");
      return `- ${new Date(call.startedAt).toISOString()}: ${call.summary}${context ? ` [${context}]` : ""}`;
    }).join("\n").slice(0, 1_500);
  }

  updateReview(sessionId: string, review: CallMemoryReview): VoiceTranscript | undefined {
    const call = this.get(sessionId);
    if (!call) return undefined;
    const updated: VoiceTranscript = { ...call, version: 2, review };
    writeFileAtomic(join(this.directory, `${safeId(sessionId)}.json`), JSON.stringify(updated, null, 2));
    return updated;
  }

  remove(sessionId: string): boolean {
    const id = safeId(sessionId);
    if (!id) return false;
    try {
      rmSync(join(this.directory, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }

  clear(): number {
    const calls = this.list(100);
    let removed = 0;
    for (const call of calls) if (this.remove(call.sessionId)) removed += 1;
    return removed;
  }

  private prune(maxCalls = 100): void {
    let files: Array<{ file: string; startedAt: number }> = [];
    try {
      files = readdirSync(this.directory)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
          try {
            const call = JSON.parse(readFileSync(join(this.directory, file), "utf8")) as Partial<VoiceTranscript>;
            return { file, startedAt: typeof call.startedAt === "number" ? call.startedAt : 0 };
          } catch {
            return { file, startedAt: 0 };
          }
        });
    } catch {
      return;
    }
    for (const entry of files.sort((left, right) => right.startedAt - left.startedAt).slice(maxCalls)) {
      try { rmSync(join(this.directory, entry.file)); } catch { /* bounded best effort */ }
    }
  }

  private recoverInterruptedMemorySyncs(): void {
    for (const call of this.list(100)) {
      const syncing = call.review?.memoryCandidates.filter((candidate) => candidate.status === "syncing" && !candidate.syncError) ?? [];
      if (!syncing.length || !call.review) continue;
      for (const candidate of syncing) {
        candidate.syncError = "OpenMausBot restarted during this Pi Memory update. Verify canonical memory before retrying.";
      }
      call.review.updatedAt = Date.now();
      writeFileAtomic(join(this.directory, `${safeId(call.sessionId)}.json`), JSON.stringify(call, null, 2));
    }
  }
}
