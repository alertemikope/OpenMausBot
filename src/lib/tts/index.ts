// Message playback is deliberately separate from Jarvis calls. Calls use
// ChatGPT Realtime WebRTC; this optional button uses the free operating-system voice
// and never sends text to a hosted TTS endpoint.
export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

const IDLE: SpeechSnapshot = { status: "idle" };

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(snapshot: SpeechSnapshot) => void>();
  private generation = 0;

  subscribe(fn: (snapshot: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  get state(): SpeechSnapshot { return this.snapshot; }

  isSpeaking(messageId?: string): boolean {
    return this.snapshot.status !== "idle" && (!messageId || this.snapshot.messageId === messageId);
  }

  stop(): void {
    this.generation += 1;
    globalThis.speechSynthesis?.cancel();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  async speak(text: string, options: SpeakOptions = {}): Promise<void> {
    this.stop();
    const generation = this.generation;
    const content = text.replaceAll(/```[\s\S]*?```/g, "A code block is shown on screen.").trim().slice(0, 8_000);
    if (!content || !globalThis.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
      this.set({ ...IDLE, error: "System speech is unavailable on this device." });
      return;
    }
    this.set({ status: "preparing", botId: options.botId, messageId: options.messageId });
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = localStorage.getItem("openmaus.realtime.language") ?? "fr-FR";
      const voice = globalThis.speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === options.voiceId);
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (this.generation === generation) {
          this.set({ status: "speaking", botId: options.botId, messageId: options.messageId, caption: content });
        }
      };
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      globalThis.speechSynthesis.speak(utterance);
    });
    if (this.generation === generation) this.set(IDLE);
  }

  private set(next: SpeechSnapshot): void {
    this.snapshot = next;
    for (const watcher of this.watchers) watcher(next);
  }
}

export const speaker = new Speaker();
