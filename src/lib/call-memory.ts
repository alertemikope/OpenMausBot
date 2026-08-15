export type CallInsight = { id: string; text: string; sourceQuote: string; at: number };

export type CallMemoryCandidate = CallInsight & {
  kind: "fact" | "preference";
  confidence: number;
  status: "pending" | "syncing" | "kept" | "ignored" | "forgotten";
  memoryId?: string;
  syncAction?: "keep" | "correct" | "forget";
  syncError?: string;
};

export type CallMemoryReview = {
  status: "pending" | "complete" | "failed";
  updatedAt: number;
  workingState: {
    decisions: CallInsight[];
    commitments: CallInsight[];
    openQuestions: CallInsight[];
    deadlines: CallInsight[];
  };
  memoryCandidates: CallMemoryCandidate[];
  followUpCandidates: Array<CallInsight & { status: "proposed" | "ignored" }>;
  error?: string;
};

export type VoiceCallHistory = {
  version: 1 | 2;
  sessionId: string;
  targetId: string;
  startedAt: number;
  endedAt: number;
  summary: string;
  entries: Array<{ role: "user" | "assistant"; text: string; at: number }>;
  review?: CallMemoryReview;
};
