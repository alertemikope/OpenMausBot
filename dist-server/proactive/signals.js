function clipped(value, fallback) {
    const text = String(value || fallback).replace(/\s+/g, " ").trim();
    return text.length > 280 ? `${text.slice(0, 277).trimEnd()}…` : text;
}
export function signalFromWork(item, botName = "Agent") {
    const routine = item.origin === "routine";
    const base = {
        source: routine ? "routine" : "work",
        entityId: item.id,
        version: item.state,
        occurredAt: item.updatedAt,
        targetBotId: item.targetBotId,
        workItemId: item.id,
        voiceEligible: item.origin !== "voice",
    };
    if (item.state === "waiting_approval" || item.state === "waiting_input") {
        return {
            ...base,
            kind: item.state === "waiting_approval" ? "approval.required" : "input.required",
            title: `${botName} needs you`,
            body: clipped(item.requestSummary, item.objective),
            severity: "warning",
        };
    }
    if (item.state === "completed") {
        return {
            ...base,
            kind: routine ? "routine.completed" : "work.completed",
            title: `${botName} completed ${routine ? "a routine" : "a task"}`,
            body: clipped(item.result, item.objective),
            severity: "info",
        };
    }
    if (item.state === "failed" || item.state === "interrupted_by_restart") {
        return {
            ...base,
            kind: routine ? "routine.failed" : "work.failed",
            title: `${botName} ${item.state === "interrupted_by_restart" ? "was interrupted" : "failed"}`,
            body: clipped(item.error, item.objective),
            severity: item.state === "interrupted_by_restart" ? "warning" : "critical",
        };
    }
    return undefined;
}
