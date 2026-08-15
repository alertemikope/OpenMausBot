import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { DATA_DIR } from "../config.js";
import { ACTIVE_WORK_STATES, TERMINAL_WORK_STATES, } from "./contracts.js";
const DEFAULT_MAX_ITEMS = 2_000;
const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_PROGRESS_CHARS = 500;
const MAX_RESULT_CHARS = 8_000;
const activeStates = new Set(ACTIVE_WORK_STATES);
const terminalStates = new Set(TERMINAL_WORK_STATES);
function clone(item) {
    return { ...item, ...(item.denials ? { denials: [...item.denials] } : {}) };
}
function routineState(run) {
    switch (run.status) {
        case "queued":
            return "queued";
        case "running":
            return "running";
        case "waiting":
            return "waiting_input";
        case "completed":
            return "completed";
        case "cancelled":
            return "cancelled";
        case "failed":
        case "missed":
            return "failed";
    }
}
export class WorkRegistry {
    file;
    now;
    emit;
    maxItems;
    items = [];
    constructor(options = {}) {
        this.file = options.file ?? join(DATA_DIR, "work-items.json");
        this.now = options.now ?? Date.now;
        this.emit = options.emit;
        this.maxItems = Math.max(100, options.maxItems ?? DEFAULT_MAX_ITEMS);
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        try {
            const disk = JSON.parse(readFileSync(this.file, "utf8"));
            this.items = Array.isArray(disk.items) ? disk.items.filter((item) => this.validItem(item)) : [];
            chmodSync(this.file, 0o600);
        }
        catch {
            this.items = [];
        }
        let recovered = false;
        const at = this.now();
        for (const item of this.items) {
            if (!["running", "waiting_approval", "waiting_input"].includes(item.state))
                continue;
            item.state = "interrupted_by_restart";
            item.error = "OpenMausBot restarted while this work was running";
            item.progress = "Interrupted by application restart";
            item.finishedAt = at;
            item.updatedAt = at;
            item.requestId = undefined;
            item.requestSummary = undefined;
            recovered = true;
        }
        if (recovered)
            this.save();
    }
    create(input) {
        const id = input.id?.trim() || randomUUID();
        const existing = this.items.find((item) => item.id === id);
        if (existing)
            return clone(existing);
        const at = this.now();
        const objective = String(input.objective ?? "").trim().slice(0, MAX_OBJECTIVE_CHARS);
        if (!objective)
            throw new Error("Work objective is required");
        const targetBotId = String(input.targetBotId ?? "").trim();
        if (!targetBotId)
            throw new Error("Work target is required");
        const item = {
            id,
            origin: input.origin,
            targetBotId,
            objective,
            state: "queued",
            priority: Math.max(-100, Math.min(100, Math.round(input.priority ?? 0))),
            progress: "Queued",
            createdAt: at,
            updatedAt: at,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(input.parentId ? { parentId: input.parentId } : {}),
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            ...(input.voiceSessionId ? { voiceSessionId: input.voiceSessionId } : {}),
            ...(input.scheduledFor != null ? { scheduledFor: input.scheduledFor } : {}),
        };
        this.items.push(item);
        this.trim();
        this.persistAndEmit(item);
        return clone(item);
    }
    get(id) {
        const item = this.items.find((candidate) => candidate.id === id);
        return item ? clone(item) : undefined;
    }
    list(options = {}) {
        const limit = Math.max(1, Math.min(2_000, options.limit ?? 500));
        return this.items
            .filter((item) => !options.targetBotId || item.targetBotId === options.targetBotId)
            .filter((item) => options.active == null || activeStates.has(item.state) === options.active)
            .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
            .slice(0, limit)
            .map(clone);
    }
    queued(origin) {
        return this.items
            .filter((item) => item.state === "queued" && (!origin || item.origin === origin))
            .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt)
            .map(clone);
    }
    activeForTarget(targetBotId) {
        const item = this.items
            .filter((candidate) => candidate.targetBotId === targetBotId && activeStates.has(candidate.state))
            .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0) || right.createdAt - left.createdAt)[0];
        return item ? clone(item) : undefined;
    }
    runtimeStatus(options = {}) {
        const at = this.now();
        const active = this.items.filter((item) => activeStates.has(item.state));
        const staleAfterMs = Math.max(60_000, options.staleAfterMs ?? 30 * 60_000);
        const cancellationAfterMs = Math.max(10_000, options.cancellationAfterMs ?? 2 * 60_000);
        return {
            active: active.length,
            queued: active.filter((item) => item.state === "queued").length,
            waiting: active.filter((item) => item.state === "waiting_approval" || item.state === "waiting_input").length,
            // Waiting on the user is not a stuck provider. Only autonomous running
            // work with no fresh provider event is advisory-stale.
            stale: active.filter((item) => item.state === "running" && at - item.updatedAt > staleAfterMs).length,
            cancellationStuck: active.filter((item) => item.cancelRequestedAt != null && at - item.cancelRequestedAt > cancellationAfterMs).length,
        };
    }
    claim(id) {
        const item = this.mutable(id);
        if (!item || item.state !== "queued")
            return false;
        const at = this.now();
        Object.assign(item, { state: "running", progress: "Dispatching to agent", startedAt: at, updatedAt: at });
        this.persistAndEmit(item);
        return true;
    }
    bindThread(id, threadId) {
        const item = this.mutable(id);
        if (!item || terminalStates.has(item.state))
            return item ? clone(item) : undefined;
        item.threadId = threadId;
        item.updatedAt = this.now();
        this.persistAndEmit(item);
        return clone(item);
    }
    bindTurn(id, turnId, providerInstanceId) {
        const item = this.mutable(id);
        if (!item || terminalStates.has(item.state))
            return item ? clone(item) : undefined;
        if (item.turnId && item.turnId !== turnId)
            return clone(item);
        item.turnId = turnId;
        if (providerInstanceId)
            item.providerInstanceId = providerInstanceId;
        if (item.state === "queued")
            item.state = "running";
        item.startedAt ??= this.now();
        item.progress = "Agent is working";
        item.updatedAt = this.now();
        this.persistAndEmit(item);
        return clone(item);
    }
    failDispatch(id, message) {
        const item = this.mutable(id);
        if (!item || terminalStates.has(item.state))
            return item ? clone(item) : undefined;
        const at = this.now();
        Object.assign(item, {
            state: "failed",
            error: message.slice(0, MAX_PROGRESS_CHARS),
            progress: "Could not start the agent",
            finishedAt: at,
            updatedAt: at,
        });
        this.persistAndEmit(item);
        return clone(item);
    }
    requestCancel(id) {
        const item = this.mutable(id);
        if (!item || !activeStates.has(item.state))
            return item ? clone(item) : undefined;
        const at = this.now();
        item.cancelRequestedAt = at;
        item.progress = "Cancellation requested";
        item.updatedAt = at;
        this.persistAndEmit(item);
        return clone(item);
    }
    cancelRequestFailed(id, message) {
        const item = this.mutable(id);
        if (!item || terminalStates.has(item.state))
            return item ? clone(item) : undefined;
        item.cancelRequestedAt = undefined;
        item.error = message.slice(0, MAX_PROGRESS_CHARS);
        item.progress = "Cancellation failed; the agent may still be working";
        item.updatedAt = this.now();
        this.persistAndEmit(item);
        return clone(item);
    }
    cancelQueued(id, reason = "Cancelled before dispatch") {
        const item = this.mutable(id);
        if (!item || item.state !== "queued")
            return false;
        const at = this.now();
        Object.assign(item, {
            state: "cancelled",
            progress: "Cancelled",
            error: reason.slice(0, MAX_PROGRESS_CHARS),
            finishedAt: at,
            updatedAt: at,
        });
        this.persistAndEmit(item);
        return true;
    }
    markSeen(id) {
        const item = this.mutable(id);
        if (!item)
            return undefined;
        if (!item.seenAt) {
            item.seenAt = this.now();
            item.updatedAt = item.seenAt;
            this.persistAndEmit(item);
        }
        return clone(item);
    }
    handleRuntimeEvent(event) {
        const item = this.ownerForEvent(event);
        if (!item)
            return;
        const at = this.now();
        if (event.providerInstanceId)
            item.providerInstanceId = event.providerInstanceId;
        switch (event.type) {
            case "turn.started":
                if (event.turnId)
                    item.turnId = event.turnId;
                item.state = "running";
                item.startedAt ??= at;
                item.progress = "Agent is working";
                break;
            case "item.started":
                if (event.itemType !== "tool")
                    return;
                item.currentTool = event.title?.slice(0, 160) || "tool";
                item.progress = `Using ${item.currentTool}`;
                break;
            case "item.completed":
                if (event.itemType !== "assistant_text")
                    return;
                item.result = event.text.trim().slice(0, MAX_RESULT_CHARS);
                item.progress = "Preparing the final result";
                break;
            case "request.opened":
                item.state = event.requestType === "permission" ? "waiting_approval" : "waiting_input";
                item.requestId = event.requestId;
                item.requestSummary = event.summary.slice(0, MAX_PROGRESS_CHARS);
                item.progress = event.requestType === "permission" ? "Waiting for approval" : "Waiting for your answer";
                break;
            case "request.resolved":
                if (event.requestId && item.requestId && event.requestId !== item.requestId)
                    return;
                item.state = "running";
                item.requestId = undefined;
                item.requestSummary = undefined;
                item.progress = "Continuing after your decision";
                break;
            case "runtime.error":
                item.error = event.message.slice(0, MAX_PROGRESS_CHARS);
                item.progress = `Error: ${item.error}`.slice(0, MAX_PROGRESS_CHARS);
                break;
            case "turn.completed": {
                const cancelled = Boolean(item.cancelRequestedAt) || /cancel|interrupt/i.test(event.stopReason ?? "");
                item.state = event.ok ? "completed" : cancelled ? "cancelled" : "failed";
                item.progress = event.ok ? "Completed" : cancelled ? "Cancelled" : "Failed";
                item.error = event.ok ? undefined : (event.stopReason ?? item.error ?? "The agent did not complete this work").slice(0, MAX_PROGRESS_CHARS);
                item.cost = event.cost;
                item.denials = event.denials;
                item.finishedAt = at;
                item.requestId = undefined;
                item.requestSummary = undefined;
                break;
            }
            case "session.started":
            case "session.exited":
            case "item.updated":
            case "content.delta":
            case "thread.token-usage.updated":
                return;
        }
        item.updatedAt = at;
        this.persistAndEmit(item);
    }
    upsertRoutineRun(run) {
        let item = this.mutable(run.id);
        if (!item) {
            return this.create({
                id: run.id,
                origin: "routine",
                targetBotId: run.botId,
                objective: run.prompt?.trim() || run.routineName,
                sourceId: run.routineId,
                threadId: run.threadId,
                scheduledFor: run.scheduledFor,
            });
        }
        const at = this.now();
        const nextState = routineState(run);
        // Provider events are more specific while a run is waiting for approval;
        // do not flatten that state back to the routine's generic `waiting`.
        if (!(item.state === "waiting_approval" && nextState === "waiting_input"))
            item.state = nextState;
        item.threadId = run.threadId ?? item.threadId;
        item.startedAt = run.startedAt ?? item.startedAt;
        item.finishedAt = run.finishedAt ?? item.finishedAt;
        item.result = run.output?.slice(0, MAX_RESULT_CHARS) ?? item.result;
        item.error = run.error?.slice(0, MAX_PROGRESS_CHARS) ?? (nextState === "completed" ? undefined : item.error);
        item.cost = run.cost ?? item.cost;
        item.denials = run.denials ?? item.denials;
        item.progress = nextState === "queued"
            ? "Waiting for the scheduled agent"
            : nextState === "running"
                ? "Routine agent is working"
                : nextState === "waiting_input"
                    ? "Routine needs your input"
                    : nextState === "completed"
                        ? "Completed"
                        : nextState === "cancelled"
                            ? "Cancelled"
                            : "Failed";
        item.updatedAt = at;
        this.persistAndEmit(item);
        return clone(item);
    }
    ownerForEvent(event) {
        if (event.turnId) {
            const exact = this.items.find((item) => activeStates.has(item.state) && item.turnId === event.turnId && item.threadId === event.threadId);
            if (exact)
                return exact;
            // Only a turn.started event may bind an unowned turn. This fences a
            // late turn.completed from an older generation on the same thread.
            if (event.type !== "turn.started")
                return undefined;
        }
        return this.items
            .filter((item) => activeStates.has(item.state) && item.threadId === event.threadId && !item.turnId)
            .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0) || right.createdAt - left.createdAt)[0];
    }
    mutable(id) {
        return this.items.find((item) => item.id === id);
    }
    validItem(value) {
        if (!value || typeof value !== "object")
            return false;
        const item = value;
        const validShape = typeof item.id === "string"
            && typeof item.targetBotId === "string"
            && typeof item.objective === "string"
            && typeof item.createdAt === "number"
            && typeof item.updatedAt === "number";
        return validShape && (activeStates.has(item.state) || terminalStates.has(item.state));
    }
    trim() {
        if (this.items.length <= this.maxItems)
            return;
        const terminal = this.items
            .filter((item) => terminalStates.has(item.state))
            .sort((left, right) => left.updatedAt - right.updatedAt);
        const remove = new Set(terminal.slice(0, this.items.length - this.maxItems).map((item) => item.id));
        this.items = this.items.filter((item) => !remove.has(item.id));
    }
    persistAndEmit(item) {
        this.save();
        this.emit?.({ kind: "work.item", item: clone(item) });
    }
    save() {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        writeFileAtomic(this.file, JSON.stringify({ version: 1, items: this.items }, null, 2), 0o600);
    }
}
