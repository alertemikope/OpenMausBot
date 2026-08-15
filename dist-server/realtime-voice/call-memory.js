import { createHash } from "node:crypto";
const EMPTY_WORKING_STATE = {
    decisions: [],
    commitments: [],
    openQuestions: [],
    deadlines: [],
};
const ambiguityPattern = /\b(?:peut[- ]être|probablement|éventuellement|maybe|perhaps|possibly)\b/iu;
const sensitivePattern = /\b(?:mot de passe|password|secret|token|api[ _-]?key|clé privée|private key|cvv|carte bancaire)\b|\b\d{13,19}\b/iu;
const decisionPattern = /\b(?:on|nous)\s+(?:a(?:vons)?\s+)?décid|\bdécision\s*:|\bwe(?:'ve| have)? decided\b|\bdecision\s*:/iu;
const commitmentPattern = /\b(?:je vais|j['’]irai|on va|nous allons|i will|i['’]ll|we will)\b/iu;
const questionPattern = /\?$|^(?:qui|que|quoi|quand|comment|pourquoi|où|est-ce|dois-je|what|when|where|why|how|should|could|can)\b/iu;
const deadlinePattern = /\b(?:aujourd'hui|demain|après-demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|avant le|d['’]ici|before|by|next week)\b|\b\d{1,2}[/:h]\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/iu;
const preferencePattern = /\b(?:je préfère|j['’]aime mieux|ma préférence|i prefer|i like it when|my preference)\b/iu;
const factPattern = /\b(?:je suis|j['’]habite|mon [\p{L}-]+ est|ma [\p{L}-]+ est|mes [\p{L}-]+ sont|i am|i live|my [a-z-]+ is)\b/iu;
function insightId(kind, quote, at) {
    return createHash("sha256").update(`${kind}\0${at}\0${quote.toLocaleLowerCase()}`).digest("hex").slice(0, 20);
}
function insight(kind, quote, entry) {
    return { id: insightId(kind, quote, entry.at), text: quote, sourceQuote: quote, at: entry.at };
}
function segments(entry) {
    const normalized = entry.text.replace(/\s+/g, " ").trim();
    if (!normalized)
        return [];
    return normalized.match(/[^.!?]+[.!?]?/gu)?.map((part) => part.trim()).filter(Boolean).slice(0, 24) ?? [normalized];
}
function pushUnique(target, value) {
    if (!target.some((item) => item.text.toLocaleLowerCase() === value.text.toLocaleLowerCase()))
        target.push(value);
}
export function pendingCallMemoryReview(now = Date.now()) {
    return {
        status: "pending",
        updatedAt: now,
        workingState: { ...EMPTY_WORKING_STATE },
        memoryCandidates: [],
        followUpCandidates: [],
    };
}
/** Deterministic V1 extraction. It deliberately prefers missing a candidate
 * over turning ambiguous speech into durable truth. */
export function extractCallMemory(entries, now = Date.now()) {
    const workingState = { decisions: [], commitments: [], openQuestions: [], deadlines: [] };
    const memoryCandidates = [];
    const followUpCandidates = [];
    for (const entry of entries.slice(-200)) {
        for (const quote of segments(entry)) {
            if (entry.role !== "user")
                continue;
            if (decisionPattern.test(quote))
                pushUnique(workingState.decisions, insight("decision", quote, entry));
            if (commitmentPattern.test(quote)) {
                const value = insight("commitment", quote, entry);
                pushUnique(workingState.commitments, value);
                pushUnique(followUpCandidates, { ...value, id: insightId("followup", quote, entry.at), status: "proposed" });
            }
            if (questionPattern.test(quote))
                pushUnique(workingState.openQuestions, insight("question", quote, entry));
            if (deadlinePattern.test(quote))
                pushUnique(workingState.deadlines, insight("deadline", quote, entry));
            if (ambiguityPattern.test(quote) || sensitivePattern.test(quote))
                continue;
            const kind = preferencePattern.test(quote) ? "preference" : factPattern.test(quote) ? "fact" : undefined;
            if (kind) {
                pushUnique(memoryCandidates, {
                    ...insight(`memory-${kind}`, quote, entry),
                    kind,
                    confidence: kind === "preference" ? 0.9 : 0.82,
                    status: "pending",
                });
            }
        }
    }
    return {
        status: "complete",
        updatedAt: now,
        workingState,
        memoryCandidates: memoryCandidates.slice(0, 20),
        followUpCandidates: followUpCandidates.slice(0, 20),
    };
}
export class CallMemoryService {
    transcripts;
    memory;
    now;
    constructor(transcripts, memory, now = Date.now) {
        this.transcripts = transcripts;
        this.memory = memory;
        this.now = now;
    }
    async process(sessionId) {
        const call = this.transcripts.get(sessionId);
        if (!call)
            return undefined;
        try {
            return this.transcripts.updateReview(sessionId, extractCallMemory(call.entries, this.now()));
        }
        catch (error) {
            return this.transcripts.updateReview(sessionId, {
                ...pendingCallMemoryReview(this.now()),
                status: "failed",
                error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            });
        }
    }
    async review(input) {
        const call = this.transcripts.get(input.sessionId);
        if (!call?.review)
            throw Object.assign(new Error("no extracted call memory"), { status: 404 });
        const candidate = call.review.memoryCandidates.find((item) => item.id === input.candidateId);
        if (!candidate)
            throw Object.assign(new Error("no such memory candidate"), { status: 404 });
        const allowed = candidate.status === "pending"
            ? ["keep", "correct", "ignore"]
            : candidate.status === "kept"
                ? ["correct", "forget"]
                : [];
        if (!allowed.includes(input.action)) {
            throw Object.assign(new Error(`cannot ${input.action} a ${candidate.status} memory candidate`), { status: 409 });
        }
        const content = input.text?.replace(/\s+/g, " ").trim().slice(0, 20_000) || candidate.text;
        const source = `Confirmed from OpenMausBot voice call ${call.sessionId} at ${new Date(candidate.at).toISOString()}`;
        if (input.action === "ignore") {
            candidate.status = "ignored";
        }
        else {
            if (input.action === "forget" && !candidate.memoryId) {
                throw Object.assign(new Error("candidate has not been saved to memory"), { status: 409 });
            }
            const previousStatus = candidate.status;
            candidate.status = "syncing";
            candidate.syncAction = input.action;
            candidate.syncError = undefined;
            call.review.updatedAt = this.now();
            this.transcripts.updateReview(input.sessionId, call.review);
            try {
                if (input.action === "forget") {
                    await this.memory.forget(candidate.memoryId);
                    candidate.status = "forgotten";
                }
                else if (input.action === "correct" && candidate.memoryId) {
                    const corrected = await this.memory.correct({ id: candidate.memoryId, content, reason: "User corrected the voice-call memory candidate" });
                    candidate.memoryId = corrected.id;
                    candidate.text = content;
                    candidate.status = "kept";
                }
                else {
                    const stored = await this.memory.write({ content, type: candidate.kind, source });
                    candidate.memoryId = stored.id;
                    candidate.text = content;
                    candidate.status = "kept";
                }
                candidate.syncAction = undefined;
            }
            catch (error) {
                candidate.status = previousStatus;
                candidate.syncAction = undefined;
                candidate.syncError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
                call.review.updatedAt = this.now();
                this.transcripts.updateReview(input.sessionId, call.review);
                throw error;
            }
        }
        call.review.updatedAt = this.now();
        return this.transcripts.updateReview(input.sessionId, call.review);
    }
}
