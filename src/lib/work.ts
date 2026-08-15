export type WorkOrigin = "chat" | "voice" | "routine" | "peer" | "proactive";

export type WorkItemState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted_by_restart";

export interface WorkItem {
  id: string;
  origin: WorkOrigin;
  targetBotId: string;
  threadId?: string;
  parentId?: string;
  sourceId?: string;
  voiceSessionId?: string;
  objective: string;
  state: WorkItemState;
  priority: number;
  progress?: string;
  currentTool?: string;
  providerInstanceId?: string;
  turnId?: string;
  requestId?: string;
  requestSummary?: string;
  result?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  scheduledFor?: number;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  seenAt?: number;
}

export const ACTIVE_WORK_STATES = new Set<WorkItemState>([
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
]);

