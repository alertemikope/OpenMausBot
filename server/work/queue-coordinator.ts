import type { WorkItem } from "./contracts.ts";

type WorkQueuePort = {
  queued(): WorkItem[];
  claim(id: string): boolean;
  failDispatch(id: string, message: string): unknown;
};

export type WorkQueueCoordinatorOptions = {
  work: WorkQueuePort;
  targetState(targetBotId: string): "ready" | "busy" | "missing";
  start(item: WorkItem): Promise<void>;
};

/** Resumes queue-owned work independently of the voice session that created
 * it. Calendar routines are deliberately excluded: RoutineManager owns their
 * schedule, missed-run policy and detached task creation. */
export class WorkQueueCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private readonly options: WorkQueueCoordinatorOptions;

  constructor(options: WorkQueueCoordinatorOptions) {
    this.options = options;
  }

  schedule(delay = 25): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const item of this.options.work.queued()) {
        if (item.origin === "routine") continue;
        const state = this.options.targetState(item.targetBotId);
        if (state === "missing") {
          this.options.work.failDispatch(item.id, "The assigned bot no longer exists");
          continue;
        }
        if (state === "busy" || !this.options.work.claim(item.id)) continue;
        try {
          await this.options.start(item);
        } catch (error) {
          this.options.work.failDispatch(item.id, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
