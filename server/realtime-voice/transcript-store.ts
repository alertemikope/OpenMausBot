import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

export type VoiceTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

export type VoiceTranscript = {
  version: 1;
  sessionId: string;
  targetId: string;
  startedAt: number;
  endedAt: number;
  summary: string;
  entries: VoiceTranscriptEntry[];
};

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
    mkdirSync(this.directory, { recursive: true });
  }

  save(input: Omit<VoiceTranscript, "version" | "summary">): VoiceTranscript | undefined {
    const entries = input.entries
      .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.trim())
      .slice(-200)
      .map((entry) => ({ ...entry, text: entry.text.replace(/\s+/g, " ").trim().slice(0, 8_000) }));
    if (!entries.length) return undefined;
    const transcript: VoiceTranscript = { ...input, version: 1, summary: summary(entries), entries };
    writeFileAtomic(join(this.directory, `${safeId(input.sessionId)}.json`), JSON.stringify(transcript, null, 2));
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
    return calls.map((call) => `- ${new Date(call.startedAt).toISOString()}: ${call.summary}`).join("\n").slice(0, 1_500);
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
}
